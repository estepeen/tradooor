/**
 * Reset all trades and closed lots - start fresh
 * 
 * WARNING: This will delete ALL trades and closed lots from the database!
 * Use this when you want to start fresh with correct SOL values.
 * 
 * Usage: pnpm --filter backend reset:all-trades
 */

import { prisma } from '../lib/prisma.js';

async function resetAllTrades() {
  console.log('⚠️  WARNING: This will delete ALL trades and closed lots!');
  console.log('   This action cannot be undone.\n');

  // Count current data
  const tradeCount = await prisma.trade.count();
  const closedLotCount = await prisma.closedLot.count();
  const normalizedTradeCount = await prisma.normalizedTrade.count();

  console.log('📊 Current data:');
  console.log(`   Trades: ${tradeCount}`);
  console.log(`   Closed Lots: ${closedLotCount}`);
  console.log(`   Normalized Trades: ${normalizedTradeCount}\n`);

  if (tradeCount === 0 && closedLotCount === 0) {
    console.log('✅ Database is already empty. Nothing to delete.');
    return;
  }

  console.log('🗑️  Deleting all trades and closed lots...\n');

  // Delete in correct order (respecting foreign key constraints)
  // 1. Delete closed lots first (they reference trades)
  console.log('1. Deleting closed lots...');
  const deletedClosedLots = await prisma.closedLot.deleteMany({});
  console.log(`   ✅ Deleted ${deletedClosedLots.count} closed lots`);

  // 2. Delete trades
  console.log('2. Deleting trades...');
  const deletedTrades = await prisma.trade.deleteMany({});
  console.log(`   ✅ Deleted ${deletedTrades.count} trades`);

  // 3. Delete normalized trades (they can be reprocessed)
  console.log('3. Deleting normalized trades...');
  const deletedNormalizedTrades = await prisma.normalizedTrade.deleteMany({});
  console.log(`   ✅ Deleted ${deletedNormalizedTrades.count} normalized trades`);

  // 4. Reset wallet metrics (they depend on trades)
  console.log('4. Resetting wallet metrics...');
  const updatedWallets = await prisma.smartWallet.updateMany({
    data: {
      score: 0,
      totalTrades: 0,
      winRate: 0,
      avgRr: 0,
      avgPnlPercent: 0,
      pnlTotalBase: 0,
      avgHoldingTimeMin: 0,
      maxDrawdownPercent: 0,
      recentPnl30dPercent: 0,
      recentPnl30dUsd: 0,
      advancedStats: null,
    },
  });
  console.log(`   ✅ Reset metrics for ${updatedWallets.count} wallets`);

  // 5. Delete trade features (they reference trades)
  console.log('5. Deleting trade features...');
  const deletedFeatures = await prisma.tradeFeature.deleteMany({});
  console.log(`   ✅ Deleted ${deletedFeatures.count} trade features`);

  // 6. Delete signals (they reference trades)
  console.log('6. Deleting signals...');
  const deletedSignals = await prisma.signal.deleteMany({});
  console.log(`   ✅ Deleted ${deletedSignals.count} signals`);

  // 7. Delete trade sequences and outcomes
  console.log('7. Deleting trade sequences and outcomes...');
  const deletedSequences = await prisma.tradeSequence.deleteMany({});
  const deletedOutcomes = await prisma.tradeOutcome.deleteMany({});
  console.log(`   ✅ Deleted ${deletedSequences.count} trade sequences`);
  console.log(`   ✅ Deleted ${deletedOutcomes.count} trade outcomes`);

  // 8. Delete metrics history
  console.log('8. Deleting metrics history...');
  const deletedHistory = await prisma.smartWalletMetricsHistory.deleteMany({});
  console.log(`   ✅ Deleted ${deletedHistory.count} metrics history entries`);

  console.log('\n✅ All trades and related data deleted!');
  console.log('\n📝 Next steps:');
  console.log('   1. Webhooks will automatically reprocess transactions');
  console.log('   2. New trades will be saved with correct SOL values');
  console.log('   3. Run metrics calculation: pnpm --filter backend metrics:cron');
  console.log('   4. Or wait for automatic metrics calculation');
}

// Safety check - require explicit confirmation
const args = process.argv.slice(2);
if (args[0] !== '--confirm') {
  console.error('❌ This script will delete ALL trades and closed lots!');
  console.error('   To confirm, run: pnpm --filter backend reset:all-trades --confirm');
  process.exit(1);
}

resetAllTrades()
  .then(() => {
    console.log('\n✅ Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

