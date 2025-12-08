import 'dotenv/config';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';

const smartWalletRepo = new SmartWalletRepository();

async function analyzeMissingTrades(walletAddress: string) {
  console.log(`\n🔍 Analyzing missing trades for wallet: ${walletAddress}\n`);

  // 1. Find wallet
  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }
  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})`);

  // 2. Get all trades ordered by timestamp
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

  console.log(`📊 Total trades in database: ${trades?.length || 0}`);

  // 3. Find NALA and POKEPALM trades
  const nalaTrades = trades?.filter(t => 
    ((t.token as any)?.symbol || '').toUpperCase() === 'NALA'
  ) || [];
  const pokepalmTrades = trades?.filter(t => 
    ((t.token as any)?.symbol || '').toUpperCase().includes('POKEPALM') ||
    ((t.token as any)?.symbol || '').toUpperCase().includes('POKÉPALM')
  ) || [];

  if (nalaTrades.length === 0 || pokepalmTrades.length === 0) {
    console.log(`\n⚠️  Need both NALA and POKEPALM trades to analyze gap`);
    return;
  }

  // 4. Find time range between first NALA and last POKEPALM (or vice versa)
  const nalaTimes = nalaTrades.map(t => new Date(t.timestamp).getTime());
  const pokepalmTimes = pokepalmTrades.map(t => new Date(t.timestamp).getTime());
  
  const minTime = Math.min(...nalaTimes, ...pokepalmTimes);
  const maxTime = Math.max(...nalaTimes, ...pokepalmTimes);

  console.log(`\n📅 Time range:`);
  console.log(`   From: ${new Date(minTime).toLocaleString()}`);
  console.log(`   To: ${new Date(maxTime).toLocaleString()}`);
  console.log(`   Duration: ${((maxTime - minTime) / (1000 * 60)).toFixed(0)} minutes`);

  // 5. Get all trades in this time range
  const tradesInRange = trades?.filter(t => {
    const tradeTime = new Date(t.timestamp).getTime();
    return tradeTime >= minTime && tradeTime <= maxTime;
  }) || [];

  console.log(`\n📊 Trades in time range: ${tradesInRange.length}`);

  // 6. Group by token and show timeline
  const tradesByToken = new Map<string, typeof trades>();
  for (const trade of tradesInRange) {
    const tokenSymbol = ((trade.token as any)?.symbol || 'UNKNOWN').toUpperCase();
    if (!tradesByToken.has(tokenSymbol)) {
      tradesByToken.set(tokenSymbol, []);
    }
    tradesByToken.get(tokenSymbol)!.push(trade);
  }

  console.log(`\n📋 Timeline of trades (sorted by time):`);
  const sortedTrades = [...tradesInRange].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (const trade of sortedTrades) {
    const tokenSymbol = ((trade.token as any)?.symbol || 'UNKNOWN').toUpperCase();
    const timestamp = new Date(trade.timestamp).toLocaleString();
    const valueUsd = Number(trade.valueUsd || 0);
    const side = trade.side.toUpperCase();
    console.log(`   ${timestamp} - ${side} ${tokenSymbol} - $${valueUsd.toFixed(2)}`);
  }

  // 7. Check normalized trades in this range
  const { data: normalizedTrades, error: normError } = await supabase
    .from('NormalizedTrade')
    .select('*')
    .eq('walletId', wallet.id)
    .gte('timestamp', new Date(minTime).toISOString())
    .lte('timestamp', new Date(maxTime).toISOString())
    .order('timestamp', { ascending: true });

  if (!normError && normalizedTrades) {
    console.log(`\n📦 Normalized trades in range: ${normalizedTrades.length}`);
    
    const byStatus = new Map<string, number>();
    for (const nt of normalizedTrades) {
      const status = nt.status || 'unknown';
      byStatus.set(status, (byStatus.get(status) || 0) + 1);
    }
    
    console.log(`   Status breakdown:`);
    for (const [status, count] of Array.from(byStatus.entries())) {
      console.log(`     ${status}: ${count}`);
    }

    // Check for failed ones
    const failed = normalizedTrades.filter(nt => nt.status === 'failed' || nt.status === 'error');
    if (failed.length > 0) {
      console.log(`\n   ⚠️  Failed normalized trades (first 10):`);
      for (const nt of failed.slice(0, 10)) {
        console.log(`     - ${new Date(nt.timestamp).toLocaleString()} ${nt.txSignature.substring(0, 16)}... ${nt.status} ${nt.error ? `: ${nt.error}` : ''}`);
      }
    }
  }

  // 8. Check for potential issues
  console.log(`\n🔍 Potential issues:`);
  
  // Check for very small trades that might be filtered
  const smallTrades = tradesInRange.filter(t => {
    const valueUsd = Number(t.valueUsd || 0);
    return valueUsd > 0 && valueUsd < 5; // Under $5
  });
  console.log(`   Trades under $5: ${smallTrades.length}`);

  // Check for void trades
  const voidTrades = tradesInRange.filter(t => t.side === 'void');
  console.log(`   Void trades: ${voidTrades.length}`);

  // Check time gaps
  const sortedByTime = [...tradesInRange].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  
  let maxGap = 0;
  let maxGapStart: Date | null = null;
  for (let i = 1; i < sortedByTime.length; i++) {
    const gap = new Date(sortedByTime[i].timestamp).getTime() - new Date(sortedByTime[i-1].timestamp).getTime();
    if (gap > maxGap) {
      maxGap = gap;
      maxGapStart = new Date(sortedByTime[i-1].timestamp);
    }
  }
  
  if (maxGap > 0) {
    console.log(`   Max time gap: ${(maxGap / (1000 * 60)).toFixed(0)} minutes (after ${maxGapStart?.toLocaleString()})`);
  }

  console.log(`\n✅ Analysis complete!\n`);
}

// Run script
const walletAddress = process.argv[2];

if (!walletAddress) {
  console.error('Usage: pnpm analyze-missing-trades <walletAddress>');
  console.error('Example: pnpm analyze-missing-trades 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f');
  process.exit(1);
}

analyzeMissingTrades(walletAddress).catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

