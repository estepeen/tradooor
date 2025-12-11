import 'dotenv/config';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { LotMatchingService } from '../services/lot-matching.service.js';

const walletAddress = process.argv[2];

if (!walletAddress) {
  console.error('Usage: tsx src/scripts/debug-pnl.ts <wallet-address>');
  process.exit(1);
}

async function main() {
  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();
  const metricsHistoryRepo = new MetricsHistoryRepository();
  const metricsCalculator = new MetricsCalculatorService(
    smartWalletRepo,
    tradeRepo,
    metricsHistoryRepo
  );
  const lotMatchingService = new LotMatchingService();

  try {
    // 1. Najdi wallet
    const wallet = await smartWalletRepo.findByAddress(walletAddress);
    if (!wallet) {
      console.error(`❌ Wallet not found: ${walletAddress}`);
      process.exit(1);
    }

    console.log(`\n📊 Debugging PnL for wallet: ${wallet.label || wallet.address}`);
    console.log(`   ID: ${wallet.id}`);
    console.log(`\n`);

    // 2. Zkontroluj aktuální hodnoty v DB
    console.log(`📦 Current values in database:`);
    console.log(`   recentPnl30dUsd: ${wallet.recentPnl30dUsd}`);
    console.log(`   recentPnl30dPercent: ${wallet.recentPnl30dPercent}`);
    
    const advancedStats = wallet.advancedStats as any;
    if (advancedStats?.rolling?.['30d']) {
      const rolling30d = advancedStats.rolling['30d'];
      console.log(`   advancedStats.rolling['30d'].realizedPnlUsd: ${rolling30d.realizedPnlUsd}`);
      console.log(`   advancedStats.rolling['30d'].realizedRoiPercent: ${rolling30d.realizedRoiPercent}`);
      console.log(`   advancedStats.rolling['30d'].numClosedTrades: ${rolling30d.numClosedTrades}`);
    } else {
      console.log(`   advancedStats.rolling['30d']: NOT FOUND`);
    }
    console.log(`\n`);

    // 3. Zkontroluj closed lots za posledních 30 dní
    const { closedLots } = await lotMatchingService.processTradesForWallet(wallet.id);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const closedLots30d = closedLots.filter(lot => lot.exitTime >= thirtyDaysAgo);
    console.log(`📈 Closed lots (last 30 days):`);
    console.log(`   Total closed lots: ${closedLots.length}`);
    console.log(`   Closed lots in last 30d: ${closedLots30d.length}`);
    
    if (closedLots30d.length > 0) {
      const totalRealizedPnl = closedLots30d.reduce((sum, lot) => sum + lot.realizedPnl, 0);
      const totalProceeds = closedLots30d.reduce((sum, lot) => sum + lot.proceeds, 0);
      const totalCostBasis = closedLots30d.reduce((sum, lot) => sum + Math.max(lot.costBasis, 0), 0);
      
      console.log(`   Total realized PnL (SOL): ${totalRealizedPnl.toFixed(6)}`);
      console.log(`   Total proceeds (SOL): ${totalProceeds.toFixed(6)}`);
      console.log(`   Total cost basis (SOL): ${totalCostBasis.toFixed(6)}`);
      
      // Get SOL price
      const { BinancePriceService } = await import('../services/binance-price.service.js');
      const binancePriceService = new BinancePriceService();
      let solPriceUsd = 150;
      try {
        solPriceUsd = await binancePriceService.getCurrentSolPrice();
      } catch (error) {
        console.warn(`   ⚠️  Failed to fetch SOL price, using fallback: ${solPriceUsd}`);
      }
      
      const realizedPnlUsd = totalRealizedPnl * solPriceUsd;
      const realizedRoiPercent = totalCostBasis > 0 ? (realizedPnlUsd / (totalCostBasis * solPriceUsd)) * 100 : 0;
      
      console.log(`   SOL price (USD): ${solPriceUsd.toFixed(2)}`);
      console.log(`   Calculated realizedPnlUsd: ${realizedPnlUsd.toFixed(2)}`);
      console.log(`   Calculated realizedRoiPercent: ${realizedRoiPercent.toFixed(2)}%`);
      
      // Show first 5 closed lots
      console.log(`\n   First 5 closed lots (last 30d):`);
      closedLots30d.slice(0, 5).forEach((lot, idx) => {
        console.log(`     ${idx + 1}. Exit: ${lot.exitTime.toISOString()}, PnL: ${lot.realizedPnl.toFixed(6)} SOL, Cost: ${lot.costBasis.toFixed(6)} SOL`);
      });
    }
    console.log(`\n`);

    // 4. Zkontroluj trades za posledních 30 dní
    const { data: trades30d, error: tradesError } = await supabase
      .from(TABLES.TRADE)
      .select('side, valueUsd, amountBase, timestamp')
      .eq('walletId', wallet.id)
      .gte('timestamp', thirtyDaysAgo.toISOString())
      .order('timestamp', { ascending: false });

    if (!tradesError && trades30d) {
      const buyValue = trades30d.filter(t => t.side === 'buy').reduce((sum, t) => sum + (Number(t.valueUsd) || 0), 0);
      const sellValue = trades30d.filter(t => t.side === 'sell').reduce((sum, t) => sum + (Number(t.valueUsd) || 0), 0);
      const pnlFromTrades = sellValue - buyValue;
      
      console.log(`💱 Trades (last 30 days):`);
      console.log(`   Total trades: ${trades30d.length}`);
      console.log(`   Buy value (USD): ${buyValue.toFixed(2)}`);
      console.log(`   Sell value (USD): ${sellValue.toFixed(2)}`);
      console.log(`   PnL from trades (sell - buy): ${pnlFromTrades.toFixed(2)} USD`);
    }
    console.log(`\n`);

    // 5. Přepočítej metriky a zkontroluj výsledek
    console.log(`🔄 Recalculating metrics...`);
    const result = await metricsCalculator.calculateMetricsForWallet(wallet.id);
    
    console.log(`\n✅ After recalculation:`);
    if (result) {
      console.log(`   recentPnl30dUsd: ${result.recentPnl30dUsd}`);
      console.log(`   recentPnl30dPercent: ${result.recentPnl30dPercent}`);
      
      if (result.advancedStats?.rolling?.['30d']) {
        const rolling30d = result.advancedStats.rolling['30d'];
        console.log(`   advancedStats.rolling['30d'].realizedPnl: ${rolling30d.realizedPnl}`);
        console.log(`   advancedStats.rolling['30d'].realizedRoiPercent: ${rolling30d.realizedRoiPercent}`);
      }
    } else {
      console.log(`   No result returned`);
    }
    console.log(`\n`);

  } catch (error: any) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();

