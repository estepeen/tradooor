import 'dotenv/config';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { SolanaCollectorService } from '../services/solana-collector.service.js';

async function main() {
  const walletAddress = process.argv[2];
  const limitArg = process.argv[3];
  const limit = limitArg ? parseInt(limitArg, 10) : 300;

  if (!walletAddress) {
    console.error('❌ Usage: pnpm --filter @solbot/backend collector:reset-wallet <WALLET_ADDRESS> [LIMIT]');
    process.exit(1);
  }

  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();
  const tokenRepo = new TokenRepository();
  const collector = new SolanaCollectorService(smartWalletRepo, tradeRepo, tokenRepo);

  try {
    const wallet = await smartWalletRepo.findByAddress(walletAddress);
    if (!wallet) {
      console.error(`❌ Wallet not found in DB: ${walletAddress}`);
      process.exit(1);
    }

    console.log(`🧹 Deleting existing trades for wallet ${wallet.address} (${wallet.id})...`);
    const { count: existingCount } = await supabase
      .from(TABLES.TRADE)
      .select('id', { count: 'exact', head: true })
      .eq('walletId', wallet.id);

    const { error: deleteError } = await supabase
      .from(TABLES.TRADE)
      .delete()
      .eq('walletId', wallet.id);

    if (deleteError) {
      throw new Error(`Failed to delete trades: ${deleteError.message}`);
    }

    console.log(`   ✅ Deleted ${existingCount ?? 0} trades.`);

    console.log(`📥 Fetching fresh historical transactions (limit ${limit})...`);
    await collector.fetchHistoricalTransactions(wallet.address, limit);

    console.log('✅ Wallet trades refreshed successfully.');
  } catch (error: any) {
    console.error('❌ Error resetting wallet trades:', error?.message || error);
    process.exit(1);
  }
}

main();


