import 'dotenv/config';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { TradeFeatureRepository } from '../repositories/trade-feature.repository.js';
import { TradeOutcomeRepository } from '../repositories/trade-outcome.repository.js';
import { TraderCharacterizationService } from '../services/trader-characterization.service.js';

const queueRepo = new WalletProcessingQueueRepository();
const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();
const metricsHistoryRepo = new MetricsHistoryRepository();
const tradeFeatureRepo = new TradeFeatureRepository();
const tradeOutcomeRepo = new TradeOutcomeRepository();
const metricsCalculator = new MetricsCalculatorService(
  smartWalletRepo,
  tradeRepo,
  metricsHistoryRepo
);
const lotMatchingService = new LotMatchingService();
const traderCharacterizationService = new TraderCharacterizationService(
  tradeRepo,
  tradeFeatureRepo,
  tradeOutcomeRepo,
  smartWalletRepo
);

const IDLE_DELAY_MS = Number(process.env.METRICS_WORKER_IDLE_MS || 2000);
const MAX_BACKOFF_MS = Number(process.env.METRICS_WORKER_MAX_BACKOFF_MS || 5 * 60 * 1000); // 5 min

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function computeBackoff(attempts: number) {
  const base = Math.min(attempts, 5);
  return Math.min((base || 1) * 30_000, MAX_BACKOFF_MS); // 30s, 60s, 90s...
}

async function processMetricsJob(job: { id: string; walletId: string }) {
  console.log(`⚙️  [Worker] Processing wallet ${job.walletId}`);

  // Timeout protection: max 120 sekund na wallet (worker má více času než cron)
  const processWallet = async () => {
    // 1. Rebuild closed lots and open positions (FIFO matching)
    const { closedLots, openPositions } = await lotMatchingService.processTradesForWallet(job.walletId);
    await lotMatchingService.saveClosedLots(closedLots);
    
    // Save open positions (or delete if none)
    if (openPositions.length > 0) {
      await lotMatchingService.saveOpenPositions(openPositions);
    } else {
      // Delete all open positions for this wallet (all positions are closed)
      await lotMatchingService.deleteOpenPositionsForWallet(job.walletId);
    }

    // 2. Recalculate metrics (score, win rate, pnl, etc.)
    const metricsResult = await metricsCalculator.calculateMetricsForWallet(job.walletId);

    // 3. Update behavior profile and auto-tags (SEPARATED - only for AI/ML)
    try {
      await traderCharacterizationService.calculateBehaviorProfile(job.walletId);
      console.log(`✅  [Worker] Behavior profile updated for wallet ${job.walletId}`);
    } catch (error: any) {
      // Don't fail the job if behavior profile calculation fails
      console.warn(`⚠️  [Worker] Failed to update behavior profile for wallet ${job.walletId}: ${error?.message || error}`);
    }

    return metricsResult;
  };

  // Timeout: 120 sekund na wallet
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Processing timeout (120s)')), 120000)
  );

  try {
    const metricsResult = await Promise.race([processWallet(), timeoutPromise]) as any;
    console.log(
      `✅  [Worker] Wallet ${job.walletId} updated (score=${metricsResult?.score ?? 'n/a'})`
    );
  } catch (error: any) {
    // Re-throw error so worker queue can handle retry
    throw error;
  }
}

async function runWorker() {
  console.log('🚀 Wallet processing worker started');

  while (true) {
    try {
      const job = await queueRepo.claimNextJob();

      if (!job) {
        await sleep(IDLE_DELAY_MS);
        continue;
      }

      try {
        switch (job.jobType) {
          case 'metrics':
            await processMetricsJob(job);
            break;
          default:
            console.warn(`⚠️  Unknown job type "${job.jobType}", marking as completed.`);
        }

        await queueRepo.markCompleted(job.id);
      } catch (jobError: any) {
        const delay = computeBackoff(job.attempts);
        console.error(
          `❌ Job ${job.id} failed (attempt ${job.attempts}): ${jobError?.message || jobError}`
        );
        await queueRepo.markFailed(job.id, jobError?.message || 'Unknown error', delay);
      }
    } catch (loopError: any) {
      console.error('❌ Worker loop error:', loopError?.message || loopError);
      await sleep(IDLE_DELAY_MS);
    }
  }
}

runWorker().catch(error => {
  console.error('❌ Fatal worker error:', error);
  process.exit(1);
});

