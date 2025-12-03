/**
 * Script to delete all trades from the database and reset all related data
 * WARNING: This will permanently delete all trade data, closed lots, trade features, and reset all wallet metrics!
 */

import { supabase, TABLES } from '../lib/supabase.js';

async function deleteAllTrades() {
  try {
    console.log('⚠️  WARNING: This will delete ALL trades and related data from the database!');
    console.log('Starting deletion...');

    // 1. Delete all closed lots
    console.log('🗑️  Deleting closed lots...');
    const { error: closedLotsError } = await supabase
      .from('ClosedLot')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (closedLotsError) {
      console.warn(`⚠️  Warning: Failed to delete closed lots: ${closedLotsError.message}`);
    } else {
      console.log('✅ Successfully deleted all closed lots');
    }

    // 2. Delete all trade features
    console.log('🗑️  Deleting trade features...');
    const { error: tradeFeaturesError } = await supabase
      .from('TradeFeature')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (tradeFeaturesError) {
      console.warn(`⚠️  Warning: Failed to delete trade features: ${tradeFeaturesError.message}`);
    } else {
      console.log('✅ Successfully deleted all trade features');
    }

    // 3. Delete normalized trades first (new ingestion pipeline)
    console.log('🗑️  Deleting normalized trades...');
    const { error: normalizedError } = await supabase
      .from('NormalizedTrade')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (normalizedError) {
      console.warn(`⚠️  Warning: Failed to delete normalized trades: ${normalizedError.message}`);
    } else {
      console.log('✅ Successfully deleted all normalized trades');
    }

    // 4. Delete all trades
    console.log('🗑️  Deleting trades...');
    const { error: tradesError } = await supabase
      .from(TABLES.TRADE)
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (tradesError) {
      throw new Error(`Failed to delete trades: ${tradesError.message}`);
    }
    console.log('✅ Successfully deleted all trades');

    // 5. Delete portfolio baseline cache
    console.log('🗑️  Deleting portfolio baseline cache...');
    const { error: portfolioError } = await supabase
      .from('PortfolioBaseline')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (portfolioError) {
      console.warn(`⚠️  Warning: Failed to delete portfolio baseline: ${portfolioError.message}`);
    } else {
      console.log('✅ Successfully deleted portfolio baseline cache');
    }

    // 6. Clear wallet processing queue
    console.log('🗑️  Clearing wallet processing queue...');
    const { error: queueError } = await supabase
      .from('WalletProcessingQueue')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (queueError) {
      console.warn(`⚠️  Warning: Failed to clear wallet processing queue: ${queueError.message}`);
    } else {
      console.log('✅ Successfully cleared wallet processing queue');
    }

    // 7. Delete metrics history
    console.log('🗑️  Deleting metrics history...');
    const { error: metricsHistoryError } = await supabase
      .from('SmartWalletMetricsHistory')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (metricsHistoryError) {
      console.warn(`⚠️  Warning: Failed to delete metrics history: ${metricsHistoryError.message}`);
    } else {
      console.log('✅ Successfully deleted metrics history');
    }

    // 8. Reset all wallet metrics (including score, PnL, and tags)
    console.log('🔄 Resetting wallet metrics (including score, PnL, and tags)...');
    const { error: updateError } = await supabase
      .from(TABLES.SMART_WALLET)
      .update({
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
        updatedAt: new Date().toISOString(),
      })
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Update all

    if (updateError) {
      console.warn(`⚠️  Warning: Failed to reset wallet metrics: ${updateError.message}`);
    } else {
      console.log('✅ Successfully reset wallet metrics (including score and PnL)');
    }

    console.log('\n✅ All trades and related data deleted!');
    console.log('   - All trades deleted');
    console.log('   - All closed lots deleted');
    console.log('   - All trade features deleted');
    console.log('   - Portfolio baseline cache cleared');
    console.log('   - Wallet processing queue cleared');
    console.log('   - Metrics history deleted');
    console.log('   - Wallet metrics reset (score, PnL, advancedStats, tags)');
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

