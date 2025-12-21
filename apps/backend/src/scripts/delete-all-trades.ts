/**
 * Script to delete all trades from the database and reset all related data
 * WARNING: This will permanently delete all trade data, closed lots, trade features, and reset all wallet metrics!
 * 
 * IMPORTANT: SIGNALS are PRESERVED - Signal and ConsensusSignal tables are NOT deleted!
 */

import { supabase, TABLES } from '../lib/supabase.js';

async function deleteAllTrades() {
  try {
    console.log('⚠️  WARNING: This will delete ALL trades and related data from the database!');
    console.log('Starting deletion...');

    // 1. Delete all closed lots - in batches
    console.log('🗑️  Deleting closed lots...');
    let closedLotsDeleted = 0;
    while (true) {
      const { data, error } = await supabase
        .from('ClosedLot')
        .select('id')
        .limit(1000);
      
      if (error) {
        console.warn(`⚠️  Warning: Failed to fetch closed lots: ${error.message}`);
        break;
      }
      
      if (!data || data.length === 0) {
        break;
      }
      
      const ids = data.map(row => row.id);
      const { error: deleteError } = await supabase
        .from('ClosedLot')
        .delete()
        .in('id', ids);
      
      if (deleteError) {
        console.warn(`⚠️  Warning: Failed to delete batch of closed lots: ${deleteError.message}`);
        break;
      }
      
      closedLotsDeleted += ids.length;
      console.log(`   Deleted ${closedLotsDeleted} closed lots...`);
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log(`✅ Successfully deleted ${closedLotsDeleted} closed lots`);

    // 2. Delete all trade features - in batches
    console.log('🗑️  Deleting trade features...');
    let tradeFeaturesDeleted = 0;
    while (true) {
      const { data, error } = await supabase
        .from('TradeFeature')
        .select('id')
        .limit(1000);
      
      if (error) {
        console.warn(`⚠️  Warning: Failed to fetch trade features: ${error.message}`);
        break;
      }
      
      if (!data || data.length === 0) {
        break;
      }
      
      const ids = data.map(row => row.id);
      const { error: deleteError } = await supabase
        .from('TradeFeature')
        .delete()
        .in('id', ids);
      
      if (deleteError) {
        console.warn(`⚠️  Warning: Failed to delete batch of trade features: ${deleteError.message}`);
        break;
      }
      
      tradeFeaturesDeleted += ids.length;
      console.log(`   Deleted ${tradeFeaturesDeleted} trade features...`);
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log(`✅ Successfully deleted ${tradeFeaturesDeleted} trade features`);

    // 3. Delete normalized trades first (new ingestion pipeline) - in batches
    console.log('🗑️  Deleting normalized trades...');
    let normalizedDeleted = 0;
    while (true) {
      const { data, error } = await supabase
        .from('NormalizedTrade')
        .select('id')
        .limit(1000);
      
      if (error) {
        console.warn(`⚠️  Warning: Failed to fetch normalized trades: ${error.message}`);
        break;
      }
      
      if (!data || data.length === 0) {
        break;
      }
      
      const ids = data.map(row => row.id);
      const { error: deleteError } = await supabase
        .from('NormalizedTrade')
        .delete()
        .in('id', ids);
      
      if (deleteError) {
        console.warn(`⚠️  Warning: Failed to delete batch of normalized trades: ${deleteError.message}`);
        break;
      }
      
      normalizedDeleted += ids.length;
      console.log(`   Deleted ${normalizedDeleted} normalized trades...`);
      
      // Small delay to avoid overwhelming the database
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log(`✅ Successfully deleted ${normalizedDeleted} normalized trades`);

    // 4. Delete all trades - in batches
    console.log('🗑️  Deleting trades...');
    let tradesDeleted = 0;
    while (true) {
      const { data, error } = await supabase
        .from(TABLES.TRADE)
        .select('id')
        .limit(1000);
      
      if (error) {
        throw new Error(`Failed to fetch trades: ${error.message}`);
      }
      
      if (!data || data.length === 0) {
        break;
      }
      
      const ids = data.map(row => row.id);
      const { error: deleteError } = await supabase
        .from(TABLES.TRADE)
        .delete()
        .in('id', ids);
      
      if (deleteError) {
        throw new Error(`Failed to delete trades: ${deleteError.message}`);
      }
      
      tradesDeleted += ids.length;
      console.log(`   Deleted ${tradesDeleted} trades...`);
      
      // Small delay to avoid overwhelming the database
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log(`✅ Successfully deleted ${tradesDeleted} trades`);

    // 5. Delete portfolio baseline cache - in batches
    console.log('🗑️  Deleting portfolio baseline cache...');
    let portfolioDeleted = 0;
    while (true) {
      const { data, error } = await supabase
        .from('PortfolioBaseline')
        .select('id')
        .limit(1000);
      
      if (error) {
        console.warn(`⚠️  Warning: Failed to fetch portfolio baseline: ${error.message}`);
        break;
      }
      
      if (!data || data.length === 0) {
        break;
      }
      
      const ids = data.map(row => row.id);
      const { error: deleteError } = await supabase
        .from('PortfolioBaseline')
        .delete()
        .in('id', ids);
      
      if (deleteError) {
        console.warn(`⚠️  Warning: Failed to delete batch of portfolio baseline: ${deleteError.message}`);
        break;
      }
      
      portfolioDeleted += ids.length;
      if (portfolioDeleted > 0 && portfolioDeleted % 1000 === 0) {
        console.log(`   Deleted ${portfolioDeleted} portfolio baseline records...`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (portfolioDeleted > 0) {
      console.log(`✅ Successfully deleted ${portfolioDeleted} portfolio baseline records`);
    } else {
      console.log('✅ Portfolio baseline cache is empty');
    }

    // 6. Clear wallet processing queue - in batches
    console.log('🗑️  Clearing wallet processing queue...');
    let queueDeleted = 0;
    while (true) {
      const { data, error } = await supabase
        .from('WalletProcessingQueue')
        .select('id')
        .limit(1000);
      
      if (error) {
        console.warn(`⚠️  Warning: Failed to fetch wallet processing queue: ${error.message}`);
        break;
      }
      
      if (!data || data.length === 0) {
        break;
      }
      
      const ids = data.map(row => row.id);
      const { error: deleteError } = await supabase
        .from('WalletProcessingQueue')
        .delete()
        .in('id', ids);
      
      if (deleteError) {
        console.warn(`⚠️  Warning: Failed to delete batch of wallet processing queue: ${deleteError.message}`);
        break;
      }
      
      queueDeleted += ids.length;
      if (queueDeleted > 0 && queueDeleted % 1000 === 0) {
        console.log(`   Deleted ${queueDeleted} queue records...`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (queueDeleted > 0) {
      console.log(`✅ Successfully deleted ${queueDeleted} wallet processing queue records`);
    } else {
      console.log('✅ Wallet processing queue is empty');
    }

    // 7. Delete metrics history - in batches
    console.log('🗑️  Deleting metrics history...');
    let metricsHistoryDeleted = 0;
    while (true) {
      const { data, error } = await supabase
        .from('SmartWalletMetricsHistory')
        .select('id')
        .limit(1000);
      
      if (error) {
        console.warn(`⚠️  Warning: Failed to fetch metrics history: ${error.message}`);
        break;
      }
      
      if (!data || data.length === 0) {
        break;
      }
      
      const ids = data.map(row => row.id);
      const { error: deleteError } = await supabase
        .from('SmartWalletMetricsHistory')
        .delete()
        .in('id', ids);
      
      if (deleteError) {
        console.warn(`⚠️  Warning: Failed to delete batch of metrics history: ${deleteError.message}`);
        break;
      }
      
      metricsHistoryDeleted += ids.length;
      if (metricsHistoryDeleted > 0 && metricsHistoryDeleted % 1000 === 0) {
        console.log(`   Deleted ${metricsHistoryDeleted} metrics history records...`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (metricsHistoryDeleted > 0) {
      console.log(`✅ Successfully deleted ${metricsHistoryDeleted} metrics history records`);
    } else {
      console.log('✅ Metrics history is empty');
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

