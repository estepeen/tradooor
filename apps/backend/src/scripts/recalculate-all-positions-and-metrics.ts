import 'dotenv/config';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

const lotMatchingService = new LotMatchingService();
const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();
const metricsHistoryRepo = new MetricsHistoryRepository();
const metricsCalculator = new MetricsCalculatorService(
  smartWalletRepo,
  tradeRepo,
  metricsHistoryRepo
);

/**
 * Recalculate positions and metrics for all wallets that have trades
 */
async function recalculateAllPositionsAndMetrics() {
  console.log(`\n🔄 Recalculating positions and metrics for all wallets...\n`);

  // 1. Get all wallets
  const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
  console.log(`📋 Found ${allWallets.wallets.length} wallets\n`);

  let totalProcessed = 0;
  let totalPositions = 0;
  let totalErrors = 0;

  // 2. Process each wallet
  for (const wallet of allWallets.wallets) {
    try {
      // Check if wallet has trades
      const { total } = await tradeRepo.findByWalletId(wallet.id, { pageSize: 1 });
      if (total === 0) {
        continue; // Skip wallets without trades
      }

      console.log(`\n[${totalProcessed + 1}/${allWallets.wallets.length}] 🔍 Processing wallet: ${wallet.label || wallet.address} (${wallet.address.substring(0, 8)}...)`);
      console.log(`   Trades: ${total}`);

      // Step 1: Recalculate positions (closed lots)
      const trackingStartTime = wallet.createdAt ? new Date(wallet.createdAt) : undefined;
      const { closedLots, openPositions } = await lotMatchingService.processTradesForWallet(
        wallet.id,
        undefined, // Process all tokens
        trackingStartTime
      );

      await lotMatchingService.saveClosedLots(closedLots);
      if (openPositions.length > 0) {
        await lotMatchingService.saveOpenPositions(openPositions);
      } else {
        await lotMatchingService.deleteOpenPositionsForWallet(wallet.id);
      }
      console.log(`   ✅ Positions: ${closedLots.length} closed lots`);

      // Step 2: Recalculate metrics
      await metricsCalculator.calculateMetricsForWallet(wallet.id);
      console.log(`   ✅ Metrics recalculated`);

      totalProcessed++;
      totalPositions += closedLots.length;

    } catch (error: any) {
      totalErrors++;
      console.error(`   ❌ Error processing wallet ${wallet.address}: ${error.message}`);
    }
  }

  console.log(`\n✅ Recalculation complete!`);
  console.log(`   Processed wallets: ${totalProcessed}`);
  console.log(`   Total closed lots: ${totalPositions}`);
  console.log(`   Errors: ${totalErrors}\n`);
}

recalculateAllPositionsAndMetrics().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

