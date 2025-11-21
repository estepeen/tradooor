import dotenv from 'dotenv';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { SolanaCollectorService } from '../services/solana-collector.service.js';

dotenv.config();

/**
 * Worker script pro Solana Collector
 * 
 * Spustí periodický sběr transakcí pro všechny tracked wallets.
 * 
 * Použití:
 *   pnpm --filter backend solana:collector
 *   nebo
 *   pnpm --filter backend collector:start
 * 
 * Pro backfill historických dat:
 *   pnpm --filter backend collector:backfill WALLET_ADDRESS [LIMIT]
 *   pnpm --filter backend collector:backfill-all [LIMIT]
 * 
 * Pro jednorázové zpracování všech wallets (kontrola nových trades):
 *   pnpm --filter backend collector:process-all
 */
async function main() {
  // Global kill-switch: do not run unless explicitly enabled
  const trackingEnabled =
    process.env.TRACKING_ENABLED === 'true' ||
    process.env.COLLECTOR_ENABLED === 'true';
  if (!trackingEnabled) {
    console.log('🛑 Collector disabled. Set TRACKING_ENABLED=true (or COLLECTOR_ENABLED=true) to run.');
    process.exit(0);
  }

  const command = process.argv[2];
  // For 'backfill', second arg is walletAddress, third is limit
  // For 'backfill-all', second arg is limit (no walletAddress)
  // For 'test-tx', second arg is walletAddress, third is txSignature
  const walletAddress = (command === 'backfill' || command === 'test-tx') ? process.argv[3] : undefined;
  const limit = command === 'backfill-all' 
    ? (process.argv[3] ? parseInt(process.argv[3]) : 100)
    : (process.argv[4] ? parseInt(process.argv[4]) : 100);

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
      // ⚠️ AUTOMATICKÝ COLLECTOR JE VYPNUTÝ - používáme webhook!
      console.warn('⚠️  Automatic collector is DISABLED. We use webhook for real-time notifications.');
      console.warn('   This saves API credits and is more efficient.');
      console.warn('   The start() method will only show this warning and exit.');
      collector.start(); // This will just show warning and return
      
      // Exit immediately - no need to keep process running
      console.log('   Exiting...');
      process.exit(0);
      
    } else if (command === 'test-tx') {
      // Test konkrétní transakce
      const txSignature = process.argv[4];
      if (!txSignature || !walletAddress) {
        console.error('❌ Error: walletAddress and txSignature are required for test-tx command');
        console.log('Usage: tsx src/workers/solana-collector.ts test-tx WALLET_ADDRESS TX_SIGNATURE');
        process.exit(1);
      }
      console.log(`🧪 Testing transaction: ${txSignature}`);
      console.log(`   Wallet: ${walletAddress}`);
      const hadTrade = await (collector as any).processTransaction(txSignature, walletAddress);
      console.log(`   Result: ${hadTrade ? '✅ Trade found and saved' : '❌ No trade detected'}`);
    } else if (command === 'backfill') {
      if (!walletAddress) {
        console.error('❌ Error: walletAddress is required for backfill command');
        console.log('Usage: pnpm --filter backend collector:backfill WALLET_ADDRESS [LIMIT]');
        process.exit(1);
      }
      // Backfill single wallet
      console.log(`📥 Backfilling ${limit} historical transactions for wallet: ${walletAddress}...`);
      await collector.fetchHistoricalTransactions(walletAddress, limit);
      console.log('✅ Backfill completed');
    } else if (command === 'backfill-all') {
      // Backfill all wallets
      console.log(`📥 Backfilling ${limit} historical transactions for ALL wallets...`);
      
      const walletsResult = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
      const wallets = walletsResult.wallets || [];
      
      if (wallets.length === 0) {
        console.log('⚠️  No wallets found in database');
        process.exit(1);
      }

      console.log(`📊 Found ${wallets.length} wallets to process`);

      const results = {
        total: wallets.length,
        success: 0,
        failed: 0,
        errors: [] as Array<{ wallet: string; error: string }>,
      };

      for (const wallet of wallets) {
        try {
          console.log(`\n📥 Processing wallet ${results.success + results.failed + 1}/${wallets.length}: ${wallet.address} (${wallet.label || 'no label'})`);
          await collector.fetchHistoricalTransactions(wallet.address, limit);
          results.success++;
          
          // Longer delay between wallets to avoid rate limiting (free RPC has strict limits)
          // Increased for overnight runs - slow but reliable
          await new Promise(resolve => setTimeout(resolve, 10000));
        } catch (error: any) {
          console.error(`❌ Error backfilling wallet ${wallet.address}:`, error.message);
          results.failed++;
          results.errors.push({
            wallet: wallet.address,
            error: error.message || 'Unknown error',
          });
        }
      }

      console.log(`\n✅ Backfill completed:`);
      console.log(`   - Total wallets: ${results.total}`);
      console.log(`   - Success: ${results.success}`);
      console.log(`   - Failed: ${results.failed}`);
      if (results.errors.length > 0) {
        console.log(`\n❌ Errors:`);
        results.errors.forEach(err => {
          console.log(`   - ${err.wallet}: ${err.error}`);
        });
      }
    } else if (command === 'process-all') {
      // ⚠️ VAROVÁNÍ: Tento command spotřebovává Helius API kredity!
      console.warn('⚠️  WARNING: This command will consume Helius API credits!');
      console.warn('   We recommend using webhook for real-time notifications instead.');
      console.warn('   This is useful only for manual refresh or when webhook is not working.');
      console.warn('   Press Ctrl+C within 5 seconds to cancel...');
      
      // Wait 5 seconds before proceeding
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Process all wallets once (check for new trades)
      console.log(`🔄 Processing all wallets to check for new trades...`);
      
      // Fetch all wallets (handle pagination if needed)
      let allWallets: any[] = [];
      let page = 1;
      const pageSize = 1000;
      let hasMore = true;
      
      while (hasMore) {
        const walletsResult = await smartWalletRepo.findAll({ page, pageSize });
        const wallets = walletsResult.wallets || [];
        allWallets = allWallets.concat(wallets);
        
        console.log(`   Loaded ${allWallets.length} wallets so far...`);
        
        // Check if there are more wallets
        hasMore = wallets.length === pageSize && allWallets.length < walletsResult.total;
        page++;
      }
      
      const wallets = allWallets;
      
      if (wallets.length === 0) {
        console.log('⚠️  No wallets found in database');
        process.exit(1);
      }

      console.log(`📊 Found ${wallets.length} wallets to process`);

      const results = {
        total: wallets.length,
        success: 0,
        failed: 0,
        totalProcessed: 0,
        totalTrades: 0,
        totalSkipped: 0,
        errors: [] as Array<{ wallet: string; error: string }>,
      };

      for (const wallet of wallets) {
        try {
          console.log(`\n🔄 Processing wallet ${results.success + results.failed + 1}/${wallets.length}: ${wallet.address} (${wallet.label || 'no label'})`);
          // Call private method via type casting
          const result = await (collector as any).processWallet(wallet.address);
          results.success++;
          results.totalProcessed += result.processed;
          results.totalTrades += result.trades;
          results.totalSkipped += result.skipped;
          console.log(`   ✅ Completed: ${result.trades} new trades, ${result.processed} processed, ${result.skipped} skipped`);
          
          // Longer delay between wallets to avoid rate limiting (5 seconds)
          await new Promise(resolve => setTimeout(resolve, 5000));
        } catch (error: any) {
          console.error(`   ❌ Error processing wallet ${wallet.address}:`, error.message);
          results.failed++;
          results.errors.push({
            wallet: wallet.address,
            error: error.message || 'Unknown error',
          });
        }
      }

      console.log(`\n✅ Processing completed:`);
      console.log(`   - Total wallets: ${results.total}`);
      console.log(`   - Success: ${results.success}`);
      console.log(`   - Failed: ${results.failed}`);
      console.log(`   - Total processed: ${results.totalProcessed}`);
      console.log(`   - Total new trades: ${results.totalTrades}`);
      console.log(`   - Total skipped: ${results.totalSkipped}`);
      if (results.errors.length > 0) {
        console.log(`\n❌ Errors:`);
        results.errors.forEach(err => {
          console.log(`   - ${err.wallet}: ${err.error}`);
        });
      }
    } else {
      console.log('Usage:');
      console.log('  Start collector:  pnpm --filter backend collector:start');
      console.log('  Backfill single wallet:  pnpm --filter backend collector:backfill WALLET_ADDRESS [LIMIT]');
      console.log('  Backfill all wallets:  pnpm --filter backend collector:backfill-all [LIMIT]');
      console.log('  Process all wallets once:  pnpm --filter backend collector:process-all');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
