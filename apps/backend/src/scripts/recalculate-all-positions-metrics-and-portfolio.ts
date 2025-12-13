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
 * Recalculate positions (closed lots), metrics, and portfolio cache (closed positions) for all wallets
 * This is a comprehensive script that:
 * 1. Recalculates closed lots (FIFO matching)
 * 2. Recalculates metrics (win rate, PnL, score, etc.)
 * 3. Updates portfolio cache (closed positions)
 */
async function recalculateAllPositionsMetricsAndPortfolio() {
  console.log(`\n🔄 Recalculating positions, metrics, and portfolio cache for all wallets...\n`);

  // Get API base URL for portfolio cache update
  const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
  const USE_API_FOR_PORTFOLIO = process.env.USE_API_FOR_PORTFOLIO !== 'false'; // Default to true

  // 1. Get all wallets
  const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
  console.log(`📋 Found ${allWallets.wallets.length} wallets\n`);

  let totalProcessed = 0;
  let totalPositions = 0;
  let totalErrors = 0;
  let portfolioCacheUpdated = 0;
  let portfolioCacheErrors = 0;

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
      const closedLots = await lotMatchingService.processTradesForWallet(
        wallet.id,
        undefined, // Process all tokens
        trackingStartTime
      );

      await lotMatchingService.saveClosedLots(closedLots);
      console.log(`   ✅ Positions: ${closedLots.length} closed lots`);

      // Step 2: Recalculate metrics
      await metricsCalculator.calculateMetricsForWallet(wallet.id);
      console.log(`   ✅ Metrics recalculated`);

      // Step 3: Update portfolio cache (closed positions)
      if (USE_API_FOR_PORTFOLIO) {
        try {
          const response = await fetch(`${API_BASE_URL}/api/smart-wallets/${wallet.id}/portfolio?forceRefresh=true`, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
            },
          });

          if (response.ok) {
            const portfolioData = await response.json();
            const portfolio = portfolioData as any;
            const closedCount = portfolio.closedPositions?.length || 0;
            console.log(`   ✅ Portfolio cache updated: ${closedCount} closed positions`);
            portfolioCacheUpdated++;
          } else {
            console.warn(`   ⚠️  Portfolio cache update failed: HTTP ${response.status}`);
            portfolioCacheErrors++;
          }
        } catch (fetchError: any) {
          console.warn(`   ⚠️  Portfolio cache update failed: ${fetchError.message}`);
          console.warn(`   💡 Tip: Make sure backend server is running on ${API_BASE_URL}`);
          portfolioCacheErrors++;
        }
      } else {
        console.log(`   ⏭️  Skipping portfolio cache update (USE_API_FOR_PORTFOLIO=false)`);
      }

      totalProcessed++;
      totalPositions += closedLots.length;

    } catch (error: any) {
      totalErrors++;
      console.error(`   ❌ Error processing wallet ${wallet.address}: ${error.message}`);
      if (error.stack) {
        console.error(`   Stack: ${error.stack.split('\n').slice(0, 3).join('\n')}`);
      }
    }
  }

  console.log(`\n✅ Recalculation complete!`);
  console.log(`   Processed wallets: ${totalProcessed}`);
  console.log(`   Total closed lots: ${totalPositions}`);
  console.log(`   Portfolio cache updated: ${portfolioCacheUpdated}`);
  console.log(`   Portfolio cache errors: ${portfolioCacheErrors}`);
  console.log(`   Errors: ${totalErrors}\n`);
  
  if (portfolioCacheErrors > 0 && USE_API_FOR_PORTFOLIO) {
    console.log(`\n💡 Tip: If portfolio cache updates failed, make sure backend server is running:`);
    console.log(`   ${API_BASE_URL}`);
    console.log(`   Or set USE_API_FOR_PORTFOLIO=false to skip portfolio cache updates\n`);
  }
}

recalculateAllPositionsMetricsAndPortfolio().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
