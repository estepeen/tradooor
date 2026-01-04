/**
 * PumpPortal WebSocket Service for tracking unique buyers
 *
 * Connects to PumpPortal WebSocket and tracks unique buyers for each token
 * in real-time. Used as a final gate check in NINJA signal generation.
 *
 * Features:
 * - Real-time trade stream from PumpPortal
 * - In-memory tracking of unique buyers per token
 * - Auto-cleanup after configurable time window
 * - Reconnection with exponential backoff
 */

import WebSocket from 'ws';

const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data';

// How long to track buyers for a token (default: 30 minutes)
const DEFAULT_TRACKING_DURATION_MS = 30 * 60 * 1000;

// Reconnection settings
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 60000;

interface TokenTracker {
  mint: string;
  firstSeen: number;
  uniqueBuyers: Set<string>;
  uniqueSellers: Set<string>;
  buyCount: number;
  sellCount: number;
  totalBuyVolumeSol: number;
  totalSellVolumeSol: number;
  cleanupTimeout: NodeJS.Timeout;
}

interface TradeEvent {
  signature?: string;
  mint: string;
  solAmount?: number;
  tokenAmount?: number;
  isBuy?: boolean;
  user?: string;
  timestamp?: number;
  virtualSolReserves?: number;
  virtualTokenReserves?: number;
  marketCapSol?: number;
}

export class PumpPortalTrackerService {
  private ws: WebSocket | null = null;
  private activeTokens: Map<string, TokenTracker> = new Map();
  private subscribedTokens: Set<string> = new Set();
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private isConnected = false;
  private trackingDurationMs: number;
  private shouldReconnect = true;

  constructor(trackingDurationMs: number = DEFAULT_TRACKING_DURATION_MS) {
    this.trackingDurationMs = trackingDurationMs;
  }

  /**
   * Start the WebSocket connection
   */
  async start(): Promise<void> {
    this.shouldReconnect = true;
    await this.connect();
  }

  /**
   * Stop the service and cleanup
   */
  stop(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;

    // Clear all tracking timeouts
    for (const tracker of this.activeTokens.values()) {
      clearTimeout(tracker.cleanupTimeout);
    }
    this.activeTokens.clear();
    this.subscribedTokens.clear();
  }

  /**
   * Subscribe to trade updates for a specific token
   */
  subscribeToken(mint: string): void {
    if (this.subscribedTokens.has(mint)) {
      return; // Already subscribed
    }

    this.subscribedTokens.add(mint);

    // Initialize tracker if not exists
    if (!this.activeTokens.has(mint)) {
      this.initTracker(mint);
    }

    // Send subscribe message if connected
    if (this.isConnected && this.ws) {
      this.sendSubscribe([mint]);
    }
  }

  /**
   * Get unique buyers count for a token
   * Returns null if token is not being tracked
   */
  getUniqueBuyers(mint: string): number | null {
    const tracker = this.activeTokens.get(mint);
    if (!tracker) {
      return null;
    }
    return tracker.uniqueBuyers.size;
  }

  /**
   * Get unique sellers count for a token
   */
  getUniqueSellers(mint: string): number | null {
    const tracker = this.activeTokens.get(mint);
    if (!tracker) {
      return null;
    }
    return tracker.uniqueSellers.size;
  }

  /**
   * Get full tracker stats for a token
   */
  getTrackerStats(mint: string): {
    uniqueBuyers: number;
    uniqueSellers: number;
    buyCount: number;
    sellCount: number;
    totalBuyVolumeSol: number;
    totalSellVolumeSol: number;
    trackingAgeMs: number;
  } | null {
    const tracker = this.activeTokens.get(mint);
    if (!tracker) {
      return null;
    }

    return {
      uniqueBuyers: tracker.uniqueBuyers.size,
      uniqueSellers: tracker.uniqueSellers.size,
      buyCount: tracker.buyCount,
      sellCount: tracker.sellCount,
      totalBuyVolumeSol: tracker.totalBuyVolumeSol,
      totalSellVolumeSol: tracker.totalSellVolumeSol,
      trackingAgeMs: Date.now() - tracker.firstSeen,
    };
  }

  /**
   * Check if service is connected
   */
  isServiceConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Get number of tokens being tracked
   */
  getTrackedTokenCount(): number {
    return this.activeTokens.size;
  }

  // ==================== Private Methods ====================

  private async connect(): Promise<void> {
    return new Promise((resolve) => {
      console.log(`[PumpPortal] Connecting to ${PUMPPORTAL_WS_URL}...`);

      this.ws = new WebSocket(PUMPPORTAL_WS_URL);

      this.ws.on('open', () => {
        console.log('[PumpPortal] Connected');
        this.isConnected = true;
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

        // Re-subscribe to all tokens
        if (this.subscribedTokens.size > 0) {
          this.sendSubscribe(Array.from(this.subscribedTokens));
        }

        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', () => {
        console.log('[PumpPortal] Disconnected');
        this.isConnected = false;
        this.ws = null;

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error: Error) => {
        console.error('[PumpPortal] WebSocket error:', error.message);
      });
    });
  }

  private scheduleReconnect(): void {
    console.log(`[PumpPortal] Reconnecting in ${this.reconnectDelay / 1000}s...`);

    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      this.connect().catch((err) => {
        console.error('[PumpPortal] Reconnection failed:', err.message);
      });
    }, this.reconnectDelay);
  }

  private sendSubscribe(mints: string[]): void {
    if (!this.ws || !this.isConnected) {
      return;
    }

    const message = JSON.stringify({
      method: 'subscribeTokenTrade',
      keys: mints,
    });

    this.ws.send(message);
    console.log(`[PumpPortal] Subscribed to ${mints.length} token(s)`);
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const text = data.toString();
      const event = JSON.parse(text) as TradeEvent | { message?: string };

      // Skip subscription confirmation messages
      if ('message' in event) {
        return;
      }

      const trade = event as TradeEvent;

      // Validate trade event
      if (!trade.mint || !trade.user) {
        return;
      }

      // Get or create tracker
      let tracker = this.activeTokens.get(trade.mint);
      if (!tracker) {
        // Only track if we're subscribed to this token
        if (!this.subscribedTokens.has(trade.mint)) {
          return;
        }
        tracker = this.initTracker(trade.mint);
      }

      // Update tracker
      const isBuy = trade.isBuy === true;
      const solAmount = trade.solAmount || 0;

      if (isBuy) {
        tracker.uniqueBuyers.add(trade.user);
        tracker.buyCount++;
        tracker.totalBuyVolumeSol += solAmount;
      } else {
        tracker.uniqueSellers.add(trade.user);
        tracker.sellCount++;
        tracker.totalSellVolumeSol += solAmount;
      }
    } catch {
      // Ignore parse errors
    }
  }

  private initTracker(mint: string): TokenTracker {
    // Clear existing tracker if any
    const existing = this.activeTokens.get(mint);
    if (existing) {
      clearTimeout(existing.cleanupTimeout);
    }

    const tracker: TokenTracker = {
      mint,
      firstSeen: Date.now(),
      uniqueBuyers: new Set(),
      uniqueSellers: new Set(),
      buyCount: 0,
      sellCount: 0,
      totalBuyVolumeSol: 0,
      totalSellVolumeSol: 0,
      cleanupTimeout: setTimeout(() => {
        this.cleanupTracker(mint);
      }, this.trackingDurationMs),
    };

    this.activeTokens.set(mint, tracker);
    return tracker;
  }

  private cleanupTracker(mint: string): void {
    const tracker = this.activeTokens.get(mint);
    if (tracker) {
      clearTimeout(tracker.cleanupTimeout);
      this.activeTokens.delete(mint);
      this.subscribedTokens.delete(mint);
      console.log(`[PumpPortal] Cleaned up tracker for ${mint.substring(0, 8)}... (had ${tracker.uniqueBuyers.size} unique buyers)`);
    }
  }
}

// Singleton instance
let instance: PumpPortalTrackerService | null = null;

export function getPumpPortalTracker(): PumpPortalTrackerService {
  if (!instance) {
    instance = new PumpPortalTrackerService();
  }
  return instance;
}

export function startPumpPortalTracker(): Promise<void> {
  const tracker = getPumpPortalTracker();
  return tracker.start();
}

export function stopPumpPortalTracker(): void {
  if (instance) {
    instance.stop();
    instance = null;
  }
}
