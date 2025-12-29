import { prisma, generateId } from '../lib/prisma.js';

export interface SignalPerformanceRecord {
  id: string;
  signalId: string;
  tokenId: string;

  // Entry data
  entryPriceUsd: number;
  entryMarketCapUsd: number | null;
  entryLiquidityUsd: number | null;
  entryTimestamp: Date;

  // Price tracking
  currentPriceUsd: number | null;
  highestPriceUsd: number | null;
  lowestPriceUsd: number | null;
  highestPriceTime: Date | null;
  lowestPriceTime: Date | null;

  // PnL tracking
  currentPnlPercent: number | null;
  maxPnlPercent: number | null;
  minPnlPercent: number | null;
  drawdownFromPeak: number | null;

  // Milestone snapshots
  priceSnapshots: Record<string, number> | null;
  pnlSnapshots: Record<string, number> | null;

  // Timing analysis
  timeToPeakMinutes: number | null;
  timeToTroughMinutes: number | null;

  // Outcome
  status: 'active' | 'closed' | 'expired';
  exitReason: string | null;
  exitPriceUsd: number | null;
  exitTimestamp: Date | null;
  realizedPnlPercent: number | null;

  // Optimal exit analysis
  optimalExitPrice: number | null;
  optimalExitTime: Date | null;
  missedPnlPercent: number | null;

  lastUpdated: Date;
  createdAt: Date;
}

// Milestone intervals in minutes
export const MILESTONES = [5, 15, 30, 60, 120, 240, 480, 720, 1440] as const;
export type MilestoneMinutes = typeof MILESTONES[number];

export class SignalPerformanceRepository {
  async create(data: {
    signalId: string;
    tokenId: string;
    entryPriceUsd: number;
    entryMarketCapUsd?: number | null;
    entryLiquidityUsd?: number | null;
    entryTimestamp?: Date;
  }): Promise<SignalPerformanceRecord> {
    const entryPrice = data.entryPriceUsd;

    const result = await prisma.signalPerformance.create({
      data: {
        id: generateId(),
        signalId: data.signalId,
        tokenId: data.tokenId,
        entryPriceUsd: entryPrice,
        entryMarketCapUsd: data.entryMarketCapUsd ?? undefined,
        entryLiquidityUsd: data.entryLiquidityUsd ?? undefined,
        entryTimestamp: data.entryTimestamp || new Date(),
        // Initialize price tracking with entry values
        currentPriceUsd: entryPrice,
        highestPriceUsd: entryPrice,
        lowestPriceUsd: entryPrice,
        highestPriceTime: data.entryTimestamp || new Date(),
        lowestPriceTime: data.entryTimestamp || new Date(),
        // Initialize PnL at 0%
        currentPnlPercent: 0,
        maxPnlPercent: 0,
        minPnlPercent: 0,
        drawdownFromPeak: 0,
        // Initialize snapshots
        priceSnapshots: {},
        pnlSnapshots: {},
        status: 'active',
      },
    });

    return this.mapToRecord(result);
  }

  async findById(id: string): Promise<SignalPerformanceRecord | null> {
    const result = await prisma.signalPerformance.findUnique({
      where: { id },
    });
    return result ? this.mapToRecord(result) : null;
  }

  async findBySignalId(signalId: string): Promise<SignalPerformanceRecord | null> {
    const result = await prisma.signalPerformance.findUnique({
      where: { signalId },
    });
    return result ? this.mapToRecord(result) : null;
  }

  async findActive(options?: {
    tokenId?: string;
    limit?: number;
    orderBy?: 'entryTimestamp' | 'currentPnlPercent' | 'maxPnlPercent';
    orderDirection?: 'asc' | 'desc';
  }): Promise<SignalPerformanceRecord[]> {
    const where: any = { status: 'active' };

    if (options?.tokenId) {
      where.tokenId = options.tokenId;
    }

    const orderBy = options?.orderBy || 'entryTimestamp';
    const orderDirection = options?.orderDirection || 'desc';

    const results = await prisma.signalPerformance.findMany({
      where,
      orderBy: { [orderBy]: orderDirection },
      ...(options?.limit && { take: options.limit }),
    });

    return results.map(this.mapToRecord);
  }

  async updatePriceTracking(
    signalId: string,
    currentPriceUsd: number,
    now: Date = new Date()
  ): Promise<SignalPerformanceRecord | null> {
    const existing = await prisma.signalPerformance.findUnique({
      where: { signalId },
    });

    if (!existing) return null;

    const entryPrice = Number(existing.entryPriceUsd);
    const currentPnlPercent = ((currentPriceUsd - entryPrice) / entryPrice) * 100;

    // Calculate time since entry
    const entryTime = existing.entryTimestamp.getTime();
    const elapsedMinutes = Math.floor((now.getTime() - entryTime) / 60000);

    // Update high/low tracking
    const highestPrice = Math.max(Number(existing.highestPriceUsd) || entryPrice, currentPriceUsd);
    const lowestPrice = Math.min(Number(existing.lowestPriceUsd) || entryPrice, currentPriceUsd);

    const highestPnl = ((highestPrice - entryPrice) / entryPrice) * 100;
    const lowestPnl = ((lowestPrice - entryPrice) / entryPrice) * 100;

    // Calculate drawdown from peak
    const drawdownFromPeak = highestPrice > 0 ? ((highestPrice - currentPriceUsd) / highestPrice) * 100 : 0;

    // Determine if we have a new high/low
    const isNewHigh = currentPriceUsd > (Number(existing.highestPriceUsd) || 0);
    const isNewLow = currentPriceUsd < (Number(existing.lowestPriceUsd) || Infinity);

    // Check if we need to record a milestone
    const existingPriceSnapshots = (existing.priceSnapshots as Record<string, number>) || {};
    const existingPnlSnapshots = (existing.pnlSnapshots as Record<string, number>) || {};

    const newPriceSnapshots = { ...existingPriceSnapshots };
    const newPnlSnapshots = { ...existingPnlSnapshots };

    for (const milestone of MILESTONES) {
      const key = `${milestone}m`;
      if (elapsedMinutes >= milestone && !existingPriceSnapshots[key]) {
        newPriceSnapshots[key] = currentPriceUsd;
        newPnlSnapshots[key] = currentPnlPercent;
      }
    }

    // Calculate time to peak/trough
    const timeToPeakMinutes = isNewHigh
      ? elapsedMinutes
      : (existing.timeToPeakMinutes ?? null);
    const timeToTroughMinutes = isNewLow
      ? elapsedMinutes
      : (existing.timeToTroughMinutes ?? null);

    const result = await prisma.signalPerformance.update({
      where: { signalId },
      data: {
        currentPriceUsd,
        currentPnlPercent,
        highestPriceUsd: highestPrice,
        lowestPriceUsd: lowestPrice,
        maxPnlPercent: highestPnl,
        minPnlPercent: lowestPnl,
        drawdownFromPeak,
        ...(isNewHigh && { highestPriceTime: now }),
        ...(isNewLow && { lowestPriceTime: now }),
        priceSnapshots: newPriceSnapshots,
        pnlSnapshots: newPnlSnapshots,
        timeToPeakMinutes,
        timeToTroughMinutes,
        lastUpdated: now,
      },
    });

    return this.mapToRecord(result);
  }

  async close(
    signalId: string,
    exitReason: string,
    exitPriceUsd: number,
    exitTimestamp: Date = new Date()
  ): Promise<SignalPerformanceRecord | null> {
    const existing = await prisma.signalPerformance.findUnique({
      where: { signalId },
    });

    if (!existing) return null;

    const entryPrice = Number(existing.entryPriceUsd);
    const realizedPnlPercent = ((exitPriceUsd - entryPrice) / entryPrice) * 100;

    // Calculate missed PnL (how much more could have been made)
    const maxPrice = Number(existing.highestPriceUsd) || exitPriceUsd;
    const maxPnl = ((maxPrice - entryPrice) / entryPrice) * 100;
    const missedPnlPercent = maxPnl - realizedPnlPercent;

    const result = await prisma.signalPerformance.update({
      where: { signalId },
      data: {
        status: 'closed',
        exitReason,
        exitPriceUsd,
        exitTimestamp,
        realizedPnlPercent,
        optimalExitPrice: maxPrice,
        optimalExitTime: existing.highestPriceTime,
        missedPnlPercent: missedPnlPercent > 0 ? missedPnlPercent : 0,
        lastUpdated: exitTimestamp,
      },
    });

    return this.mapToRecord(result);
  }

  async expire(signalId: string): Promise<SignalPerformanceRecord | null> {
    const existing = await prisma.signalPerformance.findUnique({
      where: { signalId },
    });

    if (!existing) return null;

    const result = await prisma.signalPerformance.update({
      where: { signalId },
      data: {
        status: 'expired',
        exitReason: 'time_based',
        exitPriceUsd: existing.currentPriceUsd,
        exitTimestamp: new Date(),
        realizedPnlPercent: existing.currentPnlPercent,
        lastUpdated: new Date(),
      },
    });

    return this.mapToRecord(result);
  }

  async getAnalytics(options?: {
    days?: number;
    signalType?: string;
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
  }> {
    const where: any = {};

    if (options?.days) {
      where.entryTimestamp = {
        gte: new Date(Date.now() - options.days * 24 * 60 * 60 * 1000),
      };
    }

    if (options?.tokenId) {
      where.tokenId = options.tokenId;
    }

    const allSignals = await prisma.signalPerformance.findMany({ where });
    const closedSignals = allSignals.filter(s => s.status === 'closed');
    const activeSignals = allSignals.filter(s => s.status === 'active');

    const avgMaxPnl = allSignals.length > 0
      ? allSignals.reduce((sum, s) => sum + (Number(s.maxPnlPercent) || 0), 0) / allSignals.length
      : 0;

    const avgRealizedPnl = closedSignals.length > 0
      ? closedSignals.reduce((sum, s) => sum + (Number(s.realizedPnlPercent) || 0), 0) / closedSignals.length
      : 0;

    const avgMissedPnl = closedSignals.length > 0
      ? closedSignals.reduce((sum, s) => sum + (Number(s.missedPnlPercent) || 0), 0) / closedSignals.length
      : 0;

    const avgTimeToPeak = closedSignals.filter(s => s.timeToPeakMinutes != null).length > 0
      ? closedSignals.filter(s => s.timeToPeakMinutes != null)
          .reduce((sum, s) => sum + (s.timeToPeakMinutes || 0), 0) /
        closedSignals.filter(s => s.timeToPeakMinutes != null).length
      : 0;

    const winCount = closedSignals.filter(s => Number(s.realizedPnlPercent) > 0).length;
    const winRate = closedSignals.length > 0 ? (winCount / closedSignals.length) * 100 : 0;

    return {
      totalSignals: allSignals.length,
      activeSignals: activeSignals.length,
      closedSignals: closedSignals.length,
      avgMaxPnl,
      avgRealizedPnl,
      avgMissedPnl,
      avgTimeToPeakMinutes: avgTimeToPeak,
      winRate,
    };
  }

  private mapToRecord(result: any): SignalPerformanceRecord {
    return {
      id: result.id,
      signalId: result.signalId,
      tokenId: result.tokenId,
      entryPriceUsd: Number(result.entryPriceUsd),
      entryMarketCapUsd: result.entryMarketCapUsd ? Number(result.entryMarketCapUsd) : null,
      entryLiquidityUsd: result.entryLiquidityUsd ? Number(result.entryLiquidityUsd) : null,
      entryTimestamp: result.entryTimestamp,
      currentPriceUsd: result.currentPriceUsd ? Number(result.currentPriceUsd) : null,
      highestPriceUsd: result.highestPriceUsd ? Number(result.highestPriceUsd) : null,
      lowestPriceUsd: result.lowestPriceUsd ? Number(result.lowestPriceUsd) : null,
      highestPriceTime: result.highestPriceTime ?? null,
      lowestPriceTime: result.lowestPriceTime ?? null,
      currentPnlPercent: result.currentPnlPercent ? Number(result.currentPnlPercent) : null,
      maxPnlPercent: result.maxPnlPercent ? Number(result.maxPnlPercent) : null,
      minPnlPercent: result.minPnlPercent ? Number(result.minPnlPercent) : null,
      drawdownFromPeak: result.drawdownFromPeak ? Number(result.drawdownFromPeak) : null,
      priceSnapshots: result.priceSnapshots as Record<string, number> ?? null,
      pnlSnapshots: result.pnlSnapshots as Record<string, number> ?? null,
      timeToPeakMinutes: result.timeToPeakMinutes ?? null,
      timeToTroughMinutes: result.timeToTroughMinutes ?? null,
      status: result.status as 'active' | 'closed' | 'expired',
      exitReason: result.exitReason ?? null,
      exitPriceUsd: result.exitPriceUsd ? Number(result.exitPriceUsd) : null,
      exitTimestamp: result.exitTimestamp ?? null,
      realizedPnlPercent: result.realizedPnlPercent ? Number(result.realizedPnlPercent) : null,
      optimalExitPrice: result.optimalExitPrice ? Number(result.optimalExitPrice) : null,
      optimalExitTime: result.optimalExitTime ?? null,
      missedPnlPercent: result.missedPnlPercent ? Number(result.missedPnlPercent) : null,
      lastUpdated: result.lastUpdated,
      createdAt: result.createdAt,
    };
  }
}
