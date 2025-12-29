/**
 * Debug script to check if ClosedLot data exists and has realizedPnlUsd
 * 
 * Usage: pnpm --filter backend check:pnl-data <wallet-address>
 */

import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';

const walletAddress = process.argv[2];

if (!walletAddress) {
  console.error('❌ Usage: pnpm --filter backend check:pnl-data <wallet-address>');
  process.exit(1);
}

async function main() {
  console.log(`🔍 Checking PnL data for wallet: ${walletAddress}\n`);

  const smartWalletRepo = new SmartWalletRepository();
  const closedLotRepo = new ClosedLotRepository();
  const tradeRepo = new TradeRepository();
  const metricsHistoryRepo = new MetricsHistoryRepository();
  const metricsCalculator = new MetricsCalculatorService(
    smartWalletRepo,
    tradeRepo,
    metricsHistoryRepo
  );

  // 1. Find wallet
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`✅ Wallet found: ${wallet.label || wallet.address}`);
  console.log(`   ID: ${wallet.id}\n`);

  // 2. Check ClosedLot data
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  console.log('📦 Checking ClosedLot data:');
  const closedLots = await closedLotRepo.findByWallet(wallet.id, { fromDate: thirtyDaysAgo });
  console.log(`   Total ClosedLot (last 30d): ${closedLots.length}`);
  
  if (closedLots.length === 0) {
    console.log('   ⚠️  No ClosedLot data found!');
    console.log('   This means no closed positions exist in the last 30 days.');
    console.log('   Check if lot-matching service is running and creating ClosedLot records.\n');
  } else {
    const lotsWithPnl = closedLots.filter(lot => lot.realizedPnlUsd !== null && lot.realizedPnlUsd !== undefined);
    const lotsWithoutPnl = closedLots.filter(lot => lot.realizedPnlUsd === null || lot.realizedPnlUsd === undefined);
    
    console.log(`   ClosedLot with realizedPnlUsd: ${lotsWithPnl.length}`);
    console.log(`   ClosedLot without realizedPnlUsd: ${lotsWithoutPnl.length}`);
    
    if (lotsWithPnl.length > 0) {
      const totalPnl = lotsWithPnl.reduce((sum, lot) => sum + (lot.realizedPnlUsd ?? 0), 0);
      console.log(`   Total realizedPnlUsd: ${totalPnl.toFixed(2)} USD\n`);
      
      console.log('   First 5 ClosedLot records:');
      closedLots.slice(0, 5).forEach((lot, idx) => {
        console.log(`   ${idx + 1}. exitTime: ${lot.exitTime}, tokenId: ${lot.tokenId}, realizedPnlUsd: ${lot.realizedPnlUsd?.toFixed(2) ?? 'null'}`);
      });
      console.log('');
    } else {
      console.log('   ⚠️  No ClosedLot records have realizedPnlUsd!');
      console.log('   This means lot-matching service is not calculating realizedPnlUsd.\n');
    }
  }

  // 3. Check rolling stats calculation
  console.log('📊 Checking rolling stats calculation:');
  const rollingInsights = await metricsCalculator['computeRollingStatsAndScores'](wallet.id);
  const rolling30d = rollingInsights.rolling['30d'];
  console.log(`   rolling['30d'].realizedPnl: ${rolling30d?.realizedPnl?.toFixed(2) ?? 'null'}`);
  console.log(`   rolling['30d'].numClosedTrades: ${rolling30d?.numClosedTrades ?? 0}`);
  console.log(`   rolling['30d'].realizedRoiPercent: ${rolling30d?.realizedRoiPercent?.toFixed(2) ?? 'null'}%\n`);

  // 4. Check wallet database values
  console.log('💾 Checking wallet database values:');
  console.log(`   wallet.recentPnl30dBase: ${wallet.recentPnl30dBase ?? 'null'}`);
  console.log(`   wallet.recentPnl30dPercent: ${wallet.recentPnl30dPercent ?? 'null'}`);
  console.log(`   wallet.advancedStats?.rolling?.['30d']?.realizedPnl: ${(wallet.advancedStats as any)?.rolling?.['30d']?.realizedPnl ?? 'null'}\n`);

  // 5. Compare
  const dbPnl = wallet.recentPnl30dBase ?? 0;
  const rollingPnl = rolling30d?.realizedPnl ?? 0;
  const diff = Math.abs(dbPnl - rollingPnl);
  
  console.log('🔍 COMPARISON:');
  console.log(`   Database recentPnl30dBase: ${dbPnl.toFixed(2)} SOL`);
  console.log(`   Calculated rolling['30d'].realizedPnl: ${rollingPnl.toFixed(2)} SOL`);
  console.log(`   Difference: ${diff.toFixed(2)} USD`);
  
  if (diff > 0.01) {
    console.log(`\n⚠️  WARNING: Database value doesn't match calculated value!`);
    console.log(`   You may need to recalculate metrics for this wallet.`);
  } else if (rollingPnl === 0 && closedLots.length > 0) {
    console.log(`\n⚠️  WARNING: ClosedLot data exists but PnL is 0!`);
    console.log(`   Check if realizedPnlUsd is being calculated correctly.`);
  } else if (rollingPnl === 0 && closedLots.length === 0) {
    console.log(`\n✅ No closed positions in last 30 days - PnL is correctly 0.`);
  } else {
    console.log(`\n✅ Values match!`);
  }
}

main().catch(console.error);

