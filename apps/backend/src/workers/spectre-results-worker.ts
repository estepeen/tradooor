/**
 * SPECTRE Results Worker
 *
 * Listens for trade results from SPECTRE Rust bot via Redis
 * and saves them to PostgreSQL for analysis
 */

import Redis from 'ioredis';
import { spectreTradeService } from '../services/spectre-trade.service.js';
import { DiscordNotificationService, SpectreTradeNotificationData } from '../services/discord-notification.service.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const RESULTS_QUEUE = 'spectre_trade_results';

interface SpectreTradeResult {
  success: boolean;
  tokenMint: string;
  tokenSymbol: string;
  action: string; // 'buy' | 'sell'
  amountSol: number;
  amountTokens?: number;
  pricePerToken?: number;
  txSignature?: string;
  error?: string;
  latencyMs: number;
  timestamp: string;
  // Additional fields from signal
  signalType?: string;
  signalStrength?: string;
  marketCapUsd?: number;
  liquidityUsd?: number;
  entryPriceUsd?: number;
  stopLossPercent?: number;
  takeProfitPercent?: number;
  triggerWallets?: Array<{ address: string; label: string | null; score: number | null }>;
  // Signal timestamp (when signal was generated)
  signalTimestamp?: string;
}

class SpectreResultsWorker {
  private redis: Redis | null = null;
  private isRunning = false;
  private discordService: DiscordNotificationService;

  constructor() {
    this.discordService = new DiscordNotificationService();
  }

  async start() {
    console.log('👻 [SpectreResultsWorker] Starting...');

    try {
      this.redis = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 5) {
            console.error('❌ [SpectreResultsWorker] Max retries reached');
            return null;
          }
          return Math.min(times * 1000, 5000);
        },
      });

      this.redis.on('connect', () => {
        console.log('✅ [SpectreResultsWorker] Connected to Redis');
      });

      this.redis.on('error', (err) => {
        console.error('❌ [SpectreResultsWorker] Redis error:', err.message);
      });

      this.isRunning = true;
      await this.processLoop();
    } catch (error: any) {
      console.error('❌ [SpectreResultsWorker] Failed to start:', error.message);
    }
  }

  private async processLoop() {
    console.log(`📡 [SpectreResultsWorker] Listening on queue: ${RESULTS_QUEUE}`);

    while (this.isRunning && this.redis) {
      try {
        // BRPOP with 5 second timeout
        const result = await this.redis.brpop(RESULTS_QUEUE, 5);

        if (result) {
          const [, payload] = result;
          await this.processResult(payload);
        }
      } catch (error: any) {
        if (this.isRunning) {
          console.error('❌ [SpectreResultsWorker] Error in process loop:', error.message);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  private async processResult(payload: string) {
    try {
      const result: SpectreTradeResult = JSON.parse(payload);

      console.log(`👻 [SpectreResultsWorker] Received: ${result.action.toUpperCase()} ${result.tokenSymbol} - ${result.success ? '✅' : '❌'}`);

      // Send Discord notification
      try {
        const notificationData: SpectreTradeNotificationData = {
          action: result.action as 'buy' | 'sell',
          success: result.success,
          tokenSymbol: result.tokenSymbol,
          tokenMint: result.tokenMint,
          amountSol: result.amountSol,
          amountTokens: result.amountTokens,
          txSignature: result.txSignature,
          error: result.error,
          signalType: result.signalType,
          signalStrength: result.signalStrength,
          // Use signalTimestamp if available, fallback to timestamp (trade execution time)
          signalTimestamp: result.signalTimestamp || result.timestamp,
          signalMarketCapUsd: result.marketCapUsd,
          tradeTimestamp: result.timestamp, // timestamp field = trade execution time
          tradeMarketCapUsd: result.marketCapUsd,
          latencyMs: result.latencyMs,
          // Entry price (for both buy and sell)
          entryPriceUsd: result.entryPriceUsd,
          // Exit info for sells
          exitPriceUsd: result.pricePerToken,
          // Position settings
          stopLossPercent: result.stopLossPercent,
          takeProfitPercent: result.takeProfitPercent,
        };

        // Calculate PnL for sells if we have entry and exit prices
        if (result.action === 'sell' && result.entryPriceUsd && result.pricePerToken && result.amountTokens) {
          const entryValue = result.entryPriceUsd * result.amountTokens;
          const exitValue = result.pricePerToken * result.amountTokens;
          notificationData.pnlUsd = exitValue - entryValue;
          notificationData.pnlPercent = ((result.pricePerToken / result.entryPriceUsd) - 1) * 100;

          // Determine exit reason based on PnL
          if (result.stopLossPercent && notificationData.pnlPercent <= -result.stopLossPercent * 0.8) {
            notificationData.exitReason = 'stop_loss';
          } else if (result.takeProfitPercent && notificationData.pnlPercent >= result.takeProfitPercent * 0.8) {
            notificationData.exitReason = 'take_profit';
          }
        }

        await this.discordService.sendSpectreTradeNotification(notificationData);
      } catch (discordError: any) {
        console.error(`⚠️ [SpectreResultsWorker] Discord notification failed: ${discordError.message}`);
      }

      // Save to database
      await spectreTradeService.saveTrade({
        signalType: result.signalType || 'ninja',
        signalStrength: result.signalStrength || 'medium',
        tokenMint: result.tokenMint,
        tokenSymbol: result.tokenSymbol,
        side: result.action,
        amountSol: result.amountSol,
        amountTokens: result.amountTokens,
        pricePerToken: result.pricePerToken,
        txSignature: result.txSignature,
        marketCapUsd: result.marketCapUsd,
        liquidityUsd: result.liquidityUsd,
        entryPriceUsd: result.entryPriceUsd,
        stopLossPercent: result.stopLossPercent,
        takeProfitPercent: result.takeProfitPercent,
        success: result.success,
        error: result.error,
        latencyMs: result.latencyMs,
        triggerWallets: result.triggerWallets,
        signalTimestamp: result.timestamp,
      });
    } catch (error: any) {
      console.error('❌ [SpectreResultsWorker] Failed to process result:', error.message);
      console.error('   Payload preview:', payload.substring(0, 200));
    }
  }

  async stop() {
    console.log('👋 [SpectreResultsWorker] Stopping...');
    this.isRunning = false;
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }
}

// Start worker
const worker = new SpectreResultsWorker();
worker.start();

// Graceful shutdown
process.on('SIGINT', async () => {
  await worker.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await worker.stop();
  process.exit(0);
});
