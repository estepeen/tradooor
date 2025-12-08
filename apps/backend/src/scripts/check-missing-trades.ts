import 'dotenv/config';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';

const smartWalletRepo = new SmartWalletRepository();

async function checkMissingTrades(walletAddress: string) {
  console.log(`\n🔍 Checking trades for wallet: ${walletAddress}\n`);

  // 1. Find wallet
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }
  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})`);

  // 2. Get all trades from database
  const { data: trades, error: tradesError } = await supabase
    .from(TABLES.TRADE)
    .select(`
      *,
      token:${TABLES.TOKEN}(*)
    `)
    .eq('walletId', wallet.id)
    .order('timestamp', { ascending: false });

  if (tradesError) {
    console.error(`❌ Error fetching trades: ${tradesError.message}`);
    process.exit(1);
  }

  console.log(`\n📊 Total trades in database: ${trades?.length || 0}`);

  // 3. Group by token
  const tradesByToken = new Map<string, typeof trades>();
  if (trades) {
    for (const trade of trades) {
      const tokenSymbol = (trade.token as any)?.symbol || 'UNKNOWN';
      if (!tradesByToken.has(tokenSymbol)) {
        tradesByToken.set(tokenSymbol, []);
      }
      tradesByToken.get(tokenSymbol)!.push(trade);
    }
  }

  console.log(`\n📋 Trades by token:`);
  for (const [token, tokenTrades] of tradesByToken.entries()) {
    const buyCount = tokenTrades.filter(t => t.side === 'buy').length;
    const sellCount = tokenTrades.filter(t => t.side === 'sell').length;
    const voidCount = tokenTrades.filter(t => t.side === 'void').length;
    console.log(`   ${token}: ${tokenTrades.length} trades (${buyCount} BUY, ${sellCount} SELL, ${voidCount} VOID)`);
  }

  // 4. Check for NALA and POKEPALM specifically
  const nalaTrades = trades?.filter(t => 
    ((t.token as any)?.symbol || '').toUpperCase() === 'NALA'
  ) || [];
  const pokepalmTrades = trades?.filter(t => 
    ((t.token as any)?.symbol || '').toUpperCase().includes('POKEPALM') ||
    ((t.token as any)?.symbol || '').toUpperCase().includes('POKÉPALM')
  ) || [];

  console.log(`\n🎯 NALA trades: ${nalaTrades.length}`);
  if (nalaTrades.length > 0) {
    const lastNala = nalaTrades[0];
    console.log(`   Last NALA trade: ${new Date(lastNala.timestamp).toLocaleString()}`);
  }

  console.log(`\n🎯 POKEPALM trades: ${pokepalmTrades.length}`);
  if (pokepalmTrades.length > 0) {
    const lastPokepalm = pokepalmTrades[0];
    console.log(`   Last POKEPALM trade: ${new Date(lastPokepalm.timestamp).toLocaleString()}`);
  }

  // 5. Find trades between NALA and POKEPALM
  if (nalaTrades.length > 0 && pokepalmTrades.length > 0) {
    const nalaTime = new Date(nalaTrades[0].timestamp).getTime();
    const pokepalmTime = new Date(pokepalmTrades[0].timestamp).getTime();
    
    const minTime = Math.min(nalaTime, pokepalmTime);
    const maxTime = Math.max(nalaTime, pokepalmTime);

    const tradesBetween = trades?.filter(t => {
      const tradeTime = new Date(t.timestamp).getTime();
      return tradeTime >= minTime && tradeTime <= maxTime;
    }) || [];

    console.log(`\n📊 Trades between NALA and POKEPALM: ${tradesBetween.length}`);
    console.log(`   Time range: ${new Date(minTime).toLocaleString()} - ${new Date(maxTime).toLocaleString()}`);
    
    const tradesBetweenByToken = new Map<string, number>();
    for (const trade of tradesBetween) {
      const tokenSymbol = ((trade.token as any)?.symbol || 'UNKNOWN').toUpperCase();
      tradesBetweenByToken.set(tokenSymbol, (tradesBetweenByToken.get(tokenSymbol) || 0) + 1);
    }
    
    console.log(`\n   Breakdown by token:`);
    for (const [token, count] of Array.from(tradesBetweenByToken.entries()).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${token}: ${count} trades`);
    }
  }

  // 6. Check normalized trades (might have failed processing)
  const { data: normalizedTrades, error: normError } = await supabase
    .from('NormalizedTrade')
    .select('*')
    .eq('walletId', wallet.id)
    .order('timestamp', { ascending: false });

  if (!normError && normalizedTrades) {
    const failed = normalizedTrades.filter(nt => nt.status === 'failed' || nt.status === 'error');
    const pending = normalizedTrades.filter(nt => nt.status === 'pending');
    
    console.log(`\n📦 Normalized trades:`);
    console.log(`   Total: ${normalizedTrades.length}`);
    console.log(`   Processed: ${normalizedTrades.filter(nt => nt.status === 'processed').length}`);
    console.log(`   Failed: ${failed.length}`);
    console.log(`   Pending: ${pending.length}`);
    
    if (failed.length > 0) {
      console.log(`\n   ⚠️  Failed normalized trades (first 10):`);
      for (const nt of failed.slice(0, 10)) {
        console.log(`     - ${nt.txSignature.substring(0, 16)}... ${nt.status} ${nt.error ? `: ${nt.error}` : ''}`);
      }
    }
  }

  // 7. Check for trades that might have been filtered out
  console.log(`\n🔍 Checking for potential filtering issues...`);
  const voidTrades = trades?.filter(t => t.side === 'void') || [];
  console.log(`   Void trades: ${voidTrades.length}`);
  
  const smallTrades = trades?.filter(t => {
    const valueUsd = Number(t.valueUsd || 0);
    return valueUsd > 0 && valueUsd < 1; // Trades under $1
  }) || [];
  console.log(`   Trades under $1: ${smallTrades.length}`);

  console.log(`\n✅ Analysis complete!\n`);
}

// Run script
const walletAddress = process.argv[2];

if (!walletAddress) {
  console.error('Usage: pnpm check-missing-trades <walletAddress>');
  console.error('Example: pnpm check-missing-trades 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f');
  process.exit(1);
}

checkMissingTrades(walletAddress).catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

