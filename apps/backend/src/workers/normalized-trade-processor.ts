import 'dotenv/config';
import { NormalizedTradeRepository } from '../repositories/normalized-trade.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { TradeValuationService } from '../services/trade-valuation.service.js';

const normalizedTradeRepo = new NormalizedTradeRepository();
const tradeRepo = new TradeRepository();
const walletQueueRepo = new WalletProcessingQueueRepository();
const valuationService = new TradeValuationService();

const IDLE_DELAY_MS = Number(process.env.NORMALIZED_TRADE_WORKER_IDLE_MS || 1500);
const BATCH_SIZE = Number(process.env.NORMALIZED_TRADE_WORKER_BATCH || 20);

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
        valueUsd: null, // Void trade nemá hodnotu
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

      for (const record of pending) {
        await processNormalizedTrade(record);
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

