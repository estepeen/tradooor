import 'dotenv/config';
import { supabase, TABLES } from '../lib/supabase.js';

async function deleteTrade(signature: string) {
  console.log(`\n🗑️  Deleting trade: ${signature}\n`);

  // Delete from NormalizedTrade table FIRST (has foreign key to Trade)
  const { error: normError } = await supabase
    .from('NormalizedTrade')
    .delete()
    .eq('txSignature', signature);

  if (normError) {
    console.error(`❌ Error deleting normalized trade: ${normError.message}`);
    process.exit(1);
  }

  // Delete from Trade table
  const { error: tradeError } = await supabase
    .from(TABLES.TRADE)
    .delete()
    .eq('txSignature', signature);

  if (tradeError) {
    console.error(`❌ Error deleting trade: ${tradeError.message}`);
    process.exit(1);
  }

  console.log(`✅ Trade deleted successfully!\n`);
}

const signature = process.argv[2];

if (!signature) {
  console.error('Usage: pnpm delete-trade <signature>');
  process.exit(1);
}

deleteTrade(signature).catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

