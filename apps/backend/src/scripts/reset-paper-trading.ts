/**
 * Reset Paper Trading
 * Smaže všechny paper trades a portfolio snapshots
 * 
 * Usage: pnpm --filter backend reset:paper-trading
 */

import { supabase, TABLES } from '../lib/supabase.js';

async function resetPaperTrading() {
  console.log('🔄 Resetting paper trading...\n');

  try {
    // 1. Smaž všechny paper trades
    const { error: tradesError } = await supabase
      .from('PaperTrade')
      .delete()
      .neq('id', '0'); // Delete all (neq '0' ensures all rows match)

    if (tradesError) {
      throw new Error(`Failed to delete paper trades: ${tradesError.message}`);
    }

    console.log('✅ Deleted all paper trades');

    // 2. Smaž všechny portfolio snapshots
    const { error: portfolioError } = await supabase
      .from('PaperPortfolio')
      .delete()
      .neq('id', '0');

    if (portfolioError) {
      throw new Error(`Failed to delete portfolio snapshots: ${portfolioError.message}`);
    }

    console.log('✅ Deleted all portfolio snapshots');

    console.log('\n✅ Paper trading reset complete!');
    console.log('📊 Portfolio will start fresh with $1,000 USD initial capital');
  } catch (error: any) {
    console.error('❌ Error resetting paper trading:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  resetPaperTrading();
}

export { resetPaperTrading };
