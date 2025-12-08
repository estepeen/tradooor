import 'dotenv/config';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

const lotMatchingService = new LotMatchingService();
const smartWalletRepo = new SmartWalletRepository();

async function recalculateAllPositions() {
  console.log(`\n🔄 Recalculating positions for ALL wallets...\n`);

  // 1. Get all wallets
  const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
  console.log(`📋 Found ${allWallets.wallets.length} wallets\n`);

  let totalProcessed = 0;
  let totalErrors = 0;
  let totalClosedLots = 0;

  // 2. Process each wallet
  for (const wallet of allWallets.wallets) {
    try {
      console.log(`\n🔍 Processing wallet: ${wallet.label || wallet.address} (${wallet.address.substring(0, 8)}...)`);

      // Get tracking start time
      const trackingStartTime = wallet.createdAt ? new Date(wallet.createdAt) : undefined;

      // Process trades and create closed lots
      const closedLots = await lotMatchingService.processTradesForWallet(
        wallet.id,
        undefined, // Process all tokens
        trackingStartTime
      );

      // Save closed lots to database
      await lotMatchingService.saveClosedLots(closedLots);

      totalProcessed++;
      totalClosedLots += closedLots.length;

      // Show summary
      const byToken = new Map<string, number>();
      let totalPnl = 0;
      let preHistoryCount = 0;

      for (const lot of closedLots) {
        byToken.set(lot.tokenId, (byToken.get(lot.tokenId) || 0) + 1);
        totalPnl += lot.realizedPnl;
        if (lot.isPreHistory) preHistoryCount++;
      }

      console.log(`   ✅ Processed: ${closedLots.length} closed lots, ${byToken.size} tokens, PnL: ${totalPnl.toFixed(4)} SOL`);
      if (preHistoryCount > 0) {
        console.log(`   ⚠️  ${preHistoryCount} pre-history lots (cost unknown)`);
      }
    } catch (error: any) {
      totalErrors++;
      console.error(`   ❌ Error processing wallet ${wallet.address}: ${error.message}`);
    }
  }

  console.log(`\n✅ Recalculation complete!`);
  console.log(`   Processed wallets: ${totalProcessed}`);
  console.log(`   Total closed lots: ${totalClosedLots}`);
  console.log(`   Errors: ${totalErrors}\n`);
}

recalculateAllPositions().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

