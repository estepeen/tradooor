/**
 * Script to recalculate open/closed positions and metrics for all wallets
 * 
 * Usage:
 *   pnpm --filter backend tsx src/scripts/recalculate-all-positions.ts
 * 
 * This script:
 * 1. Fetches all wallets from database
 * 2. For each wallet, recalculates closed lots and open positions
 * 3. Saves them to database
 * 4. Optionally recalculates metrics
 */

import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';

const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();
const metricsHistoryRepo = new MetricsHistoryRepository();
const lotMatchingService = new LotMatchingService();
const metricsCalculator = new MetricsCalculatorService(
  smartWalletRepo,
  tradeRepo,
  metricsHistoryRepo
);

const DELAY_BETWEEN_WALLETS_MS = 1000; // 1 second delay between wallets
const BATCH_SIZE = 10; // Process 10 wallets, then log progress

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function recalculateWalletPositions(walletId: string, walletAddress: string) {
  try {
    console.log(`\n🔄 Processing wallet ${walletId} (${walletAddress})...`);

    // 1. Recalculate closed lots and open positions
    const { closedLots, openPositions } = await lotMatchingService.processTradesForWallet(walletId);
    
    console.log(`   📊 Calculated: ${closedLots.length} closed lots, ${openPositions.length} open positions`);

    // 2. Save to database
    await lotMatchingService.saveClosedLots(closedLots);
    
    if (openPositions.length > 0) {
      await lotMatchingService.saveOpenPositions(openPositions);
    } else {
      await lotMatchingService.deleteOpenPositionsForWallet(walletId);
    }

    console.log(`   ✅ Saved to DB: ${closedLots.length} closed lots, ${openPositions.length} open positions`);

    // 3. Recalculate metrics
    const metricsResult = await metricsCalculator.calculateMetricsForWallet(walletId);
    console.log(`   ✅ Metrics updated: score=${metricsResult?.score?.toFixed(2) ?? 'n/a'}, totalTrades=${metricsResult?.totalTrades ?? 0}`);

    return {
      success: true,
      walletId,
      closedLotsCount: closedLots.length,
      openPositionsCount: openPositions.length,
    };
  } catch (error: any) {
    console.error(`   ❌ Error processing wallet ${walletId}:`, error?.message || error);
    return {
      success: false,
      walletId,
      error: error?.message || 'Unknown error',
    };
  }
}

async function main() {
  console.log('🚀 Starting bulk recalculation of positions and metrics for all wallets...\n');

  try {
    // Fetch all wallets
    const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
    const wallets = allWallets.wallets || [];
    
    console.log(`📊 Found ${wallets.length} wallets to process\n`);

    if (wallets.length === 0) {
      console.log('⚠️  No wallets found in database');
      process.exit(0);
    }

    const results = {
      total: wallets.length,
      success: 0,
      failed: 0,
      skipped: 0,
    };

    // Process wallets in batches
    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      
      // Check if wallet has trades
      const trades = await tradeRepo.findByWalletId(wallet.id, { page: 1, pageSize: 1 });
      if (trades.total === 0) {
        console.log(`⏭️  Skipping wallet ${wallet.id} (${wallet.address}) - no trades`);
        results.skipped++;
        continue;
      }

      const result = await recalculateWalletPositions(wallet.id, wallet.address);
      
      if (result.success) {
        results.success++;
      } else {
        results.failed++;
      }

      // Log progress every BATCH_SIZE wallets
      if ((i + 1) % BATCH_SIZE === 0) {
        console.log(`\n📊 Progress: ${i + 1}/${wallets.length} wallets processed (${results.success} success, ${results.failed} failed, ${results.skipped} skipped)\n`);
      }

      // Delay between wallets to avoid overwhelming the database
      if (i < wallets.length - 1) {
        await sleep(DELAY_BETWEEN_WALLETS_MS);
      }
    }

    // Final summary
    console.log('\n' + '='.repeat(60));
    console.log('✅ Bulk recalculation completed!');
    console.log('='.repeat(60));
    console.log(`Total wallets: ${results.total}`);
    console.log(`✅ Success: ${results.success}`);
    console.log(`❌ Failed: ${results.failed}`);
    console.log(`⏭️  Skipped (no trades): ${results.skipped}`);
    console.log('='.repeat(60) + '\n');

    process.exit(0);
  } catch (error: any) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

main();
