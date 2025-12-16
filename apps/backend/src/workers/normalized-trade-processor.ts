import 'dotenv/config';
import { NormalizedTradeRepository } from '../repositories/normalized-trade.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { TradeValuationService } from '../services/trade-valuation.service.js';
import { ConsensusWebhookService } from '../services/consensus-webhook.service.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';

const normalizedTradeRepo = new NormalizedTradeRepository();
const tradeRepo = new TradeRepository();
const walletQueueRepo = new WalletProcessingQueueRepository();
const valuationService = new TradeValuationService();
const consensusService = new ConsensusWebhookService();
const lotMatchingService = new LotMatchingService();
const smartWalletRepo = new SmartWalletRepository();
const metricsHistoryRepo = new MetricsHistoryRepository();
const metricsCalculator = new MetricsCalculatorService(smartWalletRepo, tradeRepo, metricsHistoryRepo);

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

    const trade = await tradeRepo.create({
      txSignature: record.txSignature,
      walletId: record.walletId,
      tokenId: record.tokenId,
      side: record.side,
      amountToken: record.amountToken,
      amountBase: valuation.amountBaseUsd,
      priceBasePerToken: valuation.priceUsdPerToken,
      timestamp: record.timestamp,
      dex: record.dex,
      valueUsd: valuation.amountBaseUsd,
      meta: {
        ...record.meta,
        normalizedTradeId: record.id,
        amountBaseRaw: record.amountBaseRaw,
        priceBasePerTokenRaw: record.priceBasePerTokenRaw,
        valuationSource: valuation.source,
      },
    });

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
    
    if (now - lastRecalc >= CLOSED_LOT_DEBOUNCE_MS) {
      walletClosedLotDebounce.set(record.walletId, now);
      
      setTimeout(async () => {
        try {
          const walletData = await smartWalletRepo.findById(record.walletId);
          if (walletData) {
            const trackingStartTime = walletData.createdAt ? new Date(walletData.createdAt) : undefined;
            const closedLots = await lotMatchingService.processTradesForWallet(
              record.walletId,
              undefined, // Process all tokens
              trackingStartTime
            );
            await lotMatchingService.saveClosedLots(closedLots);
            if (closedLots.length > 0) {
              console.log(`   ✅ [ClosedLots] Updated ${closedLots.length} closed lots for wallet ${record.walletId.substring(0, 8)}...`);
            }
          }
        } catch (closedLotsError: any) {
          console.warn(`⚠️  Failed to recalculate closed lots for wallet ${record.walletId}: ${closedLotsError?.message || closedLotsError}`);
        }
      }, 0);
    } else {
      console.log(`   ⏭️  [ClosedLots] Skipping recalculation for wallet ${record.walletId.substring(0, 8)}... (debounced, last recalc ${Math.round((now - lastRecalc) / 1000)}s ago)`);
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
      setImmediate(async () => {
        try {
          await consensusService.checkConsensusAfterBuy(
            trade.id,
            trade.tokenId,
            trade.walletId,
            trade.timestamp
          );
        } catch (consensusError: any) {
          console.warn(`⚠️  Error checking consensus for trade ${trade.id}:`, consensusError.message);
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
  process.exit(1);
});

