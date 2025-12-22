import dotenv from 'dotenv';
import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';

dotenv.config();

type WalletRow = {
  id: string;
  winRate: number;
  advancedStats: any | null;
  recentPnl30dPercent: number;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const percentile = (value: number, allValues: number[]): number => {
  const filtered = allValues.filter(v => Number.isFinite(v));
  if (!filtered.length) return 0;
  const sorted = [...filtered].sort((a, b) => a - b);
  const rank = sorted.filter(v => v <= value).length;
  return rank / sorted.length;
};

async function calculateAndUpdatePercentiles() {
  console.log(
    `\n⏰ [${new Date().toISOString()}] Starting wallet percentile calculation...`
  );

  const wallets = (await prisma.smartWallet.findMany({
    select: {
      id: true,
      winRate: true,
      recentPnl30dPercent: true,
      advancedStats: true,
    },
  })) as WalletRow[];

  if (wallets.length === 0) {
    console.log('⚠️  No wallets found, skipping percentile calculation.');
    return;
  }

  // Extract base metrics
  const winRates = wallets.map(w => w.winRate ?? 0);
  const roiValues = wallets.map(w => {
    const rolling90 =
      (w.advancedStats as any)?.rolling?.['90d'] ??
      (w.advancedStats as any)?.rolling?.['30d'];
    const roi = rolling90?.realizedRoiPercent;
    return Number.isFinite(roi) ? roi : w.recentPnl30dPercent ?? 0;
  });
  const profitFactors = wallets.map(w => {
    const pf = (w.advancedStats as any)?.profitFactor;
    return Number.isFinite(pf) ? pf : 0;
  });
  const volumes = wallets.map(w => {
    const v = (w.advancedStats as any)?.rolling?.['90d']?.totalVolumeUsd;
    return Number.isFinite(v) ? v : 0;
  });

  // Calculate percentiles per wallet
  const updates = wallets.map(w => {
    const winRateVal = w.winRate ?? 0;
    const roiVal = roiValues[wallets.indexOf(w)];
    const pfVal = profitFactors[wallets.indexOf(w)];
    const volVal = volumes[wallets.indexOf(w)];

    const winRatePercentile = percentile(winRateVal, winRates);
    const roiPercentile = percentile(roiVal, roiValues);
    const profitFactorPercentile = percentile(pfVal, profitFactors);
    const volumePercentile = percentile(volVal, volumes);

    return {
      id: w.id,
      winRatePercentile: clamp(winRatePercentile, 0, 1),
      roiPercentile: clamp(roiPercentile, 0, 1),
      profitFactorPercentile: clamp(profitFactorPercentile, 0, 1),
      volumePercentile: clamp(volumePercentile, 0, 1),
    };
  });

  // Persist percentiles back to SmartWallet
  for (const u of updates) {
    await prisma.smartWallet.update({
      where: { id: u.id },
      data: {
        percentileRankWinRate: u.winRatePercentile,
        percentileRankRoi: u.roiPercentile,
        // Additional percentiles can be added to schema later if needed
      },
    });
  }

  console.log(
    `✅ Updated percentiles for ${updates.length} wallets (winRate & ROI).`
  );
}

async function main() {
  const cronSchedule = process.env.WALLET_PERCENTILES_CRON || '0 3 * * *'; // default: daily at 03:00 UTC

  console.log('🚀 Starting wallet percentiles cron job');
  console.log(`📅 Schedule: ${cronSchedule}`);

  // Run once on start (optional)
  if (process.env.RUN_ON_START !== 'false') {
    await calculateAndUpdatePercentiles();
  }

  cron.schedule(cronSchedule, async () => {
    await calculateAndUpdatePercentiles();
  });

  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down wallet percentiles cron...');
    process.exit(0);
  });

  console.log('✅ Wallet percentiles cron job is running. Press Ctrl+C to stop.');
}

main().catch(error => {
  console.error('❌ Wallet percentiles cron job failed:', error);
  process.exit(1);
});


