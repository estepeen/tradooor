/**
 * Script to delete all trades from the database and reset all related data
 * WARNING: This will permanently delete all trade data, closed lots, trade features, and reset all wallet metrics!
 * 
 * IMPORTANT: SIGNALS are PRESERVED - Signal and ConsensusSignal tables are NOT deleted!
 */

import { prisma } from '../lib/prisma.js';

async function deleteAllTrades() {
  try {
    console.log('⚠️  WARNING: This will delete ALL trades and related data from the database!');
    console.log('Starting deletion...');

    // 1. Delete all closed lots
    console.log('🗑️  Deleting closed lots...');
    const deletedClosedLots = await prisma.closedLot.deleteMany({});
    console.log(`✅ Successfully deleted ${deletedClosedLots.count} closed lots`);

    // 2. Delete all trade features
    console.log('🗑️  Deleting trade features...');
    const deletedTradeFeatures = await prisma.tradeFeature.deleteMany({});
    console.log(`✅ Successfully deleted ${deletedTradeFeatures.count} trade features`);

    // 3. Delete normalized trades
    console.log('🗑️  Deleting normalized trades...');
    const deletedNormalizedTrades = await prisma.normalizedTrade.deleteMany({});
    console.log(`✅ Successfully deleted ${deletedNormalizedTrades.count} normalized trades`);

    // 4. Delete paper trades first (they reference trades via foreign key)
    console.log('🗑️  Deleting paper trades...');
    const deletedPaperTrades = await prisma.paperTrade.deleteMany({});
    console.log(`✅ Successfully deleted ${deletedPaperTrades.count} paper trades`);

    // 5. Delete all trades
    console.log('🗑️  Deleting trades...');
    const deletedTrades = await prisma.trade.deleteMany({});
    console.log(`✅ Successfully deleted ${deletedTrades.count} trades`);

    // 6. Delete trade sequences
    console.log('🗑️  Deleting trade sequences...');
    const deletedSequences = await prisma.tradeSequence.deleteMany({});
    console.log(`✅ Successfully deleted ${deletedSequences.count} trade sequences`);

    // 7. Delete trade outcomes
    console.log('🗑️  Deleting trade outcomes...');
    const deletedOutcomes = await prisma.tradeOutcome.deleteMany({});
    console.log(`✅ Successfully deleted ${deletedOutcomes.count} trade outcomes`);

    // 8. Delete metrics history
    console.log('🗑️  Deleting metrics history...');
    const deletedMetricsHistory = await prisma.smartWalletMetricsHistory.deleteMany({});
    console.log(`✅ Successfully deleted ${deletedMetricsHistory.count} metrics history records`);

    // 9. Clear wallet processing queue
    console.log('🗑️  Clearing wallet processing queue...');
    const deletedQueue = await prisma.walletProcessingQueue.deleteMany({});
    if (deletedQueue.count > 0) {
      console.log(`✅ Successfully deleted ${deletedQueue.count} wallet processing queue records`);
    } else {
      console.log('✅ Wallet processing queue is empty');
    }

    // 10. Reset all wallet metrics (including score, PnL, and tags)
    console.log('🔄 Resetting wallet metrics (including score, PnL, and tags)...');
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
        recentPnl30dUsd: 0, // Important for homepage PnL display
        advancedStats: null, // Important for homepage score and rolling stats
        tags: [], // Reset all tags (auto-generated and user-defined)
      },
    });
    console.log(`✅ Successfully reset metrics for ${updatedWallets.count} wallets`);

    console.log('\n✅ All trades and related data deleted!');
    console.log('   - All trades deleted');
    console.log('   - All closed lots deleted');
    console.log('   - All trade features deleted');
    console.log('   - All normalized trades deleted');
    console.log('   - All paper trades deleted');
    console.log('   - All trade sequences deleted');
    console.log('   - All trade outcomes deleted');
    console.log('   - Wallet processing queue cleared');
    console.log('   - Metrics history deleted');
    console.log('   - Wallet metrics reset (score, PnL, advancedStats, tags)');
    console.log('\n✅ SIGNALS PRESERVED - Signal and ConsensusSignal tables were NOT deleted!');
  } catch (error: any) {
    console.error('❌ Error deleting trades:', error.message);
    process.exit(1);
  }
}

// Run the script
deleteAllTrades()
  .then(() => {
    console.log('✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });

