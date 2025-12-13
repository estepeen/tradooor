/**
 * Fix specific liquidity trades for a wallet by signature
 * 
 * Usage: pnpm fix:wallet-liquidity <walletAddress> <signature1> [signature2] ...
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

async function fixWalletLiquidity(walletAddress: string, signatures: string[]) {
  console.log(`\n🔄 Converting liquidity trades to VOID for wallet: ${walletAddress}`);
  console.log(`   Signatures: ${signatures.length}\n`);

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

    // Get trades by signatures
    const { data: trades, error: fetchError } = await supabase
      .from(TABLES.TRADE)
      .select('id, txSignature, side, amountBase, amountToken, priceBasePerToken, meta, dex, timestamp')
      .eq('walletId', wallet.id)
      .in('txSignature', signatures);

    if (fetchError) {
      throw new Error(`Failed to fetch trades: ${fetchError.message}`);
    }

    if (!trades || trades.length === 0) {
      console.log('❌ No trades found for these signatures');
      return;
    }

    console.log(`📊 Found ${trades.length} trades to convert\n`);

    // Show trades
    trades.forEach((trade: any, idx: number) => {
      const meta = trade.meta as any;
      console.log(`${idx + 1}. ${trade.txSignature.substring(0, 16)}...`);
      console.log(`   Side: ${trade.side} → void`);
      console.log(`   Amount Base: ${Number(trade.amountBase).toFixed(2)} → 0`);
      console.log(`   Amount Base Raw: ${meta?.amountBaseRaw || 'N/A'}`);
      console.log(`   DEX: ${trade.dex}`);
      console.log('');
    });

    // Update trades
    console.log(`🔄 Updating ${trades.length} trades to VOID...`);
    let updated = 0;
    let failed = 0;

    for (const trade of trades) {
      const meta = (trade.meta as any) || {};
      const updatedMeta = {
        ...meta,
        baseToken: 'VOID',
        liquidityType: meta.liquidityType || 'ADD', // Mark as ADD liquidity
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
        console.log(`   ✅ Updated ${trade.txSignature.substring(0, 16)}...`);
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
const signatures = process.argv.slice(3);

if (!walletAddress || signatures.length === 0) {
  console.error('Usage: pnpm fix:wallet-liquidity <walletAddress> <signature1> [signature2] ...');
  process.exit(1);
}

fixWalletLiquidity(walletAddress, signatures).then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
