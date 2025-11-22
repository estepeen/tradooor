import dotenv from 'dotenv';

dotenv.config();

async function testBirdeyeAPI() {
  console.log('🧪 Testing Birdeye API...\n');

  const birdeyeApiKey = process.env.BIRDEYE_API_KEY;
  if (!birdeyeApiKey) {
    console.error('❌ BIRDEYE_API_KEY is not set in .env');
    console.log('💡 Add BIRDEYE_API_KEY=your_key to .env file');
    return;
  }

  console.log(`✅ BIRDEYE_API_KEY found (length: ${birdeyeApiKey.length})\n`);

  // Test s známými tokeny
  const testTokens = [
    { mint: 'So11111111111111111111111111111111111111112', name: 'SOL (Wrapped)' },
    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'USDC' },
    { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', name: 'USDT' },
  ];

  for (const testToken of testTokens) {
    console.log(`🔍 Testing ${testToken.name} (${testToken.mint.substring(0, 16)}...)...`);
    
    try {
      const url = `https://public-api.birdeye.so/v1/token/meta?address=${testToken.mint}`;
      const response = await fetch(url, {
        headers: {
          'X-API-KEY': birdeyeApiKey,
        },
      });

      if (!response.ok) {
        const text = await response.text();
        console.log(`   ❌ API request failed: ${response.status} ${response.statusText}`);
        console.log(`   Response: ${text.substring(0, 200)}...`);
        if (response.status === 401) {
          console.log('   ⚠️  Invalid API key');
        }
        continue;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        console.log(`   ⚠️  Response is not JSON: ${contentType}`);
        console.log(`   Response: ${text.substring(0, 200)}...`);
        continue;
      }

      const data = await response.json() as { success?: boolean; data?: { symbol?: string; name?: string; decimals?: number } };
      
      if (data.success && data.data) {
        console.log(`   ✅ Symbol: ${data.data.symbol || 'N/A'}`);
        console.log(`   ✅ Name: ${data.data.name || 'N/A'}`);
        console.log(`   ✅ Decimals: ${data.data.decimals || 'N/A'}\n`);
      } else {
        console.log(`   ⚠️  No data returned\n`);
      }
    } catch (error: any) {
      console.log(`   ❌ Error: ${error.message}\n`);
    }
  }

  // Test s nějakým tokenem z DB
  console.log('🔍 Testing with a token from database...');
  const { createClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    console.log('⚠️  Supabase credentials not found, skipping DB test');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data: recentTrade, error } = await supabase
    .from('Trade')
    .select(`
      *,
      token:Token(*)
    `)
    .order('timestamp', { ascending: false })
    .limit(1)
    .single();

  if (error || !recentTrade) {
    console.log('⚠️  No recent trades found');
    return;
  }

  const tokenMint = (recentTrade as any).token?.mintAddress;
  if (!tokenMint) {
    console.log('⚠️  No token mint found');
    return;
  }

  console.log(`   Testing token: ${tokenMint.substring(0, 16)}...`);
  
  try {
    const url = `https://public-api.birdeye.so/v1/token/meta?address=${tokenMint}`;
    const response = await fetch(url, {
      headers: {
        'X-API-KEY': birdeyeApiKey,
      },
    });

    if (!response.ok) {
      console.log(`   ❌ API request failed: ${response.status} ${response.statusText}`);
      return;
    }

    const data = await response.json() as { success?: boolean; data?: { symbol?: string; name?: string; decimals?: number } };
    
    if (data.success && data.data) {
      console.log(`   ✅ Symbol: ${data.data.symbol || 'N/A'}`);
      console.log(`   ✅ Name: ${data.data.name || 'N/A'}`);
      console.log(`   ✅ Decimals: ${data.data.decimals || 'N/A'}\n`);
    } else {
      console.log(`   ⚠️  Token not found on Birdeye (maybe it's a new token)\n`);
    }
  } catch (error: any) {
    console.log(`   ❌ Error: ${error.message}\n`);
  }
}

testBirdeyeAPI().catch(console.error);

