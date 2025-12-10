import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();

/**
 * Diagnostický script pro zjištění, proč některé wallets nemají trades
 */
async function diagnoseWallets() {
  console.log(`\n🔍 Diagnostika wallets - hledání problémů...\n`);

  // 1. Získat všechny wallets
  const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
  console.log(`📊 Celkem wallets v DB: ${allWallets.wallets.length}\n`);

  // 2. Pro každou wallet zjistit počet trades
  const walletsWithStats = await Promise.all(
    allWallets.wallets.map(async (wallet) => {
      const { total } = await tradeRepo.findByWalletId(wallet.id, { pageSize: 1 });
      return {
        ...wallet,
        tradeCount: total,
      };
    })
  );

  // 3. Rozdělit do kategorií
  const walletsWithTrades = walletsWithStats.filter(w => w.tradeCount > 0);
  const walletsWithoutTrades = walletsWithStats.filter(w => w.tradeCount === 0);

  console.log(`📈 Wallets s trades: ${walletsWithTrades.length}`);
  console.log(`❌ Wallets bez trades: ${walletsWithoutTrades.length}\n`);

  // 4. Analyzovat wallets bez trades
  if (walletsWithoutTrades.length > 0) {
    console.log(`\n🔴 WALLETS BEZ TRADES (prvních 20):`);
    console.log(`   Adresa | Label | Vytvořeno`);
    console.log(`   ${'-'.repeat(80)}`);
    
    for (const wallet of walletsWithoutTrades.slice(0, 20)) {
      const created = new Date(wallet.createdAt).toLocaleDateString();
      const label = wallet.label || 'N/A';
      console.log(`   ${wallet.address.substring(0, 16)}... | ${label.padEnd(20)} | ${created}`);
    }
    
    if (walletsWithoutTrades.length > 20) {
      console.log(`   ... a dalších ${walletsWithoutTrades.length - 20} wallets\n`);
    }
  }

  // 5. Zkontrolovat, jestli mají NormalizedTrades (možná se nezpracovaly)
  console.log(`\n🔍 Kontroluji NormalizedTrades pro wallets bez trades...\n`);
  
  const walletsWithNormalizedTrades: string[] = [];
  for (const wallet of walletsWithoutTrades.slice(0, 50)) { // Limit na 50 pro rychlost
    const { data: normalizedTrades } = await supabase
      .from('NormalizedTrade')
      .select('id')
      .eq('walletId', wallet.id)
      .limit(1);
    
    if (normalizedTrades && normalizedTrades.length > 0) {
      walletsWithNormalizedTrades.push(wallet.address);
    }
  }

  if (walletsWithNormalizedTrades.length > 0) {
    console.log(`⚠️  Nalezeno ${walletsWithNormalizedTrades.length} wallets s NormalizedTrades, ale bez Trade records:`);
    for (const addr of walletsWithNormalizedTrades.slice(0, 10)) {
      console.log(`   ${addr.substring(0, 16)}...`);
    }
    console.log(`\n   💡 Toto znamená, že webhooky fungují, ale NormalizedTrade → Trade processing selhává!\n`);
  }

  // 6. Zkontrolovat recent activity
  const now = Date.now();
  const last24h = now - (24 * 60 * 60 * 1000);
  const last7d = now - (7 * 24 * 60 * 60 * 1000);

  const recentTrades24h = walletsWithStats.filter(w => {
    if (!w.updatedAt) return false;
    return new Date(w.updatedAt).getTime() > last24h;
  });

  const recentTrades7d = walletsWithStats.filter(w => {
    if (!w.updatedAt) return false;
    return new Date(w.updatedAt).getTime() > last7d;
  });

  console.log(`📅 Aktivita:`);
  console.log(`   Wallets s aktivitou za posledních 24h: ${recentTrades24h.length}`);
  console.log(`   Wallets s aktivitou za posledních 7d: ${recentTrades7d.length}\n`);

  // 7. Statistika podle počtu trades
  const stats = {
    zero: walletsWithStats.filter(w => w.tradeCount === 0).length,
    '1-10': walletsWithStats.filter(w => w.tradeCount >= 1 && w.tradeCount <= 10).length,
    '11-50': walletsWithStats.filter(w => w.tradeCount >= 11 && w.tradeCount <= 50).length,
    '51-100': walletsWithStats.filter(w => w.tradeCount >= 51 && w.tradeCount <= 100).length,
    '101-500': walletsWithStats.filter(w => w.tradeCount >= 101 && w.tradeCount <= 500).length,
    '500+': walletsWithStats.filter(w => w.tradeCount > 500).length,
  };

  console.log(`📊 Rozdělení podle počtu trades:`);
  console.log(`   0 trades: ${stats.zero}`);
  console.log(`   1-10 trades: ${stats['1-10']}`);
  console.log(`   11-50 trades: ${stats['11-50']}`);
  console.log(`   51-100 trades: ${stats['51-100']}`);
  console.log(`   101-500 trades: ${stats['101-500']}`);
  console.log(`   500+ trades: ${stats['500+']}\n`);

  // 8. Doporučení
  console.log(`💡 DOPORUČENÍ:\n`);
  
  if (walletsWithoutTrades.length > walletsWithTrades.length) {
    console.log(`   ⚠️  VÍCE NEŽ POLOVINA WALLETS NEMÁ TRADES!`);
    console.log(`   Možné příčiny:`);
    console.log(`   1. QuickNode webhooky nejsou správně nastavené`);
    console.log(`   2. Webhooky neposílají všechny transakce`);
    console.log(`   3. normalizeQuickNodeSwap filtruje příliš mnoho transakcí`);
    console.log(`   4. Wallets nejsou aktivní (ale to by mělo být vidět na Kolscan)\n`);
  }

  if (walletsWithNormalizedTrades.length > 0) {
    console.log(`   ⚠️  NORMALIZEDTRADE → TRADE PROCESSING SELHÁVÁ!`);
    console.log(`   Spusť: pnpm --filter backend worker:normalized-trades`);
    console.log(`   Nebo zkontroluj, jestli worker běží\n`);
  }

  console.log(`   🔧 AKCE:`);
  console.log(`   1. Zkontroluj QuickNode webhook dashboard - jsou všechny wallets přidané?`);
  console.log(`   2. Spusť backfill pro wallets bez trades:`);
  console.log(`      pnpm --filter backend backfill-wallet-trades <walletAddress> 168`);
  console.log(`   3. Zkontroluj logy webhooků - přicházejí transakce?`);
  console.log(`   4. Zkontroluj, jestli NormalizedTrade worker běží\n`);

  // 9. Export seznamu wallets bez trades pro backfill
  if (walletsWithoutTrades.length > 0) {
    console.log(`📋 Seznam prvních 10 wallets bez trades pro backfill:`);
    console.log(`\n`);
    for (const wallet of walletsWithoutTrades.slice(0, 10)) {
      console.log(`pnpm --filter backend backfill-wallet-trades ${wallet.address} 168`);
    }
    console.log(`\n`);
  }

  console.log(`✅ Diagnostika dokončena!\n`);
}

diagnoseWallets().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

