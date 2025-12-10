import 'dotenv/config';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();

/**
 * Compare our trades with Kolscan API for a specific wallet
 * This helps identify missing trades, especially fast ones
 */
async function compareWithKolscan(walletAddress: string) {
  console.log(`\n🔍 Comparing trades for wallet: ${walletAddress}\n`);

  const wallet = await smartWalletRepo.findByAddress(walletAddress);
  if (!wallet) {
    console.error(`❌ Wallet not found: ${walletAddress}`);
    process.exit(1);
  }
  console.log(`✅ Found wallet: ${wallet.label || wallet.address} (ID: ${wallet.id})`);

  // Get our trades
  const { trades: ourTrades, total: ourTotal } = await tradeRepo.findByWalletId(wallet.id, {
    pageSize: 10000,
  });
  console.log(`📊 Our trades in DB: ${ourTotal}\n`);

  // Group by timestamp to find patterns
  const tradesByMinute = new Map<string, number>();
  const tradesBySecond = new Map<string, number>();
  const voidTrades = ourTrades.filter(t => t.side === 'void');
  const buyTrades = ourTrades.filter(t => t.side === 'buy');
  const sellTrades = ourTrades.filter(t => t.side === 'sell');

  for (const trade of ourTrades) {
    const timestamp = new Date(trade.timestamp);
    const minuteKey = `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, '0')}-${String(timestamp.getDate()).padStart(2, '0')} ${String(timestamp.getHours()).padStart(2, '0')}:${String(timestamp.getMinutes()).padStart(2, '0')}`;
    const secondKey = `${minuteKey}:${String(timestamp.getSeconds()).padStart(2, '0')}`;
    
    tradesByMinute.set(minuteKey, (tradesByMinute.get(minuteKey) || 0) + 1);
    tradesBySecond.set(secondKey, (tradesBySecond.get(secondKey) || 0) + 1);
  }

  console.log(`📈 Trade breakdown:`);
  console.log(`   BUY: ${buyTrades.length}`);
  console.log(`   SELL: ${sellTrades.length}`);
  console.log(`   VOID: ${voidTrades.length}`);
  console.log(`   Total: ${ourTrades.length}\n`);

  // Find minutes/seconds with multiple trades (potential fast trading)
  const fastMinutes = Array.from(tradesByMinute.entries())
    .filter(([_, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const fastSeconds = Array.from(tradesBySecond.entries())
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  if (fastMinutes.length > 0) {
    console.log(`⚡ Top 10 minutes with most trades:`);
    for (const [minute, count] of fastMinutes) {
      console.log(`   ${minute}: ${count} trades`);
    }
    console.log('');
  }

  if (fastSeconds.length > 0) {
    console.log(`⚡ Top 20 seconds with multiple trades (fast trading):`);
    for (const [second, count] of fastSeconds) {
      console.log(`   ${second}: ${count} trades`);
    }
    console.log('');
  }

  // Check for gaps in trading (potential missing trades)
  const sortedTrades = [...ourTrades].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  if (sortedTrades.length > 1) {
    const gaps: Array<{ start: Date; end: Date; duration: number; tradesBefore: number; tradesAfter: number }> = [];
    
    for (let i = 0; i < sortedTrades.length - 1; i++) {
      const current = new Date(sortedTrades[i].timestamp);
      const next = new Date(sortedTrades[i + 1].timestamp);
      const gapMs = next.getTime() - current.getTime();
      const gapMinutes = gapMs / (1000 * 60);

      // Look for gaps longer than 1 hour but less than 24 hours (potential missing trades)
      if (gapMinutes > 60 && gapMinutes < 24 * 60) {
        // Check if there are trades before and after (not just start/end of dataset)
        if (i > 0 && i < sortedTrades.length - 2) {
          gaps.push({
            start: current,
            end: next,
            duration: gapMinutes,
            tradesBefore: i + 1,
            tradesAfter: sortedTrades.length - i - 1,
          });
        }
      }
    }

    if (gaps.length > 0) {
      console.log(`⏰ Found ${gaps.length} potential gaps (1-24 hours) that might indicate missing trades:`);
      for (const gap of gaps.slice(0, 10)) {
        console.log(`   ${gap.start.toLocaleString()} → ${gap.end.toLocaleString()} (${Math.round(gap.duration)} min gap)`);
      }
      console.log('');
    }
  }

  // Analyze void trades - these might be legitimate swaps that we're filtering out
  if (voidTrades.length > 0) {
    console.log(`🟣 VOID trades analysis:`);
    console.log(`   Total VOID: ${voidTrades.length}`);
    
    // Group void trades by token
    const voidByToken = new Map<string, number>();
    for (const trade of voidTrades) {
      const tokenSymbol = (trade.token as any)?.symbol || trade.tokenId.substring(0, 8);
      voidByToken.set(tokenSymbol, (voidByToken.get(tokenSymbol) || 0) + 1);
    }
    
    const topVoidTokens = Array.from(voidByToken.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    console.log(`   Top tokens with VOID trades:`);
    for (const [token, count] of topVoidTokens) {
      console.log(`     ${token}: ${count} VOID trades`);
    }
    console.log('');
  }

  // Check recent trades (last 24 hours)
  const now = Date.now();
  const last24h = now - (24 * 60 * 60 * 1000);
  const recentTrades = ourTrades.filter(t => new Date(t.timestamp).getTime() > last24h);
  
  console.log(`📅 Recent trades (last 24 hours): ${recentTrades.length}`);
  if (recentTrades.length > 0) {
    const recentBySide = {
      buy: recentTrades.filter(t => t.side === 'buy').length,
      sell: recentTrades.filter(t => t.side === 'sell').length,
      void: recentTrades.filter(t => t.side === 'void').length,
    };
    console.log(`   BUY: ${recentBySide.buy}, SELL: ${recentBySide.sell}, VOID: ${recentBySide.void}`);
  }
  console.log('');

  // Recommendations
  console.log(`💡 Recommendations:`);
  console.log(`   1. Check QuickNode webhook configuration - ensure it's set to send ALL transactions`);
  console.log(`   2. Review normalizeQuickNodeSwap logic - might be filtering legitimate swaps`);
  console.log(`   3. Check for rate limiting issues during high-frequency trading periods`);
  console.log(`   4. Consider backfilling from RPC for periods with gaps`);
  console.log(`   5. Review VOID trades - some might be legitimate swaps that should be processed\n`);

  console.log(`✅ Analysis complete!\n`);
}

const walletAddress = process.argv[2];
if (!walletAddress) {
  console.error('Usage: pnpm --filter backend compare-with-kolscan <walletAddress>');
  process.exit(1);
}

compareWithKolscan(walletAddress).catch(console.error);

