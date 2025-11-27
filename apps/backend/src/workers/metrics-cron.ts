import dotenv from 'dotenv';
import cron from 'node-cron';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';

dotenv.config();

/**
 * Periodický job pro přepočet metrik wallet
 * 
 * Spustí se podle cron schedule a přepočítá metriky pro všechny walletky.
 * 
 * Datový tok:
 * 1. Projde všechny trades dané walletky
 * 2. Spočítá metriky:
 *    - winrate
 *    - průměrné PnL v %
 *    - celkový PnL
 *    - průměrnou dobu držení (na základě párování buy/sell u stejného tokenu)
 *    - max drawdown
 *    - score (kombinace recent PnL, winrate a počtu tradeů)
 * 3. Uloží aktuální hodnoty do smart_wallets
 * 4. Vytvoří nový záznam do smart_wallet_metrics_history
 * 
 * Použití:
 *   pnpm --filter backend metrics:cron
 * 
 * Nebo s vlastním cron schedule:
 *   CRON_SCHEDULE="0 */6 * * *" pnpm --filter backend metrics:cron
 */
async function calculateAllMetrics() {
  console.log(`\n⏰ [${new Date().toISOString()}] Starting metrics calculation...`);

  const smartWalletRepo = new SmartWalletRepository();
  const tradeRepo = new TradeRepository();
  const metricsHistoryRepo = new MetricsHistoryRepository();
  const metricsCalculator = new MetricsCalculatorService(
    smartWalletRepo,
    tradeRepo,
    metricsHistoryRepo
  );

  try {
    const { data: wallets, error } = await supabase
      .from(TABLES.SMART_WALLET)
      .select('id, address');

    if (error) {
      throw new Error(`Failed to fetch wallets: ${error.message}`);
    }

    const walletList = wallets ?? [];
    console.log(`📊 Processing ${walletList.length} wallets...`);

    let successCount = 0;
    let errorCount = 0;

    for (const wallet of walletList) {
      try {
        console.log(`  Processing: ${wallet.address.substring(0, 8)}...`);
        await metricsCalculator.calculateMetricsForWallet(wallet.id);
        successCount++;
      } catch (error) {
        console.error(`  ❌ Error processing ${wallet.address}:`, error);
        errorCount++;
      }
    }

    console.log(`✅ Completed: ${successCount} successful, ${errorCount} errors`);
  } catch (error) {
    console.error('❌ Error in metrics calculation:', error);
  }
}

async function main() {
  // Default: každou hodinu (0 * * * *)
  // Můžeš změnit přes environment variable CRON_SCHEDULE
  // Poznámka: Worker queue už zpracovává metriky po každém novém trade,
  // takže tento cron je spíš backup/cleanup mechanismus pro zajištění aktuálnosti
  const cronSchedule = process.env.CRON_SCHEDULE || '0 * * * *';

  console.log(`🚀 Starting metrics cron job`);
  console.log(`📅 Schedule: ${cronSchedule}`);
  console.log(`   (Default: every 1 hour. Set CRON_SCHEDULE env var to customize)`);

  // Spusť jednou hned při startu (pro testování)
  if (process.env.RUN_ON_START !== 'false') {
    await calculateAllMetrics();
  }

  // Nastav cron job
  cron.schedule(cronSchedule, async () => {
    await calculateAllMetrics();
  });

  // Keep process running
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down metrics cron...');
    process.exit(0);
  });

  console.log('✅ Metrics cron job is running. Press Ctrl+C to stop.');
}

main();
