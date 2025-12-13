/**
 * Convert liquidity trades to VOID for a specific wallet
 * 
 * Usage: pnpm convert:wallet-liquidity-to-void <walletAddress>
 */

import { createClient } from '@supabase/supabase-js';
import { TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function convertWalletLiquidityToVoid(walletAddress: string) {
  console.log(`\n🔄 Converting liquidity trades to VOID for wallet: ${walletAddress}\n`);

  try {
    // Find wallet
    const smartWalletRepo = new SmartWalletRepository();
    const wallet = await smartWalletRepo.findByAddress(walletAddress);
    if (!wallet) {
      console.error(`❌ Wallet not found: ${walletAddress}`);
      process.exit(1);
    }

    console.log(`✅ Wallet found: ${wallet.label || wallet.address}`);
    console.log(`   ID: ${wallet.id}\n`);

    // Get all trades for this wallet
    const { data: trades, error: fetchError } = await supabase
      .from(TABLES.TRADE)
      .select('id, txSignature, side, amountBase, amountToken, priceBasePerToken, meta, dex, timestamp, tokenId')
      .eq('walletId', wallet.id)
      .order('amountBase', { ascending: false });

    if (fetchError) {
      throw new Error(`Failed to fetch trades: ${fetchError.message}`);
    }

    if (!trades || trades.length === 0) {
      console.log('✅ No trades found');
      return;
    }

    console.log(`📊 Found ${trades.length} total trades\n`);

    // Find trades that should be void
    const tradesToFix: any[] = [];

    // 1. Trades with liquidityType in meta
    trades.forEach((trade: any) => {
      const meta = trade.meta as any;
      if (meta && (meta.liquidityType === 'ADD' || meta.liquidityType === 'REMOVE')) {
        if (!(trade.side === 'void' && Number(trade.amountBase) === 0)) {
          tradesToFix.push(trade);
        }
      }
    });

    // 2. Void trades with amountBase > 0
    trades.forEach((trade: any) => {
      if (trade.side === 'void' && Number(trade.amountBase) > 0) {
        tradesToFix.push(trade);
      }
    });

    // 3. Trades with baseToken='VOID' but side != 'void'
    trades.forEach((trade: any) => {
      const meta = trade.meta as any;
      if (trade.side !== 'void' && meta?.baseToken === 'VOID') {
        tradesToFix.push(trade);
      }
    });

    // 4. Find trades with suspiciously high amountBase values (potential liquidity misdetection)
    // Liquidity operations often have very high USD values but represent LP operations, not actual trades
    // Look for trades where amountBase (USD) is much higher than expected from amountBaseRaw (SOL)
    trades.forEach((trade: any) => {
      const meta = trade.meta as any;
      if (trade.side !== 'void') {
        const amountBase = Number(trade.amountBase); // USD value
        const amountBaseRaw = meta?.amountBaseRaw ? Number(meta.amountBaseRaw) : null;
        
        // Very high value trades (> 10000 USD) are suspicious
        if (amountBase > 10000) {
          let isSuspicious = false;
          
          if (amountBaseRaw) {
            // If we have amountBaseRaw, check ratio
            // Normal SOL price is ~100-200 USD, so ratio should be reasonable
            // If ratio is > 200, it's suspicious (might be liquidity)
            const ratio = amountBase / amountBaseRaw;
            if (ratio > 200) {
              isSuspicious = true;
            }
          } else {
            // No amountBaseRaw - check if it's from unknown DEX or has other suspicious patterns
            isSuspicious = trade.dex === 'unknown';
          }
          
          if (isSuspicious && !tradesToFix.find(t => t.id === trade.id)) {
            tradesToFix.push(trade);
          }
        }
      }
    });

    // 5. Group trades by signature to find potential liquidity (BUY + SELL in same tx)
    const tradesBySignature = new Map<string, any[]>();
    trades.forEach((trade: any) => {
      if (!tradesBySignature.has(trade.txSignature)) {
        tradesBySignature.set(trade.txSignature, []);
      }
      tradesBySignature.get(trade.txSignature)!.push(trade);
    });

    // Find signatures with both BUY and SELL for different tokens (potential liquidity)
    tradesBySignature.forEach((txTrades, signature) => {
      if (txTrades.length >= 2) {
        const hasBuy = txTrades.some((t: any) => t.side === 'buy');
        const hasSell = txTrades.some((t: any) => t.side === 'sell');
        if (hasBuy && hasSell) {
          // Check if they're for different tokens
          const uniqueTokens = new Set(txTrades.map((t: any) => t.tokenId).filter(Boolean));
          if (uniqueTokens.size >= 2) {
            // Add all trades from this signature
            txTrades.forEach((trade: any) => {
              if (trade.side !== 'void' && !tradesToFix.find(t => t.id === trade.id)) {
                tradesToFix.push(trade);
              }
            });
          }
        }
      }
    });

    // Remove duplicates
    const uniqueTradesToFix = Array.from(new Map(tradesToFix.map(t => [t.id, t])).values());

    console.log(`\n📝 Summary:`);
    console.log(`   Trades with liquidityType: ${trades.filter((t: any) => {
      const meta = t.meta as any;
      return meta && (meta.liquidityType === 'ADD' || meta.liquidityType === 'REMOVE');
    }).length}`);
    console.log(`   Void trades with amount: ${trades.filter((t: any) => t.side === 'void' && Number(t.amountBase) > 0).length}`);
    console.log(`   Trades with VOID baseToken: ${trades.filter((t: any) => {
      const meta = t.meta as any;
      return t.side !== 'void' && meta?.baseToken === 'VOID';
    }).length}`);
    console.log(`   High-value suspicious trades: ${trades.filter((t: any) => {
      const meta = t.meta as any;
      if (meta?.amountBaseRaw && t.side !== 'void') {
        const amountBaseRaw = Number(meta.amountBaseRaw);
        const amountBase = Number(t.amountBase);
        return amountBaseRaw > 0 && amountBaseRaw < 100 && amountBase > 5000 && (amountBase / amountBaseRaw) > 100;
      }
      return false;
    }).length}`);
    console.log(`   Total trades to convert: ${uniqueTradesToFix.length}\n`);

    if (uniqueTradesToFix.length === 0) {
      console.log('✅ No trades need conversion');
      return;
    }

    // Show sample
    console.log('Sample trades to convert (first 10):');
    uniqueTradesToFix.slice(0, 10).forEach((trade: any, idx: number) => {
      const meta = trade.meta as any;
      console.log(`\n${idx + 1}. ${trade.txSignature.substring(0, 16)}...`);
      console.log(`   Side: ${trade.side} → void`);
      console.log(`   Amount Base: ${Number(trade.amountBase).toFixed(2)} → 0`);
      console.log(`   DEX: ${trade.dex}`);
      console.log(`   Meta liquidityType: ${meta?.liquidityType || 'N/A'}`);
      console.log(`   Meta baseToken: ${meta?.baseToken || 'N/A'}`);
    });

    if (uniqueTradesToFix.length > 10) {
      console.log(`\n   ... and ${uniqueTradesToFix.length - 10} more`);
    }

    // Update trades
    console.log(`\n🔄 Updating ${uniqueTradesToFix.length} trades to VOID...`);
    let updated = 0;
    let failed = 0;

    for (const trade of uniqueTradesToFix) {
      const meta = (trade.meta as any) || {};
      const updatedMeta = {
        ...meta,
        baseToken: 'VOID',
        liquidityType: meta.liquidityType || 'ADD', // Preserve or set liquidityType
      };

      const { error: updateError } = await supabase
        .from(TABLES.TRADE)
        .update({
          side: 'void',
          amountBase: '0',
          priceBasePerToken: '0',
          meta: updatedMeta,
        })
        .eq('id', trade.id);

      if (updateError) {
        console.error(`❌ Error updating trade ${trade.txSignature.substring(0, 16)}...:`, updateError.message);
        failed++;
      } else {
        updated++;
        if (updated % 10 === 0) {
          console.log(`   ✅ Updated ${updated}/${uniqueTradesToFix.length} trades...`);
        }
      }
    }

    console.log(`\n✅ Conversion complete:`);
    console.log(`   Updated: ${updated}`);
    console.log(`   Failed: ${failed}`);

    // Recalculate closed lots and metrics
    console.log(`\n🔄 Recalculating closed lots and metrics...`);

    const tradeRepo = new TradeRepository();
    const metricsHistoryRepo = new MetricsHistoryRepository();
    const lotMatchingService = new LotMatchingService();
    const metricsCalculator = new MetricsCalculatorService(
      smartWalletRepo,
      tradeRepo,
      metricsHistoryRepo
    );

    try {
      // Recalculate closed lots
      const closedLots = await lotMatchingService.processTradesForWallet(wallet.id);
      await lotMatchingService.saveClosedLots(closedLots);
      console.log(`   ✅ Created ${closedLots.length} closed lots`);

      // Recalculate metrics
      await metricsCalculator.calculateMetricsForWallet(wallet.id);
      console.log(`   ✅ Metrics recalculated`);
    } catch (error: any) {
      console.error(`❌ Error recalculating:`, error.message);
    }

    // Invalidate portfolio cache
    console.log(`\n🔄 Invalidating portfolio cache...`);
    const { error: deleteError } = await supabase
      .from('PortfolioBaseline')
      .delete()
      .eq('walletId', wallet.id);

    if (deleteError) {
      console.warn(`⚠️  Failed to invalidate cache: ${deleteError.message}`);
    } else {
      console.log(`   ✅ Cache invalidated`);
    }

    console.log(`\n✅ All done!`);

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Main
const walletAddress = process.argv[2];
if (!walletAddress) {
  console.error('Usage: pnpm convert:wallet-liquidity-to-void <walletAddress>');
  process.exit(1);
}

convertWalletLiquidityToVoid(walletAddress).then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
