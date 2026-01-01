import Redis from 'ioredis';

/**
 * Redis service for communication with SPECTRE trading bot
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
   * Push a signal to the SPECTRE trading bot queue
   */
  async pushSignal(signal: SpectreSignalPayload): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      console.warn('⚠️  [Redis] Not connected, skipping signal push');
      return false;
    }

    try {
      const queueName = process.env.REDIS_SPECTRE_QUEUE || 'spectre_signals';
      const payload = JSON.stringify(signal);

      await this.client.lpush(queueName, payload);
      console.log(`👻 [Redis] Signal pushed to queue: ${signal.tokenSymbol} (${signal.tokenMint.substring(0, 8)}...) [${signal.signalType.toUpperCase()}]`);
      return true;
    } catch (error: any) {
      console.error('❌ [Redis] Failed to push signal:', error.message);
      return false;
    }
  }

  /**
   * Push a pre-signal to SPECTRE to prepare TX skeleton (after 1st wallet buy)
   * This allows SPECTRE to build the TX in advance for faster execution
   */
  async pushPreSignal(preSignal: SpectrePreSignalPayload): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      console.warn('⚠️  [Redis] Not connected, skipping pre-signal push');
      return false;
    }

    try {
      const queueName = 'spectre_pre_signals';
      const payload = JSON.stringify(preSignal);

      await this.client.lpush(queueName, payload);
      console.log(`⚡ [Redis] Pre-signal pushed: ${preSignal.tokenSymbol} (${preSignal.tokenMint.substring(0, 8)}...) - TX will be prepared`);
      return true;
    } catch (error: any) {
      console.error('❌ [Redis] Failed to push pre-signal:', error.message);
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
 * Payload structure for SPECTRE signal (must match Rust SpectreSignal struct)
 */
export interface SpectreSignalPayload {
  signalType: 'ninja' | 'consensus';
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

/**
 * Pre-signal payload - sent before signal confirmation to prepare TX
 * Tier 1 & 2: Sent after 2 wallets (need 3 for signal)
 * Tier 3 & 4: Sent after 3 wallets (need 4 for signal)
 * SPECTRE will build the TX skeleton and cache it for fast execution
 */
export interface SpectrePreSignalPayload {
  tokenMint: string;
  tokenSymbol: string;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  entryPriceUsd: number | null;
  timestamp: string;
  firstWallet: {
    address: string;
    label: string | null;
    score: number | null;
  };
  // Extended info for tiered system
  tier?: string;                    // e.g., "Tier 1", "Tier 2", etc.
  currentWallets?: number;          // Current wallet count
  requiredWallets?: number;         // Required wallets for signal
  allWallets?: Array<{              // All wallets that bought so far
    address: string;
    label: string | null;
    score: number | null;
  }>;
}

// Singleton instance
export const redisService = new RedisService();
