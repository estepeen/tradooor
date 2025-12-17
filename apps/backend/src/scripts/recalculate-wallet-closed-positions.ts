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
    
    // 4. Fetch updated wallet data
    const updatedWallet = await smartWalletRepo.findById(wallet.id);
    
    console.log(`\n✅ Recalculation completed successfully!`);
    console.log(`   Closed lots: ${closedLots.length}`);
    console.log(`   Score: ${updatedWallet?.score ?? 0}`);
    console.log(`   Total trades: ${updatedWallet?.totalTrades ?? 0}`);
    console.log(`   Win rate: ${((updatedWallet?.winRate ?? 0) * 100).toFixed(2)}%`);
    console.log(`   Recent PnL (30d): ${updatedWallet?.recentPnl30dUsd ?? 0} USD (${updatedWallet?.recentPnl30dPercent ?? 0}%)`);
    
  } catch (error: any) {
    console.error('❌ Error recalculating closed positions:', error);
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    process.exit(1);
  }
}

main();

