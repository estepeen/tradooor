/**
 * Background job pro doplnění market data do existujících ClosedLot záznamů
 * 
 * Tento job projde všechny ClosedLot záznamy, které nemají market data,
 * a doplní je z Birdeye API.
 * 
 * Použití:
 *   pnpm --filter backend enrich:closed-lots-market-data
 * 
 * Nebo jako cron job (každý den v 2:00):
 *   CRON_SCHEDULE="0 2 * * *" pnpm --filter backend enrich:closed-lots-market-data
 */

import 'dotenv/config';
import cron from 'node-cron';
import { supabase, TABLES } from '../lib/supabase.js';
import { TokenMarketDataService } from '../services/token-market-data.service.js';
import { TokenRepository } from '../repositories/token.repository.js';

const marketDataService = new TokenMarketDataService();
const tokenRepo = new TokenRepository();

interface ClosedLotWithToken {
  id: string;
  walletId: string;
  tokenId: string;
  entryTime: Date;
  exitTime: Date;
  entryMarketCap: number | null;
  exitMarketCap: number | null;
  entryLiquidity: number | null;
  exitLiquidity: number | null;
  entryVolume24h: number | null;
  exitVolume24h: number | null;
  tokenAgeAtEntryMinutes: number | null;
  tokenMintAddress: string | null;
}

async function enrichClosedLotsMarketData() {
  console.log(`\n🔄 [${new Date().toISOString()}] Starting market data enrichment for ClosedLot...\n`);

  try {
    // Get all ClosedLot records that need market data enrichment
    // We'll process in batches to avoid memory issues
    const BATCH_SIZE = 100;
    let offset = 0;
    let totalProcessed = 0;
    let totalEnriched = 0;
    let totalErrors = 0;

    while (true) {
      // Fetch batch of ClosedLot records that need enrichment
      // (those with null market data)
      const { data: closedLots, error: fetchError } = await supabase
        .from(TABLES.CLOSED_LOT)
        .select(`
          id,
          walletId,
          tokenId,
          entryTime,
          exitTime,
          entryMarketCap,
          exitMarketCap,
          entryLiquidity,
          exitLiquidity,
          entryVolume24h,
          exitVolume24h,
          tokenAgeAtEntryMinutes
        `)
        .or('entryMarketCap.is.null,exitMarketCap.is.null,entryLiquidity.is.null,exitLiquidity.is.null,entryVolume24h.is.null,exitVolume24h.is.null,tokenAgeAtEntryMinutes.is.null')
        .order('exitTime', { ascending: false })
        .range(offset, offset + BATCH_SIZE - 1);

      if (fetchError) {
        throw new Error(`Failed to fetch closed lots: ${fetchError.message}`);
      }

      if (!closedLots || closedLots.length === 0) {
        console.log(`\n✅ No more closed lots to enrich. Total processed: ${totalProcessed}`);
        break;
      }

      console.log(`\n📦 Processing batch ${Math.floor(offset / BATCH_SIZE) + 1} (${closedLots.length} closed lots)...`);

      // Get token mint addresses for this batch
      const tokenIds = [...new Set(closedLots.map((lot: any) => lot.tokenId))];
      const { data: tokens } = await supabase
        .from(TABLES.TOKEN)
        .select('id, mintAddress')
        .in('id', tokenIds);

      const tokenMap = new Map<string, string>();
      (tokens || []).forEach((token: any) => {
        tokenMap.set(token.id, token.mintAddress);
      });

      // Process each closed lot
      for (const lot of closedLots) {
        try {
          const mintAddress = tokenMap.get(lot.tokenId);
          if (!mintAddress) {
            console.warn(`   ⚠️  Skipping closed lot ${lot.id}: no mint address for token ${lot.tokenId}`);
            totalErrors++;
            continue;
          }

          const entryTime = new Date(lot.entryTime);
          const exitTime = new Date(lot.exitTime);

          // Check what data we need to fetch
          const needsEntryData = !lot.entryMarketCap || !lot.entryLiquidity || !lot.entryVolume24h || !lot.tokenAgeAtEntryMinutes;
          const needsExitData = !lot.exitMarketCap || !lot.exitLiquidity || !lot.exitVolume24h;

          let entryMarketData: any = null;
          let exitMarketData: any = null;

          // Fetch market data if needed
          if (needsEntryData || needsExitData) {
            try {
              if (needsEntryData) {
                entryMarketData = await marketDataService.getMarketData(mintAddress, entryTime);
              }
              if (needsExitData) {
                exitMarketData = await marketDataService.getMarketData(mintAddress, exitTime);
              }
            } catch (error: any) {
              console.warn(`   ⚠️  Failed to fetch market data for closed lot ${lot.id}: ${error.message}`);
              totalErrors++;
              continue;
            }
          }

          // Prepare update data
          const updateData: any = {};
          
          if (entryMarketData) {
            if (!lot.entryMarketCap) updateData.entryMarketCap = entryMarketData.marketCap?.toString() || null;
            if (!lot.entryLiquidity) updateData.entryLiquidity = entryMarketData.liquidity?.toString() || null;
            if (!lot.entryVolume24h) updateData.entryVolume24h = entryMarketData.volume24h?.toString() || null;
            if (!lot.tokenAgeAtEntryMinutes) updateData.tokenAgeAtEntryMinutes = entryMarketData.tokenAgeMinutes || null;
          }
          
          if (exitMarketData) {
            if (!lot.exitMarketCap) updateData.exitMarketCap = exitMarketData.marketCap?.toString() || null;
            if (!lot.exitLiquidity) updateData.exitLiquidity = exitMarketData.liquidity?.toString() || null;
            if (!lot.exitVolume24h) updateData.exitVolume24h = exitMarketData.volume24h?.toString() || null;
          }

          // Update closed lot if we have new data
          if (Object.keys(updateData).length > 0) {
            const { error: updateError } = await supabase
              .from(TABLES.CLOSED_LOT)
              .update(updateData)
              .eq('id', lot.id);

            if (updateError) {
              console.warn(`   ⚠️  Failed to update closed lot ${lot.id}: ${updateError.message}`);
              totalErrors++;
            } else {
              totalEnriched++;
              if (totalEnriched % 10 === 0) {
                console.log(`   ✅ Enriched ${totalEnriched} closed lots...`);
              }
            }
          }

          totalProcessed++;

          // Small delay to respect rate limits
          await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay between requests
        } catch (error: any) {
          console.error(`   ❌ Error processing closed lot ${lot.id}: ${error.message}`);
          totalErrors++;
        }
      }

      offset += BATCH_SIZE;

      // If we got less than BATCH_SIZE, we're done
      if (closedLots.length < BATCH_SIZE) {
        break;
      }
    }

    console.log(`\n✅ Market data enrichment complete!`);
    console.log(`   Total processed: ${totalProcessed}`);
    console.log(`   Total enriched: ${totalEnriched}`);
    console.log(`   Total errors: ${totalErrors}\n`);
  } catch (error: any) {
    console.error('❌ Error in market data enrichment:', error);
    throw error;
  }
}

async function main() {
  const cronSchedule = process.env.CRON_SCHEDULE;
  
  if (cronSchedule) {
    // Run as cron job
    console.log(`🚀 Starting market data enrichment cron job`);
    console.log(`📅 Schedule: ${cronSchedule}`);
    console.log(`⏰ Next run will be scheduled according to cron expression\n`);

    cron.schedule(cronSchedule, async () => {
      await enrichClosedLotsMarketData();
    });

    // Keep process alive
    console.log('⏳ Waiting for cron schedule...\n');
  } else {
    // Run once immediately
    await enrichClosedLotsMarketData();
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
