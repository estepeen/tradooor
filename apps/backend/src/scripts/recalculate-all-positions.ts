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

const DELAY_BETWEEN_WALLETS_MS = 500; // 0.5 second delay between wallets (reduced for faster processing)
const BATCH_SIZE = 5; // Process 5 wallets, then log progress (more frequent updates)
const MAX_WALLETS_TO_PROCESS = 1000; // Safety limit to prevent infinite loops

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

    // Process wallets in batches with timeout protection
    const maxWallets = Math.min(wallets.length, MAX_WALLETS_TO_PROCESS);
    console.log(`📊 Processing ${maxWallets} wallets (limited to ${MAX_WALLETS_TO_PROCESS} for safety)\n`);

    for (let i = 0; i < maxWallets; i++) {
      const wallet = wallets[i];
      
      try {
        // Check if wallet has trades (with timeout)
        const tradesPromise = tradeRepo.findByWalletId(wallet.id, { page: 1, pageSize: 1 });
        const tradesTimeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 5000)
        );
        
        const trades = await Promise.race([tradesPromise, tradesTimeout]) as any;
        
        if (trades.total === 0) {
          console.log(`⏭️  [${i + 1}/${maxWallets}] Skipping wallet ${wallet.id.substring(0, 8)}... - no trades`);
          results.skipped++;
          continue;
        }

        // Process wallet with timeout
        const processPromise = recalculateWalletPositions(wallet.id, wallet.address);
        const processTimeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Processing timeout')), 30000) // 30s timeout per wallet
        );
        
        const result = await Promise.race([processPromise, processTimeout]) as any;
        
        if (result.success) {
          results.success++;
        } else {
          results.failed++;
        }
      } catch (error: any) {
        console.error(`   ❌ Error processing wallet ${wallet.id.substring(0, 8)}...: ${error?.message || error}`);
        results.failed++;
      }

      // Log progress every BATCH_SIZE wallets
      if ((i + 1) % BATCH_SIZE === 0) {
        console.log(`\n📊 Progress: ${i + 1}/${maxWallets} wallets processed (${results.success} success, ${results.failed} failed, ${results.skipped} skipped)\n`);
      }

      // Delay between wallets to avoid overwhelming the database
      if (i < maxWallets - 1) {
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
