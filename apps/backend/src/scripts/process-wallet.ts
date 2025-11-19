import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { SolanaCollectorService } from '../services/solana-collector.service.js';

async function main() {
  const walletAddress = process.argv[2];

  if (!walletAddress) {
    console.error('❌ Usage: pnpm --filter @solbot/backend collector:process-wallet <WALLET_ADDRESS>');
    process.exit(1);
  }

  console.log(`🔄 Refreshing trades for wallet ${walletAddress}...`);

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

    const result = await (collector as any).processWallet(wallet.address);

    console.log('✅ Refresh completed:');
    console.log(`   Processed: ${result.processed}`);
    console.log(`   Trades: ${result.trades}`);
    console.log(`   Skipped: ${result.skipped}`);
  } catch (error: any) {
    console.error('❌ Error refreshing wallet trades:', error?.message || error);
    process.exit(1);
  }
}

main();


