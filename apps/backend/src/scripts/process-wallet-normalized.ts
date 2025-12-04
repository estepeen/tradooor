import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { NormalizedTradeRepository } from '../repositories/normalized-trade.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { TradeValuationService } from '../services/trade-valuation.service.js';

const walletAddress = process.argv[2];

if (!walletAddress) {
  console.error('Usage: pnpm --filter backend process:wallet-normalized <walletAddress>');
  process.exit(1);
}

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

async function main() {
  const walletRepo = new SmartWalletRepository();
  const normalizedRepo = new NormalizedTradeRepository();
  const tradeRepo = new TradeRepository();
  const walletQueueRepo = new WalletProcessingQueueRepository();
  const valuationService = new TradeValuationService();

  const wallet = await walletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`🔁 Processing pending normalized trades for wallet ${wallet.address} (${wallet.id})`);

  const pending = await normalizedRepo.findPendingByWallet(wallet.id);
  console.log(`   📦 Pending normalized trades: ${pending.length}`);

  for (const record of pending) {
    await processRecord(record, tradeRepo, walletQueueRepo, normalizedRepo, valuationService);
  }

  console.log('✅ Done processing pending normalized trades.');
}

main().catch((error) => {
  console.error('❌ Script failed:', error?.message || error);
  process.exit(1);
});

