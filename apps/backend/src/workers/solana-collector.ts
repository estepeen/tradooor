import dotenv from 'dotenv';
import { prisma } from '@solbot/db';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { SolanaCollectorService } from '../services/solana-collector.service.js';

dotenv.config();

/**
 * Worker script pro Solana Collector
 * 
 * Spustí listener, který sleduje transakce pro všechny tracked wallets.
 * 
 * Použití:
 *   pnpm --filter backend collector:start
 * 
 * Nebo pro backfill historických dat:
 *   pnpm --filter backend collector:backfill WALLET_ADDRESS [LIMIT]
 */
async function main() {
  const command = process.argv[2];
  const walletAddress = process.argv[3];
  const limit = process.argv[4] ? parseInt(process.argv[4]) : 100;

  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();
  const tokenRepo = new TokenRepository();
  const collector = new SolanaCollectorService(
    smartWalletRepo,
    tradeRepo,
    tokenRepo
  );

  try {
    if (command === 'start') {
      console.log('🚀 Starting Solana Collector...');
      await collector.start();
      
      // Keep process running
      process.on('SIGINT', async () => {
        console.log('\n🛑 Shutting down collector...');
        collector.stop();
        await prisma.$disconnect();
        process.exit(0);
      });

      // Keep alive
      setInterval(() => {
        // Heartbeat
      }, 60000);
      
    } else if (command === 'backfill' && walletAddress) {
      console.log(`📥 Backfilling historical transactions for ${walletAddress}...`);
      await collector.fetchHistoricalTransactions(walletAddress, limit);
      console.log('✅ Backfill completed');
      await prisma.$disconnect();
    } else {
      console.log('Usage:');
      console.log('  Start collector:  pnpm --filter backend collector:start');
      console.log('  Backfill wallet:  pnpm --filter backend collector:backfill WALLET_ADDRESS [LIMIT]');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();

