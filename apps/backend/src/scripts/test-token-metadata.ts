import dotenv from 'dotenv';
import { supabase, TABLES } from '../lib/supabase.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { HeliusClient } from '../services/helius-client.service.js';
import { TokenMetadataBatchService } from '../services/token-metadata-batch.service.js';

dotenv.config();

async function testTokenMetadata() {
  console.log('🧪 Testing token metadata fetching and updating...\n');

  const tokenRepo = new TokenRepository();
  const heliusClient = new HeliusClient(process.env.HELIUS_API_KEY);
  const tokenMetadataBatchService = new TokenMetadataBatchService(
    heliusClient,
    tokenRepo
  );

  // 1. Najdi tokeny bez symbolu nebo name
  console.log('📊 Finding tokens without symbol/name...');
  const { data: tokensWithoutMetadata, error: fetchError } = await supabase
    .from(TABLES.TOKEN)
    .select('*')
    .or('symbol.is.null,name.is.null')
    .limit(10);

  if (fetchError) {
    console.error('❌ Error fetching tokens:', fetchError);
    return;
  }

  if (!tokensWithoutMetadata || tokensWithoutMetadata.length === 0) {
    console.log('✅ No tokens without metadata found. Testing with recent trades...\n');
    
    // Zkus najít tokeny z recent trades
    const { data: recentTrades, error: tradesError } = await supabase
      .from(TABLES.TRADE)
      .select(`
        *,
        token:${TABLES.TOKEN}(*)
      `)
      .order('timestamp', { ascending: false })
      .limit(5);

    if (tradesError) {
      console.error('❌ Error fetching recent trades:', tradesError);
      return;
    }

    if (!recentTrades || recentTrades.length === 0) {
      console.log('⚠️  No recent trades found. Cannot test.');
      return;
    }

    const testMints = recentTrades
      .map((t: any) => t.token?.mintAddress)
      .filter(Boolean)
      .slice(0, 3);

    if (testMints.length === 0) {
      console.log('⚠️  No token mints found in recent trades.');
      return;
    }

    console.log(`\n🔍 Testing metadata fetch for ${testMints.length} tokens from recent trades:`);
    testMints.forEach((mint: string) => console.log(`   - ${mint.substring(0, 8)}...`));

    // Test fetch metadata
    console.log('\n📥 Fetching metadata...');
    const metadataMap = await tokenMetadataBatchService.getTokenMetadataBatch(testMints);

    console.log(`\n✅ Metadata fetched for ${metadataMap.size}/${testMints.length} tokens:\n`);
    for (const [mint, metadata] of metadataMap.entries()) {
      console.log(`   ${mint.substring(0, 16)}...`);
      console.log(`      Symbol: ${metadata.symbol || 'N/A'}`);
      console.log(`      Name: ${metadata.name || 'N/A'}`);
      console.log(`      Decimals: ${metadata.decimals || 'N/A'}\n`);
    }

    // Test findOrCreate with forceUpdate
    console.log('💾 Testing findOrCreate with forceUpdate=true...');
    for (const mint of testMints) {
      const metadata = metadataMap.get(mint) || {};
      const token = await tokenRepo.findOrCreate({
        mintAddress: mint,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals,
        forceUpdate: true,
      });

      console.log(`   ✅ Token ${mint.substring(0, 8)}...: ${token.symbol || token.name || 'N/A'}`);
    }

    // Verify in DB
    console.log('\n🔍 Verifying tokens in database...');
    const { data: updatedTokens, error: verifyError } = await supabase
      .from(TABLES.TOKEN)
      .select('*')
      .in('mintAddress', testMints);

    if (verifyError) {
      console.error('❌ Error verifying tokens:', verifyError);
      return;
    }

    console.log('\n📊 Final token state in DB:');
    updatedTokens?.forEach((token: any) => {
      console.log(`   ${token.mintAddress.substring(0, 16)}...`);
      console.log(`      Symbol: ${token.symbol || 'N/A'}`);
      console.log(`      Name: ${token.name || 'N/A'}`);
      console.log(`      Decimals: ${token.decimals || 'N/A'}\n`);
    });

    return;
  }

  console.log(`\n📊 Found ${tokensWithoutMetadata.length} tokens without metadata\n`);

  // 2. Zkus načíst metadata pro tyto tokeny
  const testMints = tokensWithoutMetadata
    .map((t: any) => t.mintAddress)
    .slice(0, 5);

  console.log(`🔍 Testing metadata fetch for ${testMints.length} tokens:`);
  testMints.forEach((mint: string) => console.log(`   - ${mint.substring(0, 8)}...`));

  console.log('\n📥 Fetching metadata...');
  const metadataMap = await tokenMetadataBatchService.getTokenMetadataBatch(testMints);

  console.log(`\n✅ Metadata fetched for ${metadataMap.size}/${testMints.length} tokens:\n`);
  for (const [mint, metadata] of metadataMap.entries()) {
    console.log(`   ${mint.substring(0, 16)}...`);
    console.log(`      Symbol: ${metadata.symbol || 'N/A'}`);
    console.log(`      Name: ${metadata.name || 'N/A'}`);
    console.log(`      Decimals: ${metadata.decimals || 'N/A'}\n`);
  }

  // 3. Test findOrCreate with forceUpdate
  console.log('💾 Testing findOrCreate with forceUpdate=true...');
  for (const mint of testMints) {
    const metadata = metadataMap.get(mint) || {};
    const token = await tokenRepo.findOrCreate({
      mintAddress: mint,
      symbol: metadata.symbol,
      name: metadata.name,
      decimals: metadata.decimals,
      forceUpdate: true,
    });

    console.log(`   ✅ Token ${mint.substring(0, 8)}...: ${token.symbol || token.name || 'N/A'}`);
  }

  // 4. Verify in DB
  console.log('\n🔍 Verifying tokens in database...');
  const { data: updatedTokens, error: verifyError } = await supabase
    .from(TABLES.TOKEN)
    .select('*')
    .in('mintAddress', testMints);

  if (verifyError) {
    console.error('❌ Error verifying tokens:', verifyError);
    return;
  }

  console.log('\n📊 Final token state in DB:');
  updatedTokens?.forEach((token: any) => {
    console.log(`   ${token.mintAddress.substring(0, 16)}...`);
    console.log(`      Symbol: ${token.symbol || 'N/A'}`);
    console.log(`      Name: ${token.name || 'N/A'}`);
    console.log(`      Decimals: ${token.decimals || 'N/A'}\n`);
  });

  console.log('✅ Test completed!');
}

testTokenMetadata().catch(console.error);



