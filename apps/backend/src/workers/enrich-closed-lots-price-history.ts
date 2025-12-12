/**
 * Background job pro doplnění price history metrik do existujících ClosedLot záznamů
 * 
 * Tento job projde všechny ClosedLot záznamy a doplní:
 * - maxProfitPercent (přesný z price history)
 * - maxDrawdownPercent (přesný z price history)
 * - timeToMaxProfitMinutes (přesný z price history)
 * - exitReason (vylepšená detekce založená na price history)
 * 
 * Použití:
 *   pnpm --filter backend enrich:closed-lots-price-history
 * 
 * Nebo jako cron job (každý den v 3:00):
 *   CRON_SCHEDULE="0 3 * * *" pnpm --filter backend enrich:closed-lots-price-history
 */

import 'dotenv/config';
import cron from 'node-cron';
import { supabase, TABLES } from '../lib/supabase.js';
import { PriceHistoryService } from '../services/price-history.service.js';
import { TokenRepository } from '../repositories/token.repository.js';

const priceHistoryService = new PriceHistoryService();
const tokenRepo = new TokenRepository();

async function enrichClosedLotsPriceHistory() {
  console.log(`\n🔄 [${new Date().toISOString()}] Starting price history enrichment for ClosedLot...\n`);

  try {
    // Get all ClosedLot records that need price history enrichment
    // We'll process in batches to avoid memory issues
    const BATCH_SIZE = 50; // Smaller batch size because price history fetching is slower
    let offset = 0;
    let totalProcessed = 0;
    let totalEnriched = 0;
    let totalErrors = 0;

    while (true) {
      // Fetch batch of ClosedLot records
      // Focus on recent ones first (last 30 days) for better data quality
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const { data: closedLots, error: fetchError } = await supabase
        .from(TABLES.CLOSED_LOT)
        .select(`
          id,
          walletId,
          tokenId,
          entryPrice,
          exitPrice,
          entryTime,
          exitTime,
          realizedPnlPercent,
          maxProfitPercent,
          maxDrawdownPercent,
          timeToMaxProfitMinutes,
          exitReason
        `)
        .gte('exitTime', thirtyDaysAgo.toISOString())
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

          const entryPrice = Number(lot.entryPrice);
          const exitPrice = Number(lot.exitPrice);
          const entryTime = new Date(lot.entryTime);
          const exitTime = new Date(lot.exitTime);
          const realizedPnlPercent = Number(lot.realizedPnlPercent || 0);

          // Skip if we already have accurate data
          if (lot.maxProfitPercent && lot.maxDrawdownPercent && lot.timeToMaxProfitMinutes !== null && lot.exitReason) {
            continue;
          }

          // Calculate price metrics from price history
          const priceMetrics = await priceHistoryService.calculatePriceMetrics(
            entryPrice,
            exitPrice,
            entryTime,
            exitTime,
            mintAddress
          );

          // Detect exit reason based on price history
          const exitReason = priceHistoryService.detectExitReason(
            entryPrice,
            exitPrice,
            priceMetrics.maxProfitPercent,
            priceMetrics.maxDrawdownPercent,
            realizedPnlPercent
          );

          // Prepare update data
          const updateData: any = {};
          
          // Only update if we have better data
          if (!lot.maxProfitPercent || Math.abs(priceMetrics.maxProfitPercent) > Math.abs(Number(lot.maxProfitPercent || 0))) {
            updateData.maxProfitPercent = priceMetrics.maxProfitPercent.toString();
          }
          
          if (!lot.maxDrawdownPercent || priceMetrics.maxDrawdownPercent > Number(lot.maxDrawdownPercent || 0)) {
            updateData.maxDrawdownPercent = priceMetrics.maxDrawdownPercent.toString();
          }
          
          if (lot.timeToMaxProfitMinutes === null && priceMetrics.timeToMaxProfitMinutes !== null) {
            updateData.timeToMaxProfitMinutes = priceMetrics.timeToMaxProfitMinutes;
          }
          
          // Update exit reason if we have better detection
          if (!lot.exitReason || lot.exitReason === 'unknown') {
            updateData.exitReason = exitReason;
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

          // Delay to respect rate limits (price history fetching is slower)
          await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between requests
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

    console.log(`\n✅ Price history enrichment complete!`);
    console.log(`   Total processed: ${totalProcessed}`);
    console.log(`   Total enriched: ${totalEnriched}`);
    console.log(`   Total errors: ${totalErrors}\n`);
  } catch (error: any) {
    console.error('❌ Error in price history enrichment:', error);
    throw error;
  }
}

async function main() {
  const cronSchedule = process.env.CRON_SCHEDULE;
  
  if (cronSchedule) {
    // Run as cron job
    console.log(`🚀 Starting price history enrichment cron job`);
    console.log(`📅 Schedule: ${cronSchedule}`);
    console.log(`⏰ Next run will be scheduled according to cron expression\n`);

    cron.schedule(cronSchedule, async () => {
      await enrichClosedLotsPriceHistory();
    });

    // Keep process alive
    console.log('⏳ Waiting for cron schedule...\n');
  } else {
    // Run once immediately
    await enrichClosedLotsPriceHistory();
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
