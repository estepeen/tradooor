/**
 * Script to delete all trades from the database
 * WARNING: This will permanently delete all trade data!
 */

import { supabase, TABLES } from '../lib/supabase.js';

async function deleteAllTrades() {
  try {
    console.log('⚠️  WARNING: This will delete ALL trades from the database!');
    console.log('Starting deletion...');

    // Delete all trades - Supabase requires a filter, so we use a condition that matches all rows
    const { error } = await supabase
      .from(TABLES.TRADE)
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all (using a condition that matches all rows)

    if (error) {
      throw new Error(`Failed to delete trades: ${error.message}`);
    }

    console.log(`✅ Successfully deleted all trades`);

    // Also reset wallet metrics that depend on trades
    console.log('🔄 Resetting wallet metrics...');
    const { error: updateError } = await supabase
      .from(TABLES.SMART_WALLET)
      .update({
        totalTrades: 0,
        winRate: 0,
        avgRr: 0,
        avgPnlPercent: 0,
        pnlTotalBase: 0,
        avgHoldingTimeMin: 0,
        maxDrawdownPercent: 0,
        recentPnl30dPercent: 0,
        score: 0,
      })
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Update all

    if (updateError) {
      console.warn(`⚠️  Warning: Failed to reset wallet metrics: ${updateError.message}`);
    } else {
      console.log('✅ Successfully reset wallet metrics');
    }

    console.log('✅ All trades deleted and wallet metrics reset!');
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

