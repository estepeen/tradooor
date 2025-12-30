/**
 * Signal Performance Cron
 *
 * Periodicky aktualizuje výkonnost signálů:
 * - Sleduje ceny tokenů pro aktivní signály
 * - Zaznamenává price milestones (5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 24h)
 * - Aktualizuje PnL a drawdown
 * - Expiruje staré signály (po 24h)
 *
 * Běží každou minutu, throttled aby nezahltil DexScreener API
 */

import 'dotenv/config';
import cron from 'node-cron';
import { SignalPerformanceService } from '../services/signal-performance.service.js';

const signalPerformance = new SignalPerformanceService();

// Cron schedule (default: every minute)
const CRON_SCHEDULE = process.env.SIGNAL_PERF_CRON_SCHEDULE || '* * * * *';

// Flag to prevent overlapping runs
let isRunning = false;

async function runPerformanceUpdate() {
  if (isRunning) {
    console.log('⏳ [SignalPerf] Previous run still in progress, skipping...');
    return;
  }

  isRunning = true;

  try {
    console.log(`\n📊 [SignalPerf] Starting performance update cycle at ${new Date().toISOString()}`);
    const startTime = Date.now();

    const stats = await signalPerformance.updateAllActivePerformances();

    const duration = Date.now() - startTime;
    console.log(`✅ [SignalPerf] Update cycle completed in ${(duration / 1000).toFixed(1)}s`);
    console.log(`   Updated: ${stats.updated}, Expired: ${stats.expired}, SL hits: ${stats.slHits}, TP hits: ${stats.tpHits}, Errors: ${stats.errors}`);
  } catch (error: any) {
    console.error(`❌ [SignalPerf] Error in update cycle: ${error.message}`);
    console.error(error.stack);
  } finally {
    isRunning = false;
  }
}

async function main() {
  console.log('🚀 Signal Performance Cron starting...');
  console.log(`   Schedule: ${CRON_SCHEDULE}`);
  console.log('   Features:');
  console.log('   - Price tracking for active signals');
  console.log('   - Milestone recording (5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 24h)');
  console.log('   - High/low tracking and drawdown calculation');
  console.log('   - Auto-expiry after 24 hours');
  console.log('');

  // Run once on start if enabled
  if (process.env.RUN_ON_START !== 'false') {
    console.log('🔄 Running initial performance update...');
    await runPerformanceUpdate();
  }

  // Schedule cron job
  cron.schedule(CRON_SCHEDULE, async () => {
    await runPerformanceUpdate();
  });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down Signal Performance Cron...');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down Signal Performance Cron (SIGTERM)...');
    process.exit(0);
  });

  console.log('✅ Signal Performance Cron is running. Press Ctrl+C to stop.');
}

main().catch(error => {
  console.error('Fatal error in Signal Performance Cron:', error);
  process.exit(1);
});
