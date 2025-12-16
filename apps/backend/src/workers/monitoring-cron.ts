/**
 * Monitoring Cron Worker
 * 
 * Periodicky spouští:
 * - Signal outcome checking
 * - Price alert monitoring
 * - Stats aggregation
 * - Daily summary notifications
 */

import { SignalOutcomeService } from '../services/signal-outcome.service.js';
import { PriceMonitorService } from '../services/price-monitor.service.js';
import { NotificationService } from '../services/notification.service.js';
import { WalletCorrelationService } from '../services/wallet-correlation.service.js';

const outcomeService = new SignalOutcomeService();
const priceMonitor = new PriceMonitorService();
const notifications = new NotificationService();
const correlationService = new WalletCorrelationService();

// Track last runs
let lastOutcomeCheck = 0;
let lastPriceCheck = 0;
let lastStatsCalc = 0;
let lastCorrelationAnalysis = 0;
let lastDailySummary = '';

const OUTCOME_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const PRICE_CHECK_INTERVAL = 1 * 60 * 1000; // 1 minute
const STATS_CALC_INTERVAL = 60 * 60 * 1000; // 1 hour
const CORRELATION_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

async function runMonitoringTasks() {
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];

  // 1. Check signal outcomes (every 5 min)
  if (now - lastOutcomeCheck >= OUTCOME_CHECK_INTERVAL) {
    lastOutcomeCheck = now;
    try {
      console.log('📊 [Monitoring] Checking signal outcomes...');
      const { checked, resolved } = await outcomeService.checkAllPendingSignals();
      if (resolved > 0) {
        console.log(`   ✅ Resolved ${resolved}/${checked} signals`);
      }
    } catch (error: any) {
      console.error('   ❌ Outcome check error:', error.message);
    }
  }

  // 2. Check price alerts (every 1 min)
  if (now - lastPriceCheck >= PRICE_CHECK_INTERVAL) {
    lastPriceCheck = now;
    try {
      const { checked, triggered } = await priceMonitor.checkAllAlerts();
      if (triggered > 0) {
        console.log(`🔔 [Monitoring] ${triggered} price alerts triggered`);
      }
    } catch (error: any) {
      console.error('   ❌ Price check error:', error.message);
    }
  }

  // 3. Calculate stats (every hour)
  if (now - lastStatsCalc >= STATS_CALC_INTERVAL) {
    lastStatsCalc = now;
    try {
      console.log('📈 [Monitoring] Calculating stats...');
      await outcomeService.calculateStats('daily');
      await outcomeService.calculateStats('weekly');
      await outcomeService.calculateStats('all_time');
      console.log('   ✅ Stats calculated');
    } catch (error: any) {
      console.error('   ❌ Stats calc error:', error.message);
    }
  }

  // 4. Daily summary (once per day at ~midnight UTC)
  const currentHour = new Date().getUTCHours();
  if (lastDailySummary !== today && currentHour === 0) {
    lastDailySummary = today;
    try {
      console.log('📊 [Monitoring] Sending daily summary...');
      const stats = await outcomeService.calculateStats('daily');
      if (stats) {
        await notifications.sendDailySummary(stats);
        console.log('   ✅ Daily summary sent');
      }
    } catch (error: any) {
      console.error('   ❌ Daily summary error:', error.message);
    }
  }

  // 5. Wallet correlation analysis (once per day)
  if (now - lastCorrelationAnalysis >= CORRELATION_INTERVAL) {
    lastCorrelationAnalysis = now;
    try {
      console.log('🔗 [Monitoring] Analyzing wallet correlations...');
      const result = await correlationService.analyzeAllCorrelations();
      console.log(`   ✅ Found ${result.correlationsFound} correlations, ${result.groupsDetected} groups`);
    } catch (error: any) {
      console.error('   ❌ Correlation analysis error:', error.message);
    }
  }

  // 6. Process pending notifications
  try {
    const sent = await notifications.processPendingNotifications();
    if (sent > 0) {
      console.log(`📤 [Monitoring] Sent ${sent} pending notifications`);
    }
  } catch (error: any) {
    // Non-critical
  }
}

// Main loop
async function main() {
  console.log('🚀 Starting Monitoring Cron Worker');
  console.log('   - Outcome checking: every 5 min');
  console.log('   - Price alerts: every 1 min');
  console.log('   - Stats calculation: every 1 hour');
  console.log('   - Correlation analysis: every 24 hours');
  console.log('');

  // Initial run with delays
  await new Promise(r => setTimeout(r, 10000)); // Wait 10s for other services
  
  // Run immediately first time
  lastOutcomeCheck = 0;
  lastPriceCheck = 0;

  // Main loop - run every 30 seconds
  const LOOP_INTERVAL = 30 * 1000;
  
  while (true) {
    try {
      await runMonitoringTasks();
    } catch (error: any) {
      console.error('❌ Monitoring loop error:', error.message);
    }
    
    await new Promise(r => setTimeout(r, LOOP_INTERVAL));
  }
}

// Start
main().catch(console.error);

