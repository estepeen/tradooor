import dotenv from 'dotenv';
import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { DailyStatsRepository } from '../repositories/daily-stats.repository.js';
import { SignalGateCheckRepository } from '../repositories/signal-gate-check.repository.js';
import { DiscordNotificationService } from '../services/discord-notification.service.js';

dotenv.config();

/**
 * Daily Summary Cron Job (ČÁST 12)
 *
 * Generates daily performance reports including:
 * - Signals received/blocked/emitted
 * - Gate failure breakdown
 * - Trade statistics
 * - PnL analysis
 * - Winrate and average win/loss
 *
 * Runs at midnight UTC by default.
 *
 * Usage:
 *   pnpm --filter backend daily-summary:cron
 *
 * Schedule (customizable via DAILY_SUMMARY_SCHEDULE):
 *   Default: "0 0 * * *" (midnight UTC)
 */

const dailyStatsRepo = new DailyStatsRepository();
const gateCheckRepo = new SignalGateCheckRepository();
const discord = new DiscordNotificationService();

interface DailySummary {
  date: string;
  signals: {
    received: number;
    blocked: number;
    emitted: number;
    passRate: number;
  };
  gateFailures: {
    liquidity: number;
    momentum: number;
    risk: number;
    wallet: number;
    mcap: number;
    other: number;
  };
  trades: {
    executed: number;
    successful: number;
    failed: number;
    successRate: number;
  };
  pnl: {
    totalSol: number;
    totalUsd: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgWinPercent: number | null;
    avgLossPercent: number | null;
    largestWinPercent: number | null;
    largestLossPercent: number | null;
  };
  exits: {
    sl: number;
    tp1: number;
    tp2: number;
    tp3: number;
    time: number;
    emergency: number;
    whaleDump: number;
  };
  timing: {
    signalsWithTiming: number;
    avgTotalMs: number | null;
    minTotalMs: number | null;
    maxTotalMs: number | null;
    avgHolderCheckMs: number | null;
    avgInsiderCheckMs: number | null;
    avgPreChecksMs: number | null;
  } | null;
}

async function calculateDailyStats(date: Date): Promise<DailySummary | null> {
  try {
    const stats = await dailyStatsRepo.getByDate(date);

    if (!stats) {
      console.log(`   No stats found for ${date.toISOString().split('T')[0]}`);
      return null;
    }

    const totalSignals = stats.signalsReceived || 0;
    const totalTrades = stats.wins + stats.losses;

    // Get timing stats for this day
    const nextDay = new Date(date);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    let timingStats = null;
    try {
      const rawTimingStats = await gateCheckRepo.getTimingStatsForDateRange(date, nextDay);
      if (rawTimingStats.count > 0) {
        timingStats = {
          signalsWithTiming: rawTimingStats.count,
          avgTotalMs: rawTimingStats.avgTotalMs,
          minTotalMs: rawTimingStats.minTotalMs,
          maxTotalMs: rawTimingStats.maxTotalMs,
          avgHolderCheckMs: rawTimingStats.avgHolderCheckMs,
          avgInsiderCheckMs: rawTimingStats.avgInsiderCheckMs,
          avgPreChecksMs: rawTimingStats.avgPreChecksMs,
        };
      }
    } catch (err: any) {
      console.warn(`   ⚠️  Could not get timing stats: ${err.message}`);
    }

    return {
      date: date.toISOString().split('T')[0],
      signals: {
        received: stats.signalsReceived,
        blocked: stats.signalsBlocked,
        emitted: stats.signalsEmitted,
        passRate: totalSignals > 0 ? (stats.signalsEmitted / totalSignals) * 100 : 0,
      },
      gateFailures: {
        liquidity: stats.blockedByLiquidity,
        momentum: stats.blockedByMomentum,
        risk: stats.blockedByRisk,
        wallet: stats.blockedByWallet,
        mcap: stats.blockedByMcap,
        other: stats.blockedByOther,
      },
      trades: {
        executed: stats.tradesExecuted,
        successful: stats.tradesSuccessful,
        failed: stats.tradesFailed,
        successRate: stats.tradesExecuted > 0
          ? (stats.tradesSuccessful / stats.tradesExecuted) * 100
          : 0,
      },
      pnl: {
        totalSol: Number(stats.totalPnlSol) || 0,
        totalUsd: Number(stats.totalPnlUsd) || 0,
        wins: stats.wins,
        losses: stats.losses,
        winRate: totalTrades > 0 ? (stats.wins / totalTrades) * 100 : null,
        avgWinPercent: stats.avgWinPercent ? Number(stats.avgWinPercent) : null,
        avgLossPercent: stats.avgLossPercent ? Number(stats.avgLossPercent) : null,
        largestWinPercent: stats.largestWinPercent ? Number(stats.largestWinPercent) : null,
        largestLossPercent: stats.largestLossPercent ? Number(stats.largestLossPercent) : null,
      },
      exits: {
        sl: stats.exitsBySl,
        tp1: stats.exitsByTp1,
        tp2: stats.exitsByTp2,
        tp3: stats.exitsByTp3,
        time: stats.exitsByTime,
        emergency: stats.exitsByEmergency,
        whaleDump: stats.exitsByWhaleDump,
      },
      timing: timingStats,
    };
  } catch (error: any) {
    console.error(`Error calculating daily stats: ${error.message}`);
    return null;
  }
}

function formatSummaryMessage(summary: DailySummary): string {
  const pnlEmoji = summary.pnl.totalSol >= 0 ? '🟢' : '🔴';
  const winRateEmoji = (summary.pnl.winRate ?? 0) >= 50 ? '✅' : '⚠️';

  let message = `
📊 **DAILY SUMMARY - ${summary.date}**

**SIGNALS:**
• Received: ${summary.signals.received}
• Blocked: ${summary.signals.blocked}
• Emitted: ${summary.signals.emitted}
• Pass Rate: ${summary.signals.passRate.toFixed(1)}%

**GATE FAILURES:**
• Liquidity: ${summary.gateFailures.liquidity}
• Momentum: ${summary.gateFailures.momentum}
• Risk: ${summary.gateFailures.risk}
• Wallet: ${summary.gateFailures.wallet}
• MCap: ${summary.gateFailures.mcap}
• Other: ${summary.gateFailures.other}

**TRADES:**
• Executed: ${summary.trades.executed}
• Successful: ${summary.trades.successful}
• Failed: ${summary.trades.failed}
• Success Rate: ${summary.trades.successRate.toFixed(1)}%

**PnL ${pnlEmoji}:**
• Total: ${summary.pnl.totalSol.toFixed(4)} SOL ($${summary.pnl.totalUsd.toFixed(2)})
• Wins: ${summary.pnl.wins} | Losses: ${summary.pnl.losses}
• ${winRateEmoji} Win Rate: ${summary.pnl.winRate?.toFixed(1) ?? 'N/A'}%
• Avg Win: +${summary.pnl.avgWinPercent?.toFixed(1) ?? 'N/A'}%
• Avg Loss: ${summary.pnl.avgLossPercent?.toFixed(1) ?? 'N/A'}%
• Best: +${summary.pnl.largestWinPercent?.toFixed(1) ?? 'N/A'}%
• Worst: ${summary.pnl.largestLossPercent?.toFixed(1) ?? 'N/A'}%

**EXIT REASONS:**
• Stop Loss: ${summary.exits.sl}
• TP1 (+25%): ${summary.exits.tp1}
• TP2 (+40%): ${summary.exits.tp2}
• TP3 (+70%): ${summary.exits.tp3}
• Time-based: ${summary.exits.time}
• Emergency: ${summary.exits.emergency}
• Whale Dump: ${summary.exits.whaleDump}
`.trim();

  // Add timing section if available
  if (summary.timing) {
    const t = summary.timing;
    const speedEmoji = t.avgTotalMs && t.avgTotalMs < 500 ? '⚡' : t.avgTotalMs && t.avgTotalMs < 1000 ? '🚀' : '🐢';
    message += `

**SIGNAL TIMING ${speedEmoji}:**
• Signals measured: ${t.signalsWithTiming}
• Avg Total: ${t.avgTotalMs?.toFixed(0) ?? 'N/A'}ms
• Min/Max: ${t.minTotalMs ?? 'N/A'}ms / ${t.maxTotalMs ?? 'N/A'}ms
• Holder Check: ${t.avgHolderCheckMs?.toFixed(0) ?? 'N/A'}ms
• Insider Check: ${t.avgInsiderCheckMs?.toFixed(0) ?? 'N/A'}ms
• Pre-checks: ${t.avgPreChecksMs?.toFixed(0) ?? 'N/A'}ms`;
  }

  return message;
}

async function generateDailySummary() {
  console.log(`\n⏰ [${new Date().toISOString()}] Generating daily summary...`);

  try {
    // Get yesterday's date (the completed day)
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);

    const summary = await calculateDailyStats(yesterday);

    if (!summary) {
      console.log('   No data for yesterday, skipping summary.');
      return;
    }

    const message = formatSummaryMessage(summary);
    console.log('\n' + message + '\n');

    // Send to Discord if enabled
    if (process.env.DISCORD_DAILY_SUMMARY_WEBHOOK) {
      try {
        await fetch(process.env.DISCORD_DAILY_SUMMARY_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: message,
          }),
        });
        console.log('   ✅ Daily summary sent to Discord');
      } catch (err: any) {
        console.warn(`   ⚠️  Failed to send Discord summary: ${err.message}`);
      }
    }

    // Also calculate weekly stats for context
    const weekStart = new Date(yesterday);
    weekStart.setUTCDate(weekStart.getUTCDate() - 6);

    const weeklyStats = await dailyStatsRepo.getAggregatedStats(weekStart, yesterday);

    console.log('\n📈 7-DAY OVERVIEW:');
    console.log(`   Total Signals: ${weeklyStats.totalSignalsReceived}`);
    console.log(`   Total Emitted: ${weeklyStats.totalSignalsEmitted}`);
    console.log(`   Total Trades: ${weeklyStats.totalTradesExecuted}`);
    console.log(`   Total PnL: ${weeklyStats.totalPnlSol.toFixed(4)} SOL`);
    console.log(`   Overall Win Rate: ${weeklyStats.overallWinRate ? (weeklyStats.overallWinRate * 100).toFixed(1) : 'N/A'}%`);
    console.log(`   Avg Daily PnL: ${weeklyStats.avgDailyPnlSol.toFixed(4)} SOL`);

  } catch (error: any) {
    console.error('❌ Error generating daily summary:', error.message);
  }
}

async function main() {
  // Default: midnight UTC (0 0 * * *)
  const cronSchedule = process.env.DAILY_SUMMARY_SCHEDULE || '0 0 * * *';

  console.log(`🚀 Starting daily summary cron job`);
  console.log(`📅 Schedule: ${cronSchedule}`);
  console.log(`   (Default: midnight UTC. Set DAILY_SUMMARY_SCHEDULE env var to customize)`);

  // Run once on start if requested
  if (process.env.RUN_ON_START === 'true') {
    await generateDailySummary();
  }

  // Schedule cron job
  cron.schedule(cronSchedule, async () => {
    await generateDailySummary();
  });

  // Keep process running
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down daily summary cron...');
    process.exit(0);
  });

  console.log('✅ Daily summary cron job is running. Press Ctrl+C to stop.');
}

main();
