/**
 * Reset Signals
 * Smaže všechny signals
 * 
 * Usage: pnpm --filter backend reset:signals
 */

import { supabase } from '../lib/supabase.js';

async function resetSignals() {
  console.log('🔄 Resetting signals...\n');

  try {
    // Smaž všechny signals
    const { error: signalsError } = await supabase
      .from('Signal')
      .delete()
      .neq('id', '0'); // Delete all (neq '0' ensures all rows match)

    if (signalsError) {
      // Table might not exist yet
      if (signalsError.code === '42P01' || /does not exist/i.test(signalsError.message)) {
        console.warn('⚠️  Signal table does not exist yet. Run ADD_SIGNALS.sql migration.');
        return;
      }
      throw new Error(`Failed to delete signals: ${signalsError.message}`);
    }

    console.log('✅ Deleted all signals');
    console.log('\n✅ Signals reset complete!');
    console.log('📊 New signals will be generated from webhook events (consensus trades)');
  } catch (error: any) {
    console.error('❌ Error resetting signals:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  resetSignals();
}

export { resetSignals };
