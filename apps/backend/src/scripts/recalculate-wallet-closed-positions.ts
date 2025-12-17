/**
 * Recalculate Closed Positions for a Specific Wallet
 * 
 * Přepočítá closed positions (closed lots) a metriky pro vybranou wallet.
 * 
 * Usage:
 *   pnpm --filter backend recalculate:wallet-closed-positions WALLET_ID_NEBO_ADDRESS
 * 
 * Example:
 *   pnpm --filter backend recalculate:wallet-closed-positions FAicXNV5FVqtfbpn4Zccs71XcfGeyxBSGbqLDyDJZjke
 *   pnpm --filter backend recalculate:wallet-closed-positions cmi0n67i39lgtmq7gzl8
 */

import dotenv from 'dotenv';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { supabase, TABLES } from '../lib/supabase.js';

dotenv.config();

async function main() {
  const identifier = process.argv[2]; // Wallet ID or address
  
  if (!identifier) {
    console.error('❌ Error: Wallet ID or address is required');
    console.log('\nUsage:');
    console.log('  pnpm --filter backend recalculate:wallet-closed-positions WALLET_ID_NEBO_ADDRESS');
    console.log('\nExample:');
    console.log('  pnpm --filter backend recalculate:wallet-closed-positions FAicXNV5FVqtfbpn4Zccs71XcfGeyxBSGbqLDyDJZjke');
    console.log('  pnpm --filter backend recalculate:wallet-closed-positions cmi0n67i39lgtmq7gzl8');
    process.exit(1);
  }

  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();
  const metricsHistoryRepo = new MetricsHistoryRepository();
  const metricsCalculator = new MetricsCalculatorService(
    smartWalletRepo,
    tradeRepo,
    metricsHistoryRepo
  );
  const lotMatchingService = new LotMatchingService();

  try {
    // Find wallet - support both ID and address
    let wallet: any = await smartWalletRepo.findById(identifier);
    if (!wallet) {
      wallet = await smartWalletRepo.findByAddress(identifier);
    }
    if (!wallet) {
      console.error(`❌ Error: Wallet not found: ${identifier}`);
      process.exit(1);
    }

    console.log(`🔄 [Recalculate] Starting recalculation for wallet ${wallet.address.substring(0, 8)}... (ID: ${wallet.id})`);
    
    // 1. Get wallet tracking start time
    const trackingStartTime = wallet.createdAt ? new Date(wallet.createdAt) : undefined;
    
    // 2. Recalculate closed lots (FIFO matching)
    console.log(`   📊 Recalculating closed lots...`);
    const closedLots = await lotMatchingService.processTradesForWallet(
      wallet.id,
      undefined, // Process all tokens
      trackingStartTime
    );
    await lotMatchingService.saveClosedLots(closedLots);
    console.log(`   ✅ Created ${closedLots.length} closed lots`);
    
    // 3. Recalculate metrics
    console.log(`   📊 Recalculating metrics...`);
    const metricsResult = await metricsCalculator.calculateMetricsForWallet(wallet.id);
    console.log(`   ✅ Metrics updated: score=${metricsResult?.score ?? 'n/a'}, totalTrades=${metricsResult?.totalTrades ?? 0}`);
    
    // 4. Invalidate portfolio cache (if using Supabase)
    if (process.env.SUPABASE_URL) {
      try {
        console.log(`   🗑️  Invalidating portfolio cache...`);
        const { error: deleteError } = await supabase
          .from('PortfolioBaseline')
          .delete()
          .eq('walletId', wallet.id);
        
        if (deleteError) {
          console.warn(`   ⚠️  Failed to invalidate portfolio cache: ${deleteError.message}`);
        } else {
          console.log(`   ✅ Portfolio cache invalidated`);
        }
      } catch (cacheError: any) {
        console.warn(`   ⚠️  Failed to invalidate portfolio cache: ${cacheError.message}`);
      }
    } else {
      console.log(`   ⏭️  Skipping portfolio cache invalidation (Prisma-only mode)`);
    }
    
    // 5. Optionally refresh portfolio via API (if backend is running)
    const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
    const USE_API_FOR_PORTFOLIO = process.env.USE_API_FOR_PORTFOLIO !== 'false';
    
    if (USE_API_FOR_PORTFOLIO) {
      try {
        console.log(`   🔄 Refreshing portfolio via API...`);
        const response = await fetch(`${API_BASE_URL}/api/smart-wallets/${wallet.id}/portfolio/refresh`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });
        
        if (response.ok) {
          const portfolioData = await response.json();
          const closedCount = portfolioData.closedPositions?.length || 0;
          console.log(`   ✅ Portfolio refreshed: ${closedCount} closed positions`);
        } else {
          console.warn(`   ⚠️  Portfolio refresh failed: HTTP ${response.status}`);
        }
      } catch (fetchError: any) {
        console.warn(`   ⚠️  Portfolio refresh failed: ${fetchError.message}`);
        console.warn(`   💡 Tip: Make sure backend server is running at ${API_BASE_URL}`);
      }
    }
    
    // 6. Fetch updated wallet data
    const updatedWallet = await smartWalletRepo.findById(wallet.id);
    
    console.log(`\n✅ Recalculation completed successfully!`);
    console.log(`   Closed lots: ${closedLots.length}`);
    console.log(`   Score: ${updatedWallet?.score ?? 0}`);
    console.log(`   Total trades: ${updatedWallet?.totalTrades ?? 0}`);
    console.log(`   Win rate: ${((updatedWallet?.winRate ?? 0) * 100).toFixed(2)}%`);
    console.log(`   Recent PnL (30d): ${updatedWallet?.recentPnl30dUsd ?? 0} USD (${updatedWallet?.recentPnl30dPercent ?? 0}%)`);
    console.log(`\n💡 Tip: Refresh the wallet page in the browser to see updated closed positions.`);
    
  } catch (error: any) {
    console.error('❌ Error recalculating closed positions:', error);
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    process.exit(1);
  }
}

main();

