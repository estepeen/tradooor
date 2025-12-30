import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from apps/backend directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, '../../.env') });
import { NormalizedTradeRepository } from '../repositories/normalized-trade.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { TradeValuationService } from '../services/trade-valuation.service.js';
import { ConsensusWebhookService } from '../services/consensus-webhook.service.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { AdvancedSignalsService } from '../services/advanced-signals.service.js';
import { PositionMonitorService } from '../services/position-monitor.service.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { TokenMarketDataService } from '../services/token-market-data.service.js';
import { TradeFeatureRepository } from '../repositories/trade-feature.repository.js';
import { WalletCorrelationService } from '../services/wallet-correlation.service.js';

// Log environment variables status
console.log(`🔍 [NormalizedTradeWorker] Environment check:`);
console.log(`   GROQ_API_KEY: ${process.env.GROQ_API_KEY ? `${process.env.GROQ_API_KEY.substring(0, 10)}...` : 'NOT SET'}`);
console.log(`   ENABLE_AI_DECISIONS: ${process.env.ENABLE_AI_DECISIONS || 'NOT SET'}`);
console.log(`   ENABLE_ADVANCED_SIGNALS: ${process.env.ENABLE_ADVANCED_SIGNALS !== 'false' ? 'true' : 'false'}`);

const normalizedTradeRepo = new NormalizedTradeRepository();
const tradeRepo = new TradeRepository();
const tokenRepo = new TokenRepository();
const tradeFeatureRepo = new TradeFeatureRepository();
const walletQueueRepo = new WalletProcessingQueueRepository();
const valuationService = new TradeValuationService();
const consensusService = new ConsensusWebhookService();
const lotMatchingService = new LotMatchingService();
const smartWalletRepo = new SmartWalletRepository();
const metricsHistoryRepo = new MetricsHistoryRepository();
const metricsCalculator = new MetricsCalculatorService(smartWalletRepo, tradeRepo, metricsHistoryRepo);
const advancedSignals = new AdvancedSignalsService();
const positionMonitor = new PositionMonitorService();
const walletCorrelation = new WalletCorrelationService();
// Sdílená instance TokenMarketDataService pro cache mezi všemi trades
const tokenMarketDataService = new TokenMarketDataService();

// Enable/disable advanced signals processing
const ENABLE_ADVANCED_SIGNALS = process.env.ENABLE_ADVANCED_SIGNALS !== 'false';

// Track wallets that need metrics recalculation (debounce)
const walletMetricsDebounce = new Map<string, NodeJS.Timeout>(); // walletId -> timeout
const METRICS_DEBOUNCE_MS = 10000; // 10 seconds debounce for metrics calculation

const IDLE_DELAY_MS = Number(process.env.NORMALIZED_TRADE_WORKER_IDLE_MS || 3000); // Increased from 1500ms to 3000ms
const BATCH_SIZE = Number(process.env.NORMALIZED_TRADE_WORKER_BATCH || 10); // Reduced from 20 to 10 for lower CPU usage
const DELAY_BETWEEN_TRADES_MS = 200; // Add delay between processing trades

// Debounce map for closed lot recalculation - prevents recalculating same wallet multiple times in short period
const walletClosedLotDebounce = new Map<string, number>(); // walletId -> last recalculation timestamp
const CLOSED_LOT_DEBOUNCE_MS = 5000; // 5 seconds debounce (short enough to not delay updates, long enough to batch rapid trades)

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processNormalizedTrade(record: Awaited<ReturnType<typeof normalizedTradeRepo.findPending>>[number]) {
  try {
    // Void trades (token-to-token swapy) - přeskočit valuation, uložit s hodnotou 0
    if (record.side === 'void') {
      const trade = await tradeRepo.create({
        txSignature: record.txSignature,
        walletId: record.walletId,
        tokenId: record.tokenId,
        side: 'void',
        amountToken: record.amountToken,
        amountBase: 0,
        priceBasePerToken: 0,
        timestamp: record.timestamp,
        dex: record.dex,
        valueUsd: undefined, // Void trade nemá hodnotu
        meta: {
          ...record.meta,
          normalizedTradeId: record.id,
          amountBaseRaw: record.amountBaseRaw,
          priceBasePerTokenRaw: record.priceBasePerTokenRaw,
          isVoid: true,
        },
      });

      await normalizedTradeRepo.markProcessed(record.id, {
        tradeId: trade.id,
        amountBaseUsd: 0,
        priceUsdPerToken: 0,
        valuationSource: 'void',
        valuationTimestamp: record.timestamp,
      });

      console.log(`🟣 [NormalizedTradeWorker] Processed VOID trade ${record.id} -> trade ${trade.id} (token-to-token swap)`);
      return;
    }

    // Normální trade - provést valuation
    const valuation = await valuationService.valuate({
      baseToken: record.baseToken,
      amountBaseRaw: record.amountBaseRaw,
      amountToken: record.amountToken,
      priceBasePerTokenRaw: record.priceBasePerTokenRaw,
      timestamp: record.timestamp,
      secondaryTokenMint: null, // Už nepoužíváme token-to-token swapy
    });

    // Načti aktuální market cap v době trade (pro zobrazení v signálech)
    // POZNÁMKA: Načítáme aktuální data v době trade, ne historická data
    // Ukládáme market cap pro BUY i SELL trades (ne pro VOID)
    // Používáme sdílenou instanci tokenMarketDataService pro cache mezi všemi trades
    let marketCapAtTradeTime: number | null = null;
    if (record.side === 'buy' || record.side === 'sell') {
      try {
        const token = await tokenRepo.findById(record.tokenId);
        if (token?.mintAddress) {
          // Použij sdílenou instanci (cache je sdílená mezi všemi trades)
          const marketData = await tokenMarketDataService.getMarketData(token.mintAddress);
          if (marketData?.marketCap) {
            marketCapAtTradeTime = marketData.marketCap;
          }
        }
      } catch (error: any) {
        // Pokud se nepodaří načíst market cap, pokračujeme bez něj (není kritické)
        // Nechceme spamovat logy, takže jen při výrazných chybách
      }
    }

    // #region agent log - Debug amountBase storage
    fetch('http://127.0.0.1:7242/ingest/d9d466c4-864c-48e8-9710-84e03ea195a8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'normalized-trade-processor.ts:91',message:'BEFORE TRADE CREATE',data:{baseToken:record.baseToken,amountBaseRaw:record.amountBaseRaw,valuationAmountBaseUsd:valuation.amountBaseUsd,valuationSource:valuation.source},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion

    // DŮLEŽITÉ: amountBase musí být vždy v base měně (SOL/USDC/USDT) z TX, NIKDY v USD!
    // valuation.amountBaseUsd je USD hodnota pro valueUsd, ale amountBase musí být v base měně
    // Použij record.amountBaseRaw (původní hodnota z TX v base měně), ne valuation.amountBaseUsd
    const tradeMeta = {
      ...record.meta,
      normalizedTradeId: record.id,
      amountBaseRaw: record.amountBaseRaw,
      priceBasePerTokenRaw: record.priceBasePerTokenRaw,
      valuationSource: valuation.source,
      // Ulož market cap v době trade pro historické zobrazení v signálech
      marketCapUsd: marketCapAtTradeTime,
      fdvUsd: marketCapAtTradeTime, // Alias pro kompatibilitu
      marketCap: marketCapAtTradeTime, // Další alias
    };
    
    // Debug: log co ukládáme do meta
    if (marketCapAtTradeTime) {
      console.log(`[MARKETCAP] Storing market cap ${marketCapAtTradeTime} in Trade.meta for trade ${record.id}`);
    } else {
      console.warn(`[MARKETCAP] WARNING: No market cap to store for trade ${record.id} - will show "- MCap" in signals`);
    }
    
    const trade = await tradeRepo.create({
      txSignature: record.txSignature,
      walletId: record.walletId,
      tokenId: record.tokenId,
      side: record.side,
      amountToken: record.amountToken,
      amountBase: record.amountBaseRaw, // V base měně (SOL/USDC/USDT) z TX, ne v USD!
      priceBasePerToken: record.priceBasePerTokenRaw, // V base měně, ne v USD!
      timestamp: record.timestamp,
      dex: record.dex,
      valueUsd: valuation.amountBaseUsd, // USD hodnota pro zobrazení
      meta: tradeMeta,
    });
    
    // Ulož market cap také do TradeFeature.fdvUsd (pokud TradeFeature existuje nebo se vytvoří)
    if (marketCapAtTradeTime !== null && (record.side === 'buy' || record.side === 'sell')) {
      try {
        // Zkus aktualizovat nebo vytvořit TradeFeature s fdvUsd
        await tradeFeatureRepo.upsertBaseFeature({
          tradeId: trade.id,
          walletId: record.walletId,
          tokenId: record.tokenId,
          fdvUsd: marketCapAtTradeTime, // Ulož market cap do TradeFeature.fdvUsd
        });
      } catch (error: any) {
        // Pokud se nepodaří uložit do TradeFeature, není to kritické (máme to v Trade.meta)
        // TradeFeature se možná vytváří jinde nebo ještě neexistuje
      }
    }
    
    // Debug: ověř, že se market cap skutečně uložil
    if (trade.meta && typeof trade.meta === 'object') {
      const savedMeta = trade.meta as any;
      if (savedMeta.marketCapUsd || savedMeta.fdvUsd || savedMeta.marketCap) {
        console.log(`[MARKETCAP] Verified: Market cap stored in Trade.meta for trade ${trade.id}:`, {
          marketCapUsd: savedMeta.marketCapUsd,
          fdvUsd: savedMeta.fdvUsd,
          marketCap: savedMeta.marketCap
        });
      } else {
        console.error(`[MARKETCAP] ERROR: Market cap NOT stored in Trade.meta for trade ${trade.id}! Meta:`, JSON.stringify(savedMeta));
      }
    }

    // #region agent log - Debug amountBase storage
    fetch('http://127.0.0.1:7242/ingest/d9d466c4-864c-48e8-9710-84e03ea195a8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'normalized-trade-processor.ts:110',message:'AFTER TRADE CREATE',data:{tradeId:trade.id,amountBase:trade.amountBase,priceBasePerToken:trade.priceBasePerToken,valueUsd:trade.valueUsd,baseToken:record.baseToken},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion

    await normalizedTradeRepo.markProcessed(record.id, {
      tradeId: trade.id,
      amountBaseUsd: valuation.amountBaseUsd,
      priceUsdPerToken: valuation.priceUsdPerToken,
      valuationSource: valuation.source,
      valuationTimestamp: valuation.timestamp,
    });

    // DŮLEŽITÉ: Přepočítej closed positions s debounce
    // Debounce zabraňuje přepočítávání stejné walletky vícekrát během krátké doby
    // Toto výrazně snižuje CPU zatížení při vysokém objemu trades
    const lastRecalc = walletClosedLotDebounce.get(record.walletId) || 0;
    const now = Date.now();
    
    // Get wallet address for better logging
    let walletAddress = record.walletId.substring(0, 8);
    try {
      const walletInfo = await smartWalletRepo.findById(record.walletId);
      if (walletInfo) {
        walletAddress = walletInfo.address.substring(0, 8);
      }
    } catch {
      // Ignore if wallet lookup fails
    }
    
    if (now - lastRecalc >= CLOSED_LOT_DEBOUNCE_MS) {
      walletClosedLotDebounce.set(record.walletId, now);
      console.log(`   🔄 [ClosedLots] Starting recalculation for wallet ${walletAddress}... (ID: ${record.walletId.substring(0, 8)}...)`);
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/d9d466c4-864c-48e8-9710-84e03ea195a8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'normalized-trade-processor.ts:138',message:'RECALC TRIGGERED',data:{walletId:record.walletId,source:'normalized-trade-processor',now:new Date().toISOString()},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3'})}).catch(()=>{});
      // #endregion
      
    setTimeout(async () => {
      try {
        const walletData = await smartWalletRepo.findById(record.walletId);
        if (walletData) {
          const trackingStartTime = walletData.createdAt ? new Date(walletData.createdAt) : undefined;
          console.log(`   📊 [ClosedLots] Processing trades for wallet ${walletData.address.substring(0, 8)}... (${walletData.address})`);
          const closedLots = await lotMatchingService.processTradesForWallet(
            record.walletId,
            undefined, // Process all tokens
            trackingStartTime
          );
          
          console.log(`   📦 [ClosedLots] Calculated ${closedLots.length} closed lots for wallet ${walletData.address.substring(0, 8)}...`);
          
          if (closedLots.length > 0) {
            try {
              // This is a new lot from webhook, not a recalculation - update PnL incrementally
              await lotMatchingService.saveClosedLots(closedLots, false);
              console.log(`   ✅ [ClosedLots] Successfully saved ${closedLots.length} closed lots for wallet ${walletData.address.substring(0, 8)}... (${walletData.address})`);
            } catch (saveError: any) {
              // CRITICAL: If save fails, log error but don't fail silently
              // This is important because closed lots are needed for metrics and portfolio
              console.error(`❌ [ClosedLots] CRITICAL: Failed to save ${closedLots.length} closed lots for wallet ${walletData.address.substring(0, 8)}... (${walletData.address})`);
              console.error(`   Error: ${saveError?.message || saveError}`);
              console.error(`   Error code: ${saveError?.code || 'N/A'}`);
              console.error(`   This wallet may need manual recalculation: pnpm --filter backend recalculate:wallet-closed-positions ${walletData.address}`);
              
              // Try to enqueue wallet for retry (if queue exists)
              try {
                await walletQueueRepo.enqueue(record.walletId, 'closed-lots-recalc-failed');
                console.log(`   🔄 Enqueued wallet ${walletData.address.substring(0, 8)}... for retry`);
              } catch (queueError) {
                // Queue might not be available, ignore
              }
            }
          } else {
            // No closed lots - this is normal if there are only BUY trades or no matching pairs
            console.log(`   ℹ️  [ClosedLots] No closed lots to save for wallet ${walletData.address.substring(0, 8)}... (${walletData.address}) - may have only BUY trades or no matching pairs`);
          }
        } else {
          console.warn(`   ⚠️  [ClosedLots] Wallet ${record.walletId.substring(0, 8)}... not found in database`);
        }
      } catch (closedLotsError: any) {
        console.error(`❌ [ClosedLots] Failed to recalculate closed lots for wallet ${walletAddress}... (ID: ${record.walletId.substring(0, 8)}...): ${closedLotsError?.message || closedLotsError}`);
        console.error(`   Error stack: ${closedLotsError?.stack || 'N/A'}`);
      }
    }, 0);
    } else {
      console.log(`   ⏭️  [ClosedLots] Skipping recalculation for wallet ${walletAddress}... (debounced, last recalc ${Math.round((now - lastRecalc) / 1000)}s ago)`);
    }

    // SELL trades: Calculate metrics immediately (with debounce) for instant UI update
    // This ensures closed positions and PnL are updated without waiting for the queue worker
    if (trade.side === 'sell') {
      // Clear any existing debounce timer for this wallet
      const existingTimeout = walletMetricsDebounce.get(record.walletId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }
      
      // Set new debounce timer - calculate metrics after METRICS_DEBOUNCE_MS
      const timeout = setTimeout(async () => {
        walletMetricsDebounce.delete(record.walletId);
        try {
          console.log(`📊 [Metrics] Calculating metrics for wallet ${record.walletId.substring(0, 8)}... (triggered by SELL trade)`);
          await metricsCalculator.calculateMetricsForWallet(record.walletId);
          console.log(`✅ [Metrics] Metrics updated for wallet ${record.walletId.substring(0, 8)}...`);
        } catch (metricsError: any) {
          console.warn(`⚠️  Failed to calculate metrics for wallet ${record.walletId}: ${metricsError?.message || metricsError}`);
        }
      }, METRICS_DEBOUNCE_MS);
      
      walletMetricsDebounce.set(record.walletId, timeout);
      
      // Detect if this sell is from a tracked position (exit signal)
      setImmediate(async () => {
        try {
          const exitPriceUsd = Number(trade.priceBasePerToken || 0);
          const exitAmountUsd = Number(trade.amountBase || 0) * exitPriceUsd;
          const exitSignal = await positionMonitor.recordWalletExit(
            trade.id,
            record.walletId,
            record.tokenId,
            exitPriceUsd,
            exitAmountUsd
          );
          if (exitSignal) {
            console.log(`🚨 [ExitSignal] ${exitSignal.type} detected for position - ${exitSignal.recommendation}`);
          }
        } catch (exitError: any) {
          // Non-critical - just log
          console.warn(`⚠️  Exit detection failed: ${exitError.message}`);
        }
      });
    }
    
    // Also enqueue for queue worker as backup (in case immediate calculation fails)
    try {
      await walletQueueRepo.enqueue(record.walletId);
    } catch (enqueueError: any) {
      console.warn(`⚠️  Failed to enqueue wallet ${record.walletId} after trade ingestion: ${enqueueError?.message || enqueueError}`);
    }

    const sourceEmoji = valuation.source === 'binance' ? '📊' : 
                        valuation.source === 'birdeye' ? '🐦' :
                        valuation.source === 'jupiter' ? '🪐' :
                        valuation.source === 'coingecko' ? '🦎' :
                        valuation.source === 'dexscreener' ? '📈' :
                        valuation.source === 'stable' ? '💵' : '❓';
    
    console.log(`${sourceEmoji} [NormalizedTradeWorker] Processed ${record.id} -> trade ${trade.id} (source: ${valuation.source})`);

    // DŮLEŽITÉ: Po vytvoření BUY trade zkontroluj consensus (2+ wallets, stejný token, 2h okno)
    // Paper trade se vytvoří při ceně druhého nákupu
    if (trade.side === 'buy') {
      // Update wallet correlations for cluster detection (incremental)
      setImmediate(async () => {
        try {
          const updatedPairs = await walletCorrelation.updateCorrelationsForTrade(trade.id);
          if (updatedPairs > 0) {
            console.log(`💎 [Correlation] Updated ${updatedPairs} wallet correlations for trade ${trade.id.substring(0, 8)}...`);
          }
        } catch (correlationError: any) {
          console.warn(`⚠️  Error updating correlations for trade ${trade.id}:`, correlationError.message);
        }
      });

      setImmediate(async () => {
        try {
          console.log(`🔍 [NormalizedTradeWorker] Checking consensus for trade ${trade.id.substring(0, 16)}... (token: ${trade.tokenId.substring(0, 16)}..., wallet: ${trade.walletId.substring(0, 16)}...)`);
          const consensusResult = await consensusService.checkConsensusAfterBuy(
            trade.id,
            trade.tokenId,
            trade.walletId,
            trade.timestamp
          );
          if (consensusResult.consensusFound) {
            console.log(`✅ [NormalizedTradeWorker] Consensus found! Signal created: ${consensusResult.signalCreated?.id?.substring(0, 16) || 'unknown'}...`);
          }
        } catch (consensusError: any) {
          console.warn(`⚠️  Error checking consensus for trade ${trade.id}:`, consensusError.message);
        }
      });
    }

    // Rozšířené signály: Analyzuj trade a ulož všechny detekované signály
    // Zahrnuje: whale-entry, early-sniper, momentum, re-entry, hot-token, accumulation
    if (ENABLE_ADVANCED_SIGNALS) {
      setImmediate(async () => {
        try {
          console.log(`🔍 [NormalizedTradeWorker] Processing advanced signals for trade ${trade.id.substring(0, 16)}...`);
          const { signals, savedCount } = await advancedSignals.processTradeForSignals(trade.id);
          if (signals.length > 0) {
            console.log(`🎯 [AdvancedSignals] Detected ${signals.length} signals for trade ${trade.id.substring(0, 8)}... (saved: ${savedCount})`);
          }
          if (savedCount > 0) {
            console.log(`✅ [NormalizedTradeWorker] Advanced signals created: ${savedCount} signals`);
          }
          if (signals.length > 0) {
            for (const signal of signals) {
              console.log(`   📊 ${signal.type} (${signal.strength}): ${signal.reasoning.substring(0, 80)}...`);
            }
          }
        } catch (signalError: any) {
          console.warn(`⚠️  Error processing advanced signals for trade ${trade.id}:`, signalError.message);
        }
      });
    }

    // Pro SELL trades uzavři odpovídající paper trade
    if (trade.side === 'sell') {
      setImmediate(async () => {
        try {
          await consensusService.processSellTrade(trade.id);
        } catch (sellError: any) {
          console.warn(`⚠️  Error processing SELL trade ${trade.id}:`, sellError.message);
        }
      });
    }
  } catch (error: any) {
    const message = error?.message || 'Unknown error';
    console.error(`❌ [NormalizedTradeWorker] Failed to process ${record.id}: ${message}`);
    
    // DŮLEŽITÉ: Pokud valuation selže, trade zůstane jako "pending" a worker ho zkusí znovu později
    // To umožní retry, pokud API dočasně selže (rate limit, network error, atd.)
    await normalizedTradeRepo.markFailed(record.id, message);
    
    // Log pro monitoring - kolik trades selže
    console.error(`   📊 [Metrics] Valuation failure for trade ${record.id}, will retry later`);
  }
}

async function runWorker() {
  console.log('🚀 Normalized trade ingestion worker started');

  while (true) {
    try {
      const pending = await normalizedTradeRepo.findPending(BATCH_SIZE);

      if (pending.length === 0) {
        await sleep(IDLE_DELAY_MS);
        continue;
      }

      for (let i = 0; i < pending.length; i++) {
        await processNormalizedTrade(pending[i]);
        
        // Add delay between trades to reduce CPU spikes (except for last trade)
        if (i < pending.length - 1 && DELAY_BETWEEN_TRADES_MS > 0) {
          await sleep(DELAY_BETWEEN_TRADES_MS);
        }
      }
    } catch (loopError: any) {
      console.error('❌ [NormalizedTradeWorker] Loop error:', loopError?.message || loopError);
      await sleep(IDLE_DELAY_MS);
    }
  }
}

runWorker().catch(error => {
  console.error('❌ [NormalizedTradeWorker] Fatal error:', error);
  console.error('Stack trace:', error.stack);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ [NormalizedTradeWorker] Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ [NormalizedTradeWorker] Uncaught Exception:', error);
  console.error('Stack trace:', error.stack);
  process.exit(1);
});

