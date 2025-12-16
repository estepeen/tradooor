import dotenv from 'dotenv';
import cron from 'node-cron';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { LotMatchingService } from '../services/lot-matching.service.js';

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
 * Nebo s vlastním cron schedule (každých 6 hodin):
 *   CRON_SCHEDULE="0 0,6,12,18 * * *" pnpm --filter backend metrics:cron
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
  const lotMatchingService = new LotMatchingService();

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

    // Add delay between wallet processing to reduce CPU spikes
    // This spreads the load over time instead of hitting the database with all wallets at once
    const DELAY_BETWEEN_WALLETS_MS = 500; // 500ms delay between each wallet
    
    for (let i = 0; i < walletList.length; i++) {
      const wallet = walletList[i];
      try {
        console.log(`  Processing (${i + 1}/${walletList.length}): ${wallet.address.substring(0, 8)}...`);
        
        // DŮLEŽITÉ: Vytvoř ClosedLot před výpočtem metrik (jednotný princip)
        // Zajišťuje, že PnL se počítá POUZE z ClosedLot
        const walletData = await smartWalletRepo.findById(wallet.id);
        if (walletData) {
          const trackingStartTime = walletData.createdAt ? new Date(walletData.createdAt) : undefined;
          const closedLots = await lotMatchingService.processTradesForWallet(
            wallet.id,
            undefined, // Process all tokens
            trackingStartTime
          );
          await lotMatchingService.saveClosedLots(closedLots);
          if (closedLots.length > 0) {
            console.log(`    ✅ Created ${closedLots.length} closed lots`);
          }
        }
        
        // Nyní přepočítej metriky (které používají POUZE ClosedLot)
        await metricsCalculator.calculateMetricsForWallet(wallet.id);
        successCount++;
        
        // Add delay between wallets to reduce CPU spikes (except for last wallet)
        if (i < walletList.length - 1) {
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_WALLETS_MS));
        }
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
