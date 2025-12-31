import Redis from 'ioredis';

/**
 * Redis service for communication with Rust trading bot
 * Uses LIST (LPUSH/BRPOP) for reliable message delivery
 */
class RedisService {
  private client: Redis | null = null;
  private isConnected = false;

  constructor() {
    this.connect();
  }

  private connect(): void {
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

    try {
      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 3) {
            console.warn('⚠️  [Redis] Max retries reached, giving up');
            return null;
          }
          return Math.min(times * 100, 3000);
        },
        lazyConnect: true,
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        console.log('✅ [Redis] Connected');
      });

      this.client.on('error', (err) => {
        console.warn('⚠️  [Redis] Error:', err.message);
        this.isConnected = false;
      });

      this.client.on('close', () => {
        this.isConnected = false;
        console.log('🔌 [Redis] Disconnected');
      });

      // Attempt to connect
      this.client.connect().catch((err) => {
        console.warn('⚠️  [Redis] Initial connection failed:', err.message);
      });
    } catch (error: any) {
      console.warn('⚠️  [Redis] Failed to initialize:', error.message);
    }
  }

  /**
   * Push a NINJA signal to the trading bot queue
   */
  async pushNinjaSignal(signal: NinjaSignalPayload): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      console.warn('⚠️  [Redis] Not connected, skipping NINJA signal push');
      return false;
    }

    try {
      const queueName = process.env.REDIS_NINJA_QUEUE || 'ninja_signals';
      const payload = JSON.stringify(signal);

      await this.client.lpush(queueName, payload);
      console.log(`🥷 [Redis] NINJA signal pushed to queue: ${signal.tokenSymbol} (${signal.tokenMint.substring(0, 8)}...)`);
      return true;
    } catch (error: any) {
      console.error('❌ [Redis] Failed to push NINJA signal:', error.message);
      return false;
    }
  }

  /**
   * Check if Redis is connected
   */
  isReady(): boolean {
    return this.isConnected;
  }

  /**
   * Graceful shutdown
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
    }
  }
}

/**
 * Payload structure for NINJA signal (must match Rust NinjaSignal struct)
 */
export interface NinjaSignalPayload {
  signalType: 'ninja';
  tokenSymbol: string;
  tokenMint: string;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  entryPriceUsd: number | null;
  stopLossPercent: number;
  takeProfitPercent: number;
  strength: string;
  timestamp: string;
  wallets: Array<{
    address: string;
    label: string | null;
    score: number | null;
  }>;
}

// Singleton instance
export const redisService = new RedisService();
