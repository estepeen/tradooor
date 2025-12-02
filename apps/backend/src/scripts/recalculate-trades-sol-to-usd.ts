/**
 * Script to recalculate amountBase from SOL to USD for old trades
 * 
 * This script finds trades where:
 * - baseToken is SOL (from meta)
 * - amountBase seems to be in SOL (not USD) - detected by checking if value * SOL price > reasonable threshold
 * 
 * Then it converts amountBase from SOL to USD using historical SOL price from Binance API.
 * 
 * Usage:
 *   pnpm recalculate:trades-sol-to-usd [--dry-run]
 */

import 'dotenv/config';
import { TradeRepository } from '../repositories/trade.repository.js';
import { BinancePriceService } from '../services/binance-price.service.js';
import { supabase, TABLES } from '../lib/supabase.js';

const DRY_RUN = process.argv.includes('--dry-run');

const tradeRepo = new TradeRepository();
const binancePriceService = new BinancePriceService();

async function recalculateTradesSolToUsd() {
  console.log('🔄 Starting recalculation of amountBase from SOL to USD...\n');
  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE - no changes will be saved\n');
  }

  try {
    // Get all trades with baseToken = SOL
    const { data: trades, error } = await supabase
      .from(TABLES.TRADE)
      .select('*')
      .not('meta', 'is', null);

    if (error) {
      throw new Error(`Failed to fetch trades: ${error.message}`);
    }

    if (!trades || trades.length === 0) {
      console.log('⏭️  No trades found');
      return;
    }

    console.log(`📊 Found ${trades.length} trades to check\n`);

    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    // Process trades in batches to avoid rate limits
    const BATCH_SIZE = 100;
    for (let i = 0; i < trades.length; i += BATCH_SIZE) {
      const batch = trades.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(trades.length / BATCH_SIZE)} (${batch.length} trades)...`);

      for (const trade of batch) {
        try {
          const meta = trade.meta as any;
          const baseToken = meta?.baseToken || 'SOL';
          
          // Only process trades with baseToken = SOL
          if (baseToken !== 'SOL' && baseToken !== 'WSOL') {
            totalSkipped++;
            continue;
          }

          const amountBase = Number(trade.amountBase || 0);
          if (amountBase <= 0) {
            totalSkipped++;
            continue;
          }

          // Check if amountBase seems to be in SOL (not USD)
          // If amountBase * SOL price > $100,000, it's likely in SOL
          // We'll use current SOL price as a rough check, then use historical price for conversion
          const currentSolPrice = await binancePriceService.getCurrentSolPrice();
          const estimatedUsdValue = amountBase * currentSolPrice;

          // If estimated USD value is > $10,000, it's likely in SOL (not USD)
          // But we need to be careful - some trades might legitimately be > $10,000
          // So we'll check if the value seems unreasonably high (> $50,000)
          if (estimatedUsdValue < 50000) {
            // Probably already in USD or a small trade
            totalSkipped++;
            continue;
          }

          // Get historical SOL price at trade timestamp
          const tradeTimestamp = new Date(trade.timestamp);
          const solPriceAtTime = await binancePriceService.getSolPriceAtTimestamp(tradeTimestamp);

          // Convert amountBase from SOL to USD
          const amountBaseUsd = amountBase * solPriceAtTime;
          const priceBasePerTokenUsd = Number(trade.priceBasePerToken || 0) * solPriceAtTime;

          console.log(`  ✅ Trade ${trade.txSignature.substring(0, 16)}...: ${amountBase} SOL → $${amountBaseUsd.toFixed(2)} USD (SOL price: $${solPriceAtTime.toFixed(2)})`);

          if (!DRY_RUN) {
            // Update trade in database
            await tradeRepo.update(trade.id, {
              amountBase: amountBaseUsd,
              priceBasePerToken: priceBasePerTokenUsd,
            });
          }

          totalUpdated++;
        } catch (error: any) {
          console.error(`  ❌ Error processing trade ${trade.id}:`, error.message);
          totalErrors++;
        }
      }

      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < trades.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`\n✅ Recalculation completed!`);
    console.log(`   Updated: ${totalUpdated} trades`);
    console.log(`   Skipped: ${totalSkipped} trades (already in USD or not SOL)`);
    console.log(`   Errors: ${totalErrors} trades`);
    
    if (DRY_RUN) {
      console.log(`\n⚠️  This was a DRY RUN - no changes were saved`);
      console.log(`   Run without --dry-run to apply changes`);
    }
  } catch (error: any) {
    console.error('❌ Error during recalculation:', error);
    process.exit(1);
  }
}

recalculateTradesSolToUsd()
  .then(() => {
    console.log('\n✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });

