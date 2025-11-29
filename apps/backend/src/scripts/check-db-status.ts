import { supabase, TABLES } from '../lib/supabase.js';
import dotenv from 'dotenv';

dotenv.config();

async function checkDatabaseStatus() {
  console.log('🔍 Checking database status...\n');

  // 1. Check total wallets
  console.log('1. Checking wallets...');
  const { data: wallets, error: walletsError } = await supabase
    .from(TABLES.SMART_WALLET)
    .select('id, address, label, score, totalTrades, winRate, recentPnl30dUsd, recentPnl30dPercent')
    .limit(10);

  if (walletsError) {
    console.error('❌ Error fetching wallets:', walletsError);
  } else {
    console.log(`   Found ${wallets?.length || 0} wallets (showing first 10)`);
    
    if (wallets && wallets.length > 0) {
      console.log('\n   Sample wallet data:');
      wallets.slice(0, 5).forEach((w: any) => {
        console.log(`   - ${w.address}: score=${w.score}, trades=${w.totalTrades}, winRate=${w.winRate}, pnl30d=${w.recentPnl30dUsd}`);
      });
      
      // Check if all values are 0
      const allZero = wallets.every((w: any) => 
        (w.score === 0 || w.score === null) &&
        (w.totalTrades === 0 || w.totalTrades === null) &&
        (w.recentPnl30dUsd === 0 || w.recentPnl30dUsd === null)
      );
      
      if (allZero) {
        console.log('\n   ⚠️  All wallet metrics are 0!');
      }
    }
  }

  // 2. Check total trades
  console.log('\n2. Checking trades...');
  const { count: tradesCount, error: tradesError } = await supabase
    .from(TABLES.TRADE)
    .select('*', { count: 'exact', head: true });

  if (tradesError) {
    console.error('❌ Error counting trades:', tradesError);
  } else {
    console.log(`   Total trades in database: ${tradesCount || 0}`);
    
    if ((tradesCount || 0) === 0) {
      console.log('   ⚠️  No trades found in database! This is why metrics are 0.');
    } else {
      // Check recent trades
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const { count: recentTradesCount, error: recentTradesError } = await supabase
        .from(TABLES.TRADE)
        .select('*', { count: 'exact', head: true })
        .gte('timestamp', thirtyDaysAgo.toISOString());
      
      if (!recentTradesError) {
        console.log(`   Trades in last 30 days: ${recentTradesCount || 0}`);
      }
      
      // Sample trades
      const { data: sampleTrades, error: sampleError } = await supabase
        .from(TABLES.TRADE)
        .select('id, walletId, side, amountBase, timestamp')
        .order('timestamp', { ascending: false })
        .limit(5);
      
      if (!sampleError && sampleTrades && sampleTrades.length > 0) {
        console.log('\n   Recent trades sample:');
        sampleTrades.forEach((t: any) => {
          console.log(`   - ${t.side} ${t.amountBase} SOL at ${new Date(t.timestamp).toISOString()}`);
        });
      }
    }
  }

  // 3. Check closed lots
  console.log('\n3. Checking closed lots...');
  const { count: lotsCount, error: lotsError } = await supabase
    .from(TABLES.CLOSED_LOT)
    .select('*', { count: 'exact', head: true });

  if (lotsError) {
    console.error('❌ Error counting closed lots:', lotsError);
  } else {
    console.log(`   Total closed lots: ${lotsCount || 0}`);
    
    if ((lotsCount || 0) > 0) {
      const { data: sampleLots, error: sampleLotsError } = await supabase
        .from(TABLES.CLOSED_LOT)
        .select('walletId, realizedPnl, realizedPnlUsd, exitTime')
        .order('exitTime', { ascending: false })
        .limit(5);
      
      if (!sampleLotsError && sampleLots && sampleLots.length > 0) {
        console.log('\n   Recent closed lots sample:');
        sampleLots.forEach((lot: any) => {
          console.log(`   - PnL: ${lot.realizedPnl} SOL (${lot.realizedPnlUsd} USD) at ${new Date(lot.exitTime).toISOString()}`);
        });
      }
    }
  }

  // 4. Check metrics history
  console.log('\n4. Checking metrics history...');
  const { count: historyCount, error: historyError } = await supabase
    .from(TABLES.SMART_WALLET_METRICS_HISTORY)
    .select('*', { count: 'exact', head: true });

  if (historyError) {
    console.error('❌ Error counting metrics history:', historyError);
  } else {
    console.log(`   Total metrics history records: ${historyCount || 0}`);
    
    if ((historyCount || 0) === 0) {
      console.log('   ⚠️  No metrics history found! Metrics worker may not be running correctly.');
    }
  }

  console.log('\n✅ Database check complete!\n');
  
  // Summary
  console.log('📊 Summary:');
  console.log(`   - Wallets: ${wallets?.length || 0}`);
  console.log(`   - Trades: ${tradesCount || 0}`);
  console.log(`   - Closed lots: ${lotsCount || 0}`);
  console.log(`   - Metrics history: ${historyCount || 0}`);
  
  if ((tradesCount || 0) === 0) {
    console.log('\n⚠️  WARNING: No trades found in database!');
    console.log('   This is why all metrics are 0. Make sure:');
    console.log('   1. Webhooks are receiving trades from Helius');
    console.log('   2. Trades are being saved to database');
  } else if ((historyCount || 0) === 0 && (tradesCount || 0) > 0) {
    console.log('\n⚠️  WARNING: Trades exist but no metrics history!');
    console.log('   Metrics worker may not be calculating metrics correctly.');
    console.log('   Try running: pnpm --filter @solbot/backend metrics:cron');
  }
}

checkDatabaseStatus()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
