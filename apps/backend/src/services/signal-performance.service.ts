/**
 * Signal Performance Service
 *
 * Tracks and analyzes performance of trading signals over time.
 * Captures price milestones, max/min tracking, and optimal exit analysis.
 */

import { SignalPerformanceRepository, SignalPerformanceRecord, MILESTONES } from '../repositories/signal-performance.repository.js';
import { TokenMarketDataService } from './token-market-data.service.js';
import { prisma } from '../lib/prisma.js';

export interface SignalWithPerformance {
  signal: {
    id: string;
    type: string;
    tokenId: string;
    walletId: string;
    timestamp: Date;
    status: string;
    meta: Record<string, any> | null;
  };
  performance: SignalPerformanceRecord | null;
  token: {
    id: string;
    mintAddress: string;
    symbol: string | null;
  };
}

export class SignalPerformanceService {
  private performanceRepo: SignalPerformanceRepository;
  private tokenMarketData: TokenMarketDataService;

  constructor() {
    this.performanceRepo = new SignalPerformanceRepository();
    this.tokenMarketData = new TokenMarketDataService();
  }

  /**
   * Creates performance tracking record for a signal
   */
  async createPerformanceRecord(
    signalId: string,
    tokenId: string,
    entryPriceUsd: number,
    marketData?: {
      marketCapUsd?: number;
      liquidityUsd?: number;
    }
  ): Promise<SignalPerformanceRecord> {
    console.log(`📊 [SignalPerf] Creating performance record for signal ${signalId.substring(0, 8)}...`);

    const record = await this.performanceRepo.create({
      signalId,
      tokenId,
      entryPriceUsd,
      entryMarketCapUsd: marketData?.marketCapUsd,
      entryLiquidityUsd: marketData?.liquidityUsd,
      entryTimestamp: new Date(),
    });

    console.log(`✅ [SignalPerf] Created performance record ${record.id.substring(0, 8)}`);
    return record;
  }

  /**
   * Updates performance record with current price
   */
  async updatePerformance(
    signalId: string,
    currentPriceUsd: number
  ): Promise<SignalPerformanceRecord | null> {
    return this.performanceRepo.updatePriceTracking(signalId, currentPriceUsd);
  }

  /**
   * Updates all active signal performances with current prices
   * Called by cron job
   */
  async updateAllActivePerformances(): Promise<{
    updated: number;
    errors: number;
    expired: number;
  }> {
    const stats = { updated: 0, errors: 0, expired: 0 };

    // Get all active performances
    const activePerformances = await this.performanceRepo.findActive({ limit: 100 });
    console.log(`📊 [SignalPerf] Updating ${activePerformances.length} active performances...`);

    if (activePerformances.length === 0) {
      return stats;
    }

    // Get token mint addresses
    const tokenIds = [...new Set(activePerformances.map(p => p.tokenId))];
    const tokens = await prisma.token.findMany({
      where: { id: { in: tokenIds } },
      select: { id: true, mintAddress: true },
    });
    const tokenMap = new Map(tokens.map(t => [t.id, t.mintAddress]));

    // Batch fetch prices
    const mintAddresses = tokens.map(t => t.mintAddress);
    const priceMap = new Map<string, number>();

    for (const mint of mintAddresses) {
      try {
        const marketData = await this.tokenMarketData.getMarketData(mint);
        if (marketData?.price) {
          priceMap.set(mint, marketData.price);
        }
      } catch (error) {
        // Continue with other tokens
      }
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Update each performance
    const now = new Date();
    const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours

    for (const perf of activePerformances) {
      try {
        // Check if expired
        const ageMs = now.getTime() - perf.entryTimestamp.getTime();
        if (ageMs >= maxAgeMs) {
          await this.performanceRepo.expire(perf.signalId);
          stats.expired++;
          continue;
        }

        // Get current price
        const mint = tokenMap.get(perf.tokenId);
        if (!mint) {
          stats.errors++;
          continue;
        }

        const currentPrice = priceMap.get(mint);
        if (!currentPrice) {
          stats.errors++;
          continue;
        }

        // Update performance
        await this.performanceRepo.updatePriceTracking(perf.signalId, currentPrice, now);
        stats.updated++;
      } catch (error) {
        console.error(`❌ [SignalPerf] Error updating ${perf.signalId}:`, error);
        stats.errors++;
      }
    }

    console.log(`✅ [SignalPerf] Updated ${stats.updated}, expired ${stats.expired}, errors ${stats.errors}`);
    return stats;
  }

  /**
   * Closes a performance record
   */
  async closePerformance(
    signalId: string,
    exitReason: string,
    exitPriceUsd: number
  ): Promise<SignalPerformanceRecord | null> {
    console.log(`📊 [SignalPerf] Closing performance for signal ${signalId.substring(0, 8)}, reason: ${exitReason}`);
    return this.performanceRepo.close(signalId, exitReason, exitPriceUsd);
  }

  /**
   * Gets performance record for a signal
   */
  async getPerformance(signalId: string): Promise<SignalPerformanceRecord | null> {
    return this.performanceRepo.findBySignalId(signalId);
  }

  /**
   * Gets signals with their performance data
   */
  async getSignalsWithPerformance(options?: {
    status?: 'active' | 'closed' | 'expired';
    limit?: number;
    hours?: number;
  }): Promise<SignalWithPerformance[]> {
    const where: any = {};

    if (options?.status) {
      where.status = options.status;
    }

    if (options?.hours) {
      where.timestamp = {
        gte: new Date(Date.now() - options.hours * 60 * 60 * 1000),
      };
    }

    const signals = await prisma.signal.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: options?.limit || 50,
      include: {
        token: {
          select: { id: true, mintAddress: true, symbol: true },
        },
        performance: true,
      },
    });

    return signals.map(signal => ({
      signal: {
        id: signal.id,
        type: signal.type,
        tokenId: signal.tokenId,
        walletId: signal.walletId,
        timestamp: signal.timestamp,
        status: signal.status,
        meta: signal.meta as Record<string, any> | null,
      },
      performance: signal.performance ? {
        id: signal.performance.id,
        signalId: signal.performance.signalId,
        tokenId: signal.performance.tokenId,
        entryPriceUsd: Number(signal.performance.entryPriceUsd),
        entryMarketCapUsd: signal.performance.entryMarketCapUsd ? Number(signal.performance.entryMarketCapUsd) : null,
        entryLiquidityUsd: signal.performance.entryLiquidityUsd ? Number(signal.performance.entryLiquidityUsd) : null,
        entryTimestamp: signal.performance.entryTimestamp,
        currentPriceUsd: signal.performance.currentPriceUsd ? Number(signal.performance.currentPriceUsd) : null,
        highestPriceUsd: signal.performance.highestPriceUsd ? Number(signal.performance.highestPriceUsd) : null,
        lowestPriceUsd: signal.performance.lowestPriceUsd ? Number(signal.performance.lowestPriceUsd) : null,
        highestPriceTime: signal.performance.highestPriceTime,
        lowestPriceTime: signal.performance.lowestPriceTime,
        currentPnlPercent: signal.performance.currentPnlPercent ? Number(signal.performance.currentPnlPercent) : null,
        maxPnlPercent: signal.performance.maxPnlPercent ? Number(signal.performance.maxPnlPercent) : null,
        minPnlPercent: signal.performance.minPnlPercent ? Number(signal.performance.minPnlPercent) : null,
        drawdownFromPeak: signal.performance.drawdownFromPeak ? Number(signal.performance.drawdownFromPeak) : null,
        priceSnapshots: signal.performance.priceSnapshots as Record<string, number> | null,
        pnlSnapshots: signal.performance.pnlSnapshots as Record<string, number> | null,
        timeToPeakMinutes: signal.performance.timeToPeakMinutes,
        timeToTroughMinutes: signal.performance.timeToTroughMinutes,
        status: signal.performance.status as 'active' | 'closed' | 'expired',
        exitReason: signal.performance.exitReason,
        exitPriceUsd: signal.performance.exitPriceUsd ? Number(signal.performance.exitPriceUsd) : null,
        exitTimestamp: signal.performance.exitTimestamp,
        realizedPnlPercent: signal.performance.realizedPnlPercent ? Number(signal.performance.realizedPnlPercent) : null,
        optimalExitPrice: signal.performance.optimalExitPrice ? Number(signal.performance.optimalExitPrice) : null,
        optimalExitTime: signal.performance.optimalExitTime,
        missedPnlPercent: signal.performance.missedPnlPercent ? Number(signal.performance.missedPnlPercent) : null,
        lastUpdated: signal.performance.lastUpdated,
        createdAt: signal.performance.createdAt,
      } : null,
      token: signal.token,
    }));
  }

  /**
   * Gets aggregated analytics
   */
  async getAnalytics(options?: {
    days?: number;
    tokenId?: string;
  }): Promise<{
    totalSignals: number;
    activeSignals: number;
    closedSignals: number;
    avgMaxPnl: number;
    avgRealizedPnl: number;
    avgMissedPnl: number;
    avgTimeToPeakMinutes: number;
    winRate: number;
    byMilestone: Record<string, { avgPnl: number; count: number }>;
  }> {
    const baseAnalytics = await this.performanceRepo.getAnalytics(options);

    // Calculate milestone analytics
    const performances = await this.performanceRepo.findActive();
    const closedPerformances = (await prisma.signalPerformance.findMany({
      where: { status: 'closed' },
    }));

    const allPerformances = [...performances, ...closedPerformances.map(p => ({
      ...p,
      pnlSnapshots: p.pnlSnapshots as Record<string, number> | null,
    }))];

    const byMilestone: Record<string, { avgPnl: number; count: number }> = {};

    for (const milestone of MILESTONES) {
      const key = `${milestone}m`;
      const withMilestone = allPerformances.filter(p =>
        p.pnlSnapshots && (p.pnlSnapshots as Record<string, number>)[key] !== undefined
      );

      if (withMilestone.length > 0) {
        const avgPnl = withMilestone.reduce((sum, p) =>
          sum + ((p.pnlSnapshots as Record<string, number>)[key] || 0), 0
        ) / withMilestone.length;

        byMilestone[key] = {
          avgPnl,
          count: withMilestone.length,
        };
      }
    }

    return {
      ...baseAnalytics,
      byMilestone,
    };
  }
}
