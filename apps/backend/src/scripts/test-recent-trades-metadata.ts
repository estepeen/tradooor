import dotenv from 'dotenv';
import { supabase, TABLES } from '../lib/supabase.js';

dotenv.config();

async function testRecentTradesMetadata() {
  console.log('🧪 Testing recent trades endpoint with token metadata enrichment...\n');

  // Zkus najít recent trades
  const { data: recentTrades, error: tradesError } = await supabase
    .from(TABLES.TRADE)
    .select(`
      *,
      token:${TABLES.TOKEN}(*),
      wallet:${TABLES.SMART_WALLET}(id, address, label)
    `)
    .order('timestamp', { ascending: false })
    .limit(10);

  if (tradesError) {
    console.error('❌ Error fetching recent trades:', tradesError);
    return;
  }

  if (!recentTrades || recentTrades.length === 0) {
    console.log('⚠️  No recent trades found.');
    return;
  }

  console.log(`📊 Found ${recentTrades.length} recent trades\n`);

  // Zobraz tokeny před enrichment
  console.log('📋 Tokens BEFORE enrichment:');
  const uniqueTokens = new Map();
  recentTrades.forEach((trade: any) => {
    if (trade.token) {
      uniqueTokens.set(trade.token.mintAddress, trade.token);
    }
  });

  uniqueTokens.forEach((token: any) => {
    console.log(`   ${token.mintAddress.substring(0, 16)}...`);
    console.log(`      Symbol: ${token.symbol || 'N/A'}`);
    console.log(`      Name: ${token.name || 'N/A'}\n`);
  });

  // Zkus zavolat recent trades endpoint (simulace)
  console.log('🔗 Testing /api/trades/recent endpoint...');
  const apiUrl = process.env.API_URL || 'http://localhost:3001';
  const response = await fetch(`${apiUrl}/api/trades/recent?limit=10`);

  if (!response.ok) {
    console.error(`❌ API request failed: ${response.status} ${response.statusText}`);
    console.log('💡 Make sure backend is running: pnpm --filter backend dev');
    return;
  }

  const data = await response.json();
  console.log(`✅ API returned ${data.trades?.length || 0} trades\n`);

  // Zobraz tokeny po enrichment
  if (data.trades && data.trades.length > 0) {
    console.log('📋 Tokens AFTER enrichment (from API):');
    const enrichedTokens = new Map();
    data.trades.forEach((trade: any) => {
      if (trade.token) {
        enrichedTokens.set(trade.token.mintAddress, trade.token);
      }
    });

    enrichedTokens.forEach((token: any) => {
      console.log(`   ${token.mintAddress.substring(0, 16)}...`);
      console.log(`      Symbol: ${token.symbol || 'N/A'}`);
      console.log(`      Name: ${token.name || 'N/A'}\n`);
    });

    // Porovnej
    console.log('📊 Comparison:');
    let improved = 0;
    enrichedTokens.forEach((enrichedToken: any, mint: string) => {
      const originalToken = uniqueTokens.get(mint);
      if (originalToken) {
        const hadSymbol = originalToken.symbol && originalToken.symbol !== 'N/A';
        const hasSymbol = enrichedToken.symbol && enrichedToken.symbol !== 'N/A';
        if (!hadSymbol && hasSymbol) {
          improved++;
          console.log(`   ✅ ${mint.substring(0, 16)}... got symbol: ${enrichedToken.symbol}`);
        }
      }
    });

    if (improved === 0) {
      console.log('   ⚠️  No tokens were enriched (maybe Birdeye API key is missing or tokens are not on Birdeye)');
    } else {
      console.log(`   ✅ ${improved} token(s) were enriched with metadata`);
    }
  }
}

testRecentTradesMetadata().catch(console.error);

