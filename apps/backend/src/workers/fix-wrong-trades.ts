/**
 * Script pro opravu špatně detekovaných tradeů
 * 
 * Problém: Když někdo prodá token za SOL, který se převádí na USDC,
 * systém to někdy detekuje jako BUY USDC místo SELL tokenu.
 * 
 * Tento script:
 * 1. Najde špatně detekované trendy (BUY base tokenů jako USDC/USDT/SOL)
 * 2. Smaže je z databáze
 * 3. Spustí backfill znovu pro danou walletku
 * 
 * Použití:
 *   pnpm --filter backend fix:trades WALLET_ADDRESS
 *   pnpm --filter backend fix:trades WALLET_ADDRESS --delete-only  (jen smazat, bez backfill)
 */

import dotenv from 'dotenv';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { SolanaCollectorService } from '../services/solana-collector.service.js';

dotenv.config();

const BASE_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // SOL/WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

async function main() {
  // Získej walletAddress a deleteOnly flag
  // process.argv[2] je "fix:trades" nebo script path, process.argv[3] je walletAddress
  // Pokud je argument "--delete-only", přeskočíme ho a vezmeme předchozí jako walletAddress
  const args = process.argv.slice(2);
  const deleteOnlyIndex = args.indexOf('--delete-only');
  const deleteOnly = deleteOnlyIndex !== -1;
  
  // Najdi walletAddress (první argument, který není --delete-only)
  const walletAddressArg = args.find(arg => arg !== '--delete-only' && !arg.endsWith('.ts'));
  const walletAddress = walletAddressArg;

  if (!walletAddress) {
    console.error('❌ Error: walletAddress is required');
    console.log('Usage: pnpm --filter backend fix:trades WALLET_ADDRESS [--delete-only]');
    process.exit(1);
  }

  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();
  const tokenRepo = new TokenRepository();

  console.log(`🔍 Finding wallet: ${walletAddress}...`);
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }

  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})\n`);

  // 1. Najdi všechny trendy pro tuto walletku
  console.log('📊 Fetching all trades...');
  const allTrades = await tradeRepo.findByWalletId(wallet.id, {
    page: 1,
    pageSize: 10000,
  });

  console.log(`   Found ${allTrades.total} trades\n`);

  // 2. Najdi špatně detekované trendy (BUY base tokenů)
  console.log('🔍 Finding incorrectly detected trades (BUY base tokens)...');
  const wrongTrades: any[] = [];

  for (const trade of allTrades.trades) {
    if (trade.side === 'buy') {
      const token = (trade as any).token;
      if (token && token.mintAddress && BASE_MINTS.has(token.mintAddress)) {
        // BUY base tokenu (USDC/USDT/SOL) - to je pravděpodobně špatně
        wrongTrades.push(trade);
      }
    }
  }

  if (wrongTrades.length === 0) {
    console.log('✅ No incorrectly detected trades found!');
    process.exit(0);
  }

  console.log(`   Found ${wrongTrades.length} potentially wrong trades:\n`);

  // Zobraz špatné trendy
  for (const trade of wrongTrades) {
    const token = (trade as any).token;
    const date = new Date(trade.timestamp).toISOString();
    console.log(`   - ${date}: BUY ${token?.symbol || token?.mintAddress?.substring(0, 8)}... (${trade.txSignature.substring(0, 16)}...)`);
  }

  console.log(`\n⚠️  These trades will be DELETED from database.`);
  console.log(`   This will allow collector to reprocess them with correct detection.\n`);

  if (deleteOnly) {
    console.log('🗑️  Deleting wrong trades (--delete-only mode, no backfill)...\n');
  } else {
    console.log('🗑️  Deleting wrong trades and running backfill...\n');
  }

  // 3. Smaž špatné trendy
  let deleted = 0;
  for (const trade of wrongTrades) {
    const { error } = await supabase
      .from(TABLES.TRADE)
      .delete()
      .eq('id', trade.id);

    if (error) {
      console.error(`   ❌ Error deleting trade ${trade.id}: ${error.message}`);
    } else {
      deleted++;
      console.log(`   ✅ Deleted: ${trade.txSignature.substring(0, 16)}...`);
    }
  }

  console.log(`\n✅ Deleted ${deleted}/${wrongTrades.length} trades\n`);

  if (deleteOnly) {
    console.log('✅ Done! Run backfill manually:');
    console.log(`   pnpm --filter backend collector:backfill ${walletAddress} 100\n`);
    process.exit(0);
  }

  // 4. Spusť backfill znovu
  console.log('📥 Running backfill to reprocess transactions...\n');
  
  const collector = new SolanaCollectorService(
    smartWalletRepo,
    tradeRepo,
    tokenRepo
  );

  try {
    await collector.fetchHistoricalTransactions(walletAddress, 100);
    console.log('\n✅ Backfill completed!');
    console.log('   Trades should now be detected correctly.\n');
  } catch (error: any) {
    console.error(`\n❌ Error during backfill: ${error.message}`);
    console.log('\n💡 You can run backfill manually:');
    console.log(`   pnpm --filter backend collector:backfill ${walletAddress} 100\n`);
    process.exit(1);
  }
}

main();

