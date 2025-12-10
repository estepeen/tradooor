import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();

/**
 * Debug konkrétní wallet - zjistit, proč nemá trades
 */
async function debugWallet(walletAddress: string) {
  console.log(`\n🔍 Debugging wallet: ${walletAddress}\n`);

  // 1. Zkontrolovat, jestli je wallet v DB
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet NOT FOUND in database!`);
    console.log(`\n💡 Přidej wallet do DB:`);
    console.log(`   curl -X POST http://localhost:3001/api/smart-wallets \\`);
    console.log(`     -H "Content-Type: application/json" \\`);
    console.log(`     -d '{"address": "${walletAddress}"}'\n`);
    return;
  }

  console.log(`✅ Wallet found in DB:`);
  console.log(`   ID: ${wallet.id}`);
  console.log(`   Label: ${wallet.label || 'N/A'}`);
  console.log(`   Created: ${new Date(wallet.createdAt).toLocaleString()}`);
  console.log(`   Updated: ${new Date(wallet.updatedAt).toLocaleString()}\n`);

  // 2. Zkontrolovat trades
  const { trades, total } = await tradeRepo.findByWalletId(wallet.id, { pageSize: 10000 });
  console.log(`📊 Trades:`);
  console.log(`   Total: ${total}`);
  console.log(`   BUY: ${trades.filter(t => t.side === 'buy').length}`);
  console.log(`   SELL: ${trades.filter(t => t.side === 'sell').length}`);
  console.log(`   VOID: ${trades.filter(t => t.side === 'void').length}\n`);

  // 3. Zkontrolovat NormalizedTrades
  const { data: normalizedTrades, error: normError } = await supabase
    .from('NormalizedTrade')
    .select('id, txSignature, side, status, error, timestamp')
    .eq('walletId', wallet.id)
    .order('timestamp', { ascending: false })
    .limit(100);

  if (normError) {
    console.error(`❌ Error fetching NormalizedTrades: ${normError.message}\n`);
  } else {
    console.log(`📦 NormalizedTrades:`);
    console.log(`   Total: ${normalizedTrades?.length || 0}`);
    
    if (normalizedTrades && normalizedTrades.length > 0) {
      const byStatus = normalizedTrades.reduce((acc, nt) => {
        acc[nt.status] = (acc[nt.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      console.log(`   By status:`);
      for (const [status, count] of Object.entries(byStatus)) {
        console.log(`     ${status}: ${count}`);
      }

      const bySide = normalizedTrades.reduce((acc, nt) => {
        acc[nt.side] = (acc[nt.side] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      console.log(`   By side:`);
      for (const [side, count] of Object.entries(bySide)) {
        console.log(`     ${side}: ${count}`);
      }

      // Check for failed ones
      const failed = normalizedTrades.filter(nt => nt.status === 'failed');
      if (failed.length > 0) {
        console.log(`\n   ⚠️  Failed NormalizedTrades (${failed.length}):`);
        for (const nt of failed.slice(0, 5)) {
          console.log(`     ${nt.txSignature.substring(0, 16)}... - ${nt.error || 'unknown error'}`);
        }
      }

      // Check for pending ones
      const pending = normalizedTrades.filter(nt => nt.status === 'pending');
      if (pending.length > 0) {
        console.log(`\n   ⏳ Pending NormalizedTrades (${pending.length}):`);
        console.log(`     💡 These need to be processed by NormalizedTrade worker`);
        console.log(`     Spusť: pnpm --filter backend worker:normalized-trades\n`);
      }

      // Recent ones
      const recent = normalizedTrades.slice(0, 5);
      console.log(`\n   📅 Recent NormalizedTrades:`);
      for (const nt of recent) {
        const time = new Date(nt.timestamp).toLocaleString();
        console.log(`     ${time} - ${nt.side} - ${nt.status} - ${nt.txSignature.substring(0, 16)}...`);
      }
    } else {
      console.log(`   ⚠️  NO NormalizedTrades found!`);
      console.log(`   💡 This means webhook is NOT sending transactions for this wallet\n`);
    }
  }

  // 4. Zkontrolovat, jestli jsou trades v recent trades
  if (trades.length > 0) {
    const recent = trades.slice(0, 5);
    console.log(`\n📅 Recent Trades:`);
    for (const trade of recent) {
      const time = new Date(trade.timestamp).toLocaleString();
      const tokenSymbol = (trade.token as any)?.symbol || trade.tokenId.substring(0, 8);
      console.log(`   ${time} - ${trade.side} ${tokenSymbol} - ${trade.txSignature.substring(0, 16)}...`);
    }
  }

  // 5. Diagnostika
  console.log(`\n💡 DIAGNÓZA:\n`);

  if (total === 0) {
    if (normalizedTrades && normalizedTrades.length > 0) {
      const pending = normalizedTrades.filter(nt => nt.status === 'pending');
      const failed = normalizedTrades.filter(nt => nt.status === 'failed');
      
      if (pending.length > 0) {
        console.log(`   ⚠️  PROBLEM: ${pending.length} NormalizedTrades jsou pending - worker neběží nebo selhává!`);
        console.log(`   🔧 ŘEŠENÍ: Spusť worker: pnpm --filter backend worker:normalized-trades\n`);
      } else if (failed.length > 0) {
        console.log(`   ⚠️  PROBLEM: ${failed.length} NormalizedTrades selhaly při processing!`);
        console.log(`   🔧 ŘEŠENÍ: Zkontroluj chyby výše a oprav logiku valuation\n`);
      } else {
        console.log(`   ⚠️  PROBLEM: NormalizedTrades existují, ale nejsou zpracované do Trades`);
        console.log(`   🔧 ŘEŠENÍ: Zkontroluj NormalizedTrade worker\n`);
      }
    } else {
      console.log(`   ⚠️  PROBLEM: Žádné NormalizedTrades - webhook neposílá transakce pro tuto wallet!`);
      console.log(`   🔧 ŘEŠENÍ:`);
      console.log(`      1. Zkontroluj QuickNode webhook dashboard - je tato wallet přidaná?`);
      console.log(`      2. Zkontroluj, jestli webhook filtruje transakce (možná filtruje podle typu)`);
      console.log(`      3. Spusť backfill: pnpm --filter backend backfill-wallet-trades ${walletAddress} 168\n`);
    }
  } else {
    console.log(`   ✅ Wallet má trades - problém může být v:`);
    console.log(`      - Nechytáme všechny transakce (filtrujeme příliš mnoho)`);
    console.log(`      - normalizeQuickNodeSwap vrací null pro některé swapy`);
    console.log(`      - Webhook neposílá všechny transakce\n`);
  }

  console.log(`✅ Debug complete!\n`);
}

const walletAddress = process.argv[2];
if (!walletAddress) {
  console.error('Usage: pnpm --filter backend debug-wallet <walletAddress>');
  process.exit(1);
}

debugWallet(walletAddress).catch(console.error);

