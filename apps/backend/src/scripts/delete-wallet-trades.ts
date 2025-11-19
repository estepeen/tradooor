/**
 * Script to delete all trades for a specific wallet
 * WARNING: This will permanently delete all trade data for the specified wallet!
 */

import 'dotenv/config';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';

async function main() {
  const walletAddress = process.argv[2];

  if (!walletAddress) {
    console.error('❌ Usage: pnpm --filter @solbot/backend trades:delete-wallet <WALLET_ADDRESS>');
    process.exit(1);
  }

  const smartWalletRepo = new SmartWalletRepository();

  try {
    const wallet = await smartWalletRepo.findByAddress(walletAddress);
    if (!wallet) {
      console.error(`❌ Wallet not found in DB: ${walletAddress}`);
      process.exit(1);
    }

    console.log(`🧹 Deleting all trades for wallet ${wallet.address} (${wallet.id})...`);

    // Count existing trades
    const { count: existingCount } = await supabase
      .from(TABLES.TRADE)
      .select('id', { count: 'exact', head: true })
      .eq('walletId', wallet.id);

    // Delete all trades for this wallet
    const { error: deleteError } = await supabase
      .from(TABLES.TRADE)
      .delete()
      .eq('walletId', wallet.id);

    if (deleteError) {
      throw new Error(`Failed to delete trades: ${deleteError.message}`);
    }

    console.log(`   ✅ Deleted ${existingCount ?? 0} trades.`);

    // Also delete closed lots for this wallet
    const { count: closedLotsCount } = await supabase
      .from(TABLES.CLOSED_LOT)
      .select('id', { count: 'exact', head: true })
      .eq('walletId', wallet.id);

    const { error: deleteClosedLotsError } = await supabase
      .from(TABLES.CLOSED_LOT)
      .delete()
      .eq('walletId', wallet.id);

    if (deleteClosedLotsError) {
      console.warn(`   ⚠️  Failed to delete closed lots: ${deleteClosedLotsError.message}`);
    } else {
      console.log(`   ✅ Deleted ${closedLotsCount ?? 0} closed lots.`);
    }

    console.log('✅ All trades and closed lots deleted successfully.');
  } catch (error: any) {
    console.error('❌ Error deleting trades:', error?.message || error);
    process.exit(1);
  }
}

main();


