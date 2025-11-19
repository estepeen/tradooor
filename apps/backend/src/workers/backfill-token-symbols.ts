import dotenv from 'dotenv';
import { supabase, TABLES } from '../lib/supabase.js';
import { HeliusClient } from '../services/helius-client.service.js';
import { TokenMetadataService } from '../services/token-metadata.service.js';

dotenv.config();

/**
 * Jupiter Token List API helper
 */
async function getJupiterTokenList(): Promise<Map<string, { symbol: string; name: string; decimals?: number }>> {
  const tokenMap = new Map<string, { symbol: string; name: string; decimals?: number }>();
  
  try {
    const response = await fetch('https://token.jup.ag/all', {
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      console.warn('⚠️  Jupiter Token List API error:', response.status);
      return tokenMap;
    }

    const tokens = await response.json();
    const tokenList = Array.isArray(tokens) ? tokens : (tokens as any).tokens || (tokens as any).data || [];
    
    tokenList.forEach((token: any) => {
      if (token.address && token.symbol) {
        tokenMap.set(token.address, {
          symbol: token.symbol,
          name: token.name || token.symbol,
          decimals: token.decimals,
        });
      }
    });

    return tokenMap;
  } catch (error: any) {
    console.warn('⚠️  Error fetching Jupiter Token List:', error.message);
    return tokenMap;
  }
}

/**
 * Backfill token symbols a names pro všechny tokeny v databázi, které je nemají
 * 
 * Použití:
 *   pnpm --filter backend tsx src/workers/backfill-token-symbols.ts
 */
async function main() {
  console.log('🔄 Starting token symbols backfill...\n');

  const heliusClient = new HeliusClient(process.env.HELIUS_API_KEY);
  const tokenMetadataService = new TokenMetadataService(heliusClient);
  
  console.log('✅ TokenMetadataService initialized (Metaplex on-chain + Birdeye + Helius + Jupiter)');

  // Najdi všechny tokeny bez symbolu nebo name
  // Musíme použít .or() správně - v Supabase PostgREST to je 'symbol.is.null,name.is.null'
  const { data: allTokens, error: fetchAllError } = await supabase
    .from(TABLES.TOKEN)
    .select('id, mintAddress, symbol, name');

  if (fetchAllError) {
    console.error('❌ Error fetching tokens:', fetchAllError);
    process.exit(1);
  }

  // Filtruj tokeny bez symbolu nebo name
  const tokensWithoutSymbols = (allTokens || []).filter(
    token => !token.symbol && !token.name
  );

  if (!tokensWithoutSymbols || tokensWithoutSymbols.length === 0) {
    console.log('✅ All tokens already have symbols/names!');
    process.exit(0);
  }

  console.log(`📊 Found ${tokensWithoutSymbols.length} tokens without symbols/names\n`);

  // Batch size pro zpracování
  const BATCH_SIZE = 20; // Menší batch size kvůli Metaplex on-chain requests
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < tokensWithoutSymbols.length; i += BATCH_SIZE) {
    const batch = tokensWithoutSymbols.slice(i, i + BATCH_SIZE);
    const mintAddresses = batch.map(t => t.mintAddress);

    console.log(`\n📦 Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(tokensWithoutSymbols.length / BATCH_SIZE)} (${batch.length} tokens)...`);

    try {
      // Použij TokenMetadataService, který zkouší Metaplex on-chain > Birdeye > Helius > Jupiter
      const tokenInfoMap = await tokenMetadataService.getTokenMetadataBatch(mintAddresses);

      // Aktualizuj každý token v databázi
      for (const token of batch) {
        const tokenInfo = tokenInfoMap.get(token.mintAddress);
        
        if (!tokenInfo || (!tokenInfo.symbol && !tokenInfo.name)) {
          console.log(`   ⚠️  No symbol/name found for ${token.mintAddress.substring(0, 8)}...`);
          failed++;
          continue;
        }

        // Aktualizuj pouze pokud máme nová data
        const updateData: any = {};
        if (tokenInfo.symbol && !token.symbol) {
          updateData.symbol = tokenInfo.symbol;
        }
        if (tokenInfo.name && !token.name) {
          updateData.name = tokenInfo.name;
        }
        if (tokenInfo.decimals !== undefined) {
          updateData.decimals = tokenInfo.decimals;
        }

        if (Object.keys(updateData).length > 0) {
          const { error: updateError } = await supabase
            .from(TABLES.TOKEN)
            .update(updateData)
            .eq('mintAddress', token.mintAddress);

          if (updateError) {
            console.error(`   ❌ Error updating ${token.mintAddress.substring(0, 8)}...:`, updateError.message);
            failed++;
          } else {
            const symbolDisplay = tokenInfo.symbol ? `$${tokenInfo.symbol}` : tokenInfo.name || 'unknown';
            console.log(`   ✅ Updated ${token.mintAddress.substring(0, 8)}...: ${symbolDisplay}`);
            updated++;
          }
        } else {
          console.log(`   ⏭️  Skipped ${token.mintAddress.substring(0, 8)}... (no new data)`);
        }
      }

      // Delay mezi batch requests pro rate limiting
      if (i + BATCH_SIZE < tokensWithoutSymbols.length) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1s delay
      }
    } catch (error: any) {
      console.error(`   ❌ Error processing batch:`, error.message);
      failed += batch.length;
    }
  }

  console.log(`\n✅ Backfill completed:`);
  console.log(`   - Updated: ${updated}`);
  console.log(`   - Failed: ${failed}`);
  console.log(`   - Total: ${tokensWithoutSymbols.length}`);
}

main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

