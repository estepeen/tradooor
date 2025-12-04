import 'dotenv/config';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { NormalizedTradeRepository } from '../repositories/normalized-trade.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TradeValuationService } from '../services/trade-valuation.service.js';

async function processRecord(
  record: Awaited<ReturnType<NormalizedTradeRepository['findPending']>>[number],
  tradeRepo: TradeRepository,
  walletQueueRepo: WalletProcessingQueueRepository,
  normalizedRepo: NormalizedTradeRepository,
  valuationService: TradeValuationService
) {
  try {
    const valuation = await valuationService.valuate({
      baseToken: record.baseToken,
      amountBaseRaw: record.amountBaseRaw,
      priceBasePerTokenRaw: record.priceBasePerTokenRaw,
      timestamp: record.timestamp,
      secondaryTokenMint: record.meta?.secondaryTokenMint || record.meta?.baseMint || null,
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

    await normalizedRepo.markProcessed(record.id, {
      tradeId: trade.id,
      amountBaseUsd: valuation.amountBaseUsd,
      priceUsdPerToken: valuation.priceUsdPerToken,
      valuationSource: valuation.source,
      valuationTimestamp: valuation.timestamp,
    });

    try {
      await walletQueueRepo.enqueue(record.walletId);
    } catch (enqueueError: any) {
      console.warn(`⚠️  Failed to enqueue wallet ${record.walletId}: ${enqueueError?.message}`);
    }

    console.log(`   ✅ Re-processed normalized trade ${record.id}`);
  } catch (error: any) {
    console.error(`   ❌ Failed to process normalized trade ${record.id}: ${error?.message}`);
    await normalizedRepo.markFailed(record.id, error?.message || 'Unknown error');
  }
}

const STABLE_BASES = new Set(['SOL', 'WSOL', 'USDC', 'USDT']);

const walletAddress = process.argv[2];

if (!walletAddress) {
  console.error('Usage: pnpm --filter backend fix:wallet-revalue <walletAddress>');
  process.exit(1);
}

async function main() {
  const walletRepo = new SmartWalletRepository();
  const walletQueueRepo = new WalletProcessingQueueRepository();
  const normalizedRepo = new NormalizedTradeRepository();
  const tradeRepo = new TradeRepository();
  const valuationService = new TradeValuationService();

  const wallet = await walletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`🔄 Re-valuating trades for wallet ${wallet.address} (${wallet.id})`);

  const { data: trades, error } = await supabase
    .from(TABLES.TRADE)
    .select('id, meta')
    .eq('walletId', wallet.id)
    .eq('meta->>valuationSource', 'binance');

  if (error) {
    throw new Error(`Failed to fetch trades: ${error.message}`);
  }

  const impactedTrades = (trades || []).filter((trade: any) => {
    const baseToken = (trade.meta?.baseToken || '').toUpperCase();
    return baseToken && !STABLE_BASES.has(baseToken);
  });

  console.log(`   📊 Found ${impactedTrades.length} trades with non-stable binance valuations`);

  let resetCount = 0;
  let skippedNoNormalized = 0;

  for (const trade of impactedTrades) {
    const normalizedId = trade.meta?.normalizedTradeId;
    if (!normalizedId) {
      skippedNoNormalized++;
      console.warn(`   ⚠️  Trade ${trade.id} missing normalizedTradeId, skipping`);
      continue;
    }

    await supabase.from(TABLES.TRADE).delete().eq('id', trade.id);

    const { error: normalizedError } = await supabase
      .from(TABLES.NORMALIZED_TRADE)
      .update({
        status: 'pending',
        tradeId: null,
        amountBaseUsd: null,
        priceUsdPerToken: null,
        valuationSource: null,
        valuationTimestamp: null,
        processedAt: null,
        error: null,
        updatedAt: new Date().toISOString(),
      })
      .eq('id', normalizedId);

    if (normalizedError) {
      throw new Error(`Failed to reset normalized trade ${normalizedId}: ${normalizedError.message}`);
    }

    const normalizedRecord = await normalizedRepo.findById(normalizedId);
    if (normalizedRecord) {
      await processRecord(normalizedRecord, tradeRepo, walletQueueRepo, normalizedRepo, valuationService);
    }

    resetCount++;
    console.log(`   🔁 Re-queued trade ${trade.id} (normalized ${normalizedId})`);
  }

  console.log(`✅ Done. Re-queued ${resetCount} trades, skipped ${skippedNoNormalized}.`);
  console.log('   Run the closed-lot processor to rebuild metrics for this wallet.');
}

main().catch((error) => {
  console.error('❌ Script failed:', error.message);
  process.exit(1);
});

