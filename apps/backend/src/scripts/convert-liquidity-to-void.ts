/**
 * Convert all ADD/REMOVE LIQUIDITY trades to VOID
 * This fixes trades that were incorrectly stored as buy/sell instead of void
 * 
 * Converts:
 * - Trades with liquidityType='ADD' or 'REMOVE' in meta
 * - Void trades with amountBase > 0
 * - Trades with baseToken='VOID' but side != 'void'
 * - Trades from signatures with both BUY and SELL for different tokens (potential liquidity)
 * 
 * Usage: pnpm convert:liquidity-to-void
 * 
 * Note: High-value trades (>33 SOL) are NOT automatically converted.
 *       If you want to convert them, modify the script to include them in tradesToFix.
 */

import { createClient } from '@supabase/supabase-js';
import { TABLES } from '../lib/supabase.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function convertLiquidityToVoid() {
  console.log('\n🔄 Converting ADD/REMOVE LIQUIDITY trades to VOID...\n');

  try {
    // 1. Find all trades - we need to check multiple indicators
    console.log('📊 Finding trades to convert...');
    
    // Get all trades (we'll filter in memory for better control)
    // First, get trades with liquidityType in meta
    const { data: liquidityTrades1, error: fetchError1 } = await supabase
      .from(TABLES.TRADE)
      .select('id, txSignature, walletId, side, amountBase, amountToken, priceBasePerToken, meta, dex, timestamp')
      .not('meta', 'is', null);

    // Get void trades with amountBase > 0
    const { data: voidTradesWithAmount, error: fetchError2 } = await supabase
      .from(TABLES.TRADE)
      .select('id, txSignature, walletId, side, amountBase, amountToken, priceBasePerToken, meta, dex, timestamp')
      .eq('side', 'void')
      .gt('amountBase', 0);

    // Get trades with baseToken=VOID but side != void
    const { data: allTrades, error: fetchError3 } = await supabase
      .from(TABLES.TRADE)
      .select('id, txSignature, walletId, side, amountBase, amountToken, priceBasePerToken, meta, dex, timestamp')
      .not('meta', 'is', null);

    if (fetchError1 || fetchError2 || fetchError3) {
      throw new Error(`Failed to fetch trades: ${fetchError1?.message || fetchError2?.message || fetchError3?.message}`);
    }

    // Filter trades with liquidityType in meta
    const liquidityTrades = (liquidityTrades1 || []).filter((trade: any) => {
      const meta = trade.meta as any;
      return meta && (meta.liquidityType === 'ADD' || meta.liquidityType === 'REMOVE');
    });

    console.log(`   Found ${liquidityTrades.length} trades with liquidityType in meta`);

    // Also find trades that are marked as void but have amountBase > 0
    console.log(`   Found ${(voidTradesWithAmount || []).length} void trades with amountBase > 0`);

    // Find trades with baseToken = 'VOID' but side != 'void'
    const voidBaseTokenTrades = (allTrades || []).filter((trade: any) => {
      const meta = trade.meta as any;
      return trade.side !== 'void' && meta?.baseToken === 'VOID';
    });

    console.log(`   Found ${voidBaseTokenTrades.length} trades with baseToken=VOID but side != void`);

    // Find trades that might be liquidity operations based on patterns:
    // - Same signature has both BUY and SELL trades (liquidity add/remove)
    // - High amountBase values (> 1000 USD equivalent)
    // - Specific DEX programs (Raydium, Orca)
    console.log('📊 Finding potential liquidity trades by pattern...');
    
    // Group trades by signature
    const tradesBySignature = new Map<string, any[]>();
    (allTrades || []).forEach((trade: any) => {
      if (!tradesBySignature.has(trade.txSignature)) {
        tradesBySignature.set(trade.txSignature, []);
      }
      tradesBySignature.get(trade.txSignature)!.push(trade);
    });

    // Find signatures with both BUY and SELL (likely liquidity operations)
    const potentialLiquiditySignatures = new Set<string>();
    tradesBySignature.forEach((trades, signature) => {
      if (trades.length >= 2) {
        const hasBuy = trades.some((t: any) => t.side === 'buy');
        const hasSell = trades.some((t: any) => t.side === 'sell');
        if (hasBuy && hasSell) {
          // Check if they're for different tokens (liquidity add/remove)
          const uniqueTokens = new Set(trades.map((t: any) => t.tokenId));
          if (uniqueTokens.size >= 2) {
            potentialLiquiditySignatures.add(signature);
          }
        }
      }
    });

    console.log(`   Found ${potentialLiquiditySignatures.size} signatures with both BUY and SELL for different tokens`);

    // Find high-value trades that might be liquidity (but be careful - could be legitimate large trades)
    const highValueTrades = (allTrades || []).filter((trade: any) => {
      const amountBase = Number(trade.amountBase);
      // High value threshold: > 5000 USD (assuming ~150 USD per SOL, that's ~33 SOL)
      return amountBase > 33 && trade.side !== 'void';
    });

    console.log(`   Found ${highValueTrades.length} high-value trades (>33 SOL / ~5000 USD)`);

    // Show sample of high-value trades for review
    if (highValueTrades.length > 0) {
      console.log(`\n   Sample high-value trades (first 5):`);
      highValueTrades.slice(0, 5).forEach((trade: any) => {
        console.log(`     - ${trade.txSignature.substring(0, 16)}... | ${trade.side} | ${Number(trade.amountBase).toFixed(2)} base | ${trade.dex}`);
      });
    }

    // Combine all trades that need to be fixed
    const tradesToFix = new Set<string>();
    const affectedWallets = new Set<string>();

    // Add liquidity trades with liquidityType
    liquidityTrades.forEach((trade: any) => {
      // Only fix if not already properly void
      if (!(trade.side === 'void' && Number(trade.amountBase) === 0)) {
        tradesToFix.add(trade.id);
        affectedWallets.add(trade.walletId);
      }
    });

    // Add void trades with amount
    (voidTradesWithAmount || []).forEach((trade: any) => {
      tradesToFix.add(trade.id);
      affectedWallets.add(trade.walletId);
    });

    // Add trades with VOID baseToken but wrong side
    voidBaseTokenTrades.forEach((trade: any) => {
      tradesToFix.add(trade.id);
      affectedWallets.add(trade.walletId);
    });

    // Add trades from signatures with both BUY and SELL (potential liquidity)
    // But only if they're not already void
    potentialLiquiditySignatures.forEach((signature) => {
      const trades = tradesBySignature.get(signature) || [];
      trades.forEach((trade: any) => {
        if (trade.side !== 'void') {
          tradesToFix.add(trade.id);
          affectedWallets.add(trade.walletId);
        }
      });
    });

    console.log(`\n⚠️  WARNING: Found ${potentialLiquiditySignatures.size} signatures with potential liquidity operations`);
    console.log(`   These will be converted to VOID. Review carefully!`);
    console.log(`   Sample signatures: ${Array.from(potentialLiquiditySignatures).slice(0, 5).join(', ')}`);


    console.log(`\n📝 Summary:`);
    console.log(`   Trades with liquidityType: ${liquidityTrades.length}`);
    console.log(`   Void trades with amount: ${(voidTradesWithAmount || []).length}`);
    console.log(`   Trades with VOID baseToken: ${voidBaseTokenTrades.length}`);
    console.log(`   Potential liquidity signatures: ${potentialLiquiditySignatures.size}`);
    console.log(`   High-value trades: ${highValueTrades.length}`);
    console.log(`   Total trades to convert: ${tradesToFix.size}`);
    console.log(`   Affected wallets: ${affectedWallets.size}`);

    if (tradesToFix.size === 0) {
      console.log('\n✅ No trades need conversion based on liquidityType or patterns');
      console.log(`\n⚠️  NOTE: Found ${highValueTrades.length} high-value trades that might be liquidity operations`);
      console.log(`   These are NOT automatically converted - review manually if needed`);
      console.log(`   To convert high-value trades, modify the script to include them`);
      return;
    }

    // Ask for confirmation if there are many trades
    if (tradesToFix.size > 100) {
      console.log(`\n⚠️  WARNING: About to convert ${tradesToFix.size} trades to VOID`);
      console.log(`   This will affect ${affectedWallets.size} wallets`);
      console.log(`   Press Ctrl+C to cancel, or wait 5 seconds to continue...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // 3. Update trades to void
    console.log(`\n🔄 Updating ${tradesToFix.size} trades to VOID...`);
    
    const tradeIds = Array.from(tradesToFix);
    let updated = 0;
    let failed = 0;

    // Collect all trades we need to update
    const allTradesMap = new Map<string, any>();
    [...liquidityTrades, ...(voidTradesWithAmount || []), ...voidBaseTokenTrades].forEach((t: any) => {
      allTradesMap.set(t.id, t);
    });
    // Add trades from potential liquidity signatures
    potentialLiquiditySignatures.forEach((signature) => {
      const trades = tradesBySignature.get(signature) || [];
      trades.forEach((trade: any) => {
        allTradesMap.set(trade.id, trade);
      });
    });

    for (const tradeId of tradeIds) {
      const trade = allTradesMap.get(tradeId);
      if (!trade) {
        // Try to fetch from database
        const { data: fetchedTrade } = await supabase
          .from(TABLES.TRADE)
          .select('*')
          .eq('id', tradeId)
          .single();
        if (!fetchedTrade) {
          console.warn(`⚠️  Trade ${tradeId} not found, skipping`);
          failed++;
          continue;
        }
        const updatedTrade = fetchedTrade;
        Object.assign(trade, updatedTrade);
      }

      const meta = (trade.meta as any) || {};
      const updatedMeta = {
        ...meta,
        baseToken: 'VOID',
        liquidityType: meta.liquidityType || (potentialLiquiditySignatures.has(trade.txSignature) ? 'ADD' : undefined),
      };

      const { error: updateError } = await supabase
        .from(TABLES.TRADE)
        .update({
          side: 'void',
          amountBase: '0',
          priceBasePerToken: '0',
          meta: updatedMeta,
        })
        .eq('id', tradeId);

      if (updateError) {
        console.error(`❌ Error updating trade ${trade.txSignature?.substring(0, 16) || tradeId}...:`, updateError.message);
        failed++;
      } else {
        updated++;
        if (updated % 50 === 0) {
          console.log(`   ✅ Updated ${updated}/${tradeIds.length} trades...`);
        }
      }
    }

    console.log(`\n✅ Conversion complete:`);
    console.log(`   Updated: ${updated}`);
    console.log(`   Failed: ${failed}`);

    // 4. Recalculate closed lots and metrics for affected wallets
    console.log(`\n🔄 Recalculating closed lots and metrics for ${affectedWallets.size} wallets...`);

    const smartWalletRepo = new SmartWalletRepository();
    const tradeRepo = new TradeRepository();
    const metricsHistoryRepo = new MetricsHistoryRepository();
    const lotMatchingService = new LotMatchingService();
    const metricsCalculator = new MetricsCalculatorService(
      smartWalletRepo,
      tradeRepo,
      metricsHistoryRepo
    );

    const walletIds = Array.from(affectedWallets);
    let recalculated = 0;

    for (const walletId of walletIds) {
      try {
        // Recalculate closed lots
        const closedLots = await lotMatchingService.processTradesForWallet(walletId);
        await lotMatchingService.saveClosedLots(closedLots);
        
        // Recalculate metrics
        await metricsCalculator.calculateMetricsForWallet(walletId);
        
        recalculated++;
        if (recalculated % 10 === 0) {
          console.log(`   ✅ Recalculated ${recalculated}/${walletIds.length} wallets...`);
        }
      } catch (error: any) {
        console.error(`❌ Error recalculating wallet ${walletId}:`, error.message);
      }
    }

    console.log(`\n✅ Recalculation complete:`);
    console.log(`   Wallets recalculated: ${recalculated}/${walletIds.length}`);

    // 5. Invalidate portfolio cache for affected wallets
    console.log(`\n🔄 Invalidating portfolio cache...`);
    let cacheInvalidated = 0;

    for (const walletId of walletIds) {
      const { error: deleteError } = await supabase
        .from('PortfolioBaseline')
        .delete()
        .eq('walletId', walletId);

      if (deleteError) {
        console.warn(`⚠️  Failed to invalidate cache for wallet ${walletId}:`, deleteError.message);
      } else {
        cacheInvalidated++;
      }
    }

    console.log(`   ✅ Cache invalidated for ${cacheInvalidated}/${walletIds.length} wallets`);

    console.log(`\n✅ All done!`);
    console.log(`   Total trades converted: ${updated}`);
    console.log(`   Wallets affected: ${walletIds.length}`);
    console.log(`   Wallets recalculated: ${recalculated}`);

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

convertLiquidityToVoid().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
