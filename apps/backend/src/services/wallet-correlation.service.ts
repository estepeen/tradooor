/**
 * Wallet Correlation Service - Incremental correlation tracking
 * Updates correlation when new trades arrive (real-time)
 */
import { prisma } from '../lib/prisma.js';

export class WalletCorrelationService {
  /**
   * Update correlations after new BUY trade
   */
  async updateCorrelationsForTrade(tradeId: string): Promise<number> {
    const trade = await prisma.trade.findUnique({
      where: { id: tradeId },
      select: { id: true, walletId: true, tokenId: true, timestamp: true, side: true, pnlPercent: true },
    });

    if (!trade || trade.side !== 'buy') return 0;

    // Find other wallets that traded same token within ±2h
    const timeWindow = 2 * 60 * 60 * 1000;
    const otherTrades = await prisma.trade.findMany({
      where: {
        tokenId: trade.tokenId,
        walletId: { not: trade.walletId },
        side: 'buy',
        timestamp: {
          gte: new Date(trade.timestamp.getTime() - timeWindow),
          lte: new Date(trade.timestamp.getTime() + timeWindow),
        },
      },
      select: { id: true, walletId: true, timestamp: true, pnlPercent: true },
      distinct: ['walletId'],
    });

    if (otherTrades.length === 0) return 0;

    let updated = 0;
    for (const other of otherTrades) {
      await this.indexSharedTrade(trade, other);
      await this.updateCorrelationPair(trade.walletId, other.walletId);
      updated++;
    }

    return updated;
  }

  private async indexSharedTrade(tradeA: any, tradeB: any): Promise<void> {
    const [wA, wB, tA, tB] = tradeA.walletId < tradeB.walletId
      ? [tradeA.walletId, tradeB.walletId, tradeA, tradeB]
      : [tradeB.walletId, tradeA.walletId, tradeB, tradeA];

    const timeDiff = Math.round((tB.timestamp.getTime() - tA.timestamp.getTime()) / 60000);

    await prisma.sharedTradeIndex.upsert({
      where: { tradeAId_tradeBId: { tradeAId: tA.id, tradeBId: tB.id } },
      create: {
        id: `${tA.id}-${tB.id}`,
        walletAId: wA,
        walletBId: wB,
        tokenId: tA.tokenId,
        tradeAId: tA.id,
        tradeBId: tB.id,
        tradeATimestamp: tA.timestamp,
        tradeBTimestamp: tB.timestamp,
        timeDiffMinutes: timeDiff,
        tradeAPnl: tA.pnlPercent ? Number(tA.pnlPercent) : null,
        tradeBPnl: tB.pnlPercent ? Number(tB.pnlPercent) : null,
      },
      update: {
        tradeAPnl: tA.pnlPercent ? Number(tA.pnlPercent) : null,
        tradeBPnl: tB.pnlPercent ? Number(tB.pnlPercent) : null,
      },
    });
  }

  private async updateCorrelationPair(walletAId: string, walletBId: string): Promise<void> {
    const [wA, wB] = walletAId < walletBId ? [walletAId, walletBId] : [walletBId, walletAId];
    const metrics = await this.calculateMetrics(wA, wB);

    if (metrics.sharedTrades < 3) return;

    await prisma.walletCorrelation.upsert({
      where: { walletAId_walletBId: { walletAId: wA, walletBId: wB } },
      create: { id: `${wA}-${wB}`, walletAId: wA, walletBId: wB, ...metrics, lastCalculated: new Date() },
      update: { ...metrics, lastCalculated: new Date() },
    });
  }

  private async calculateMetrics(wA: string, wB: string) {
    const shared = await prisma.sharedTradeIndex.findMany({ where: { walletAId: wA, walletBId: wB } });
    if (shared.length === 0) return { sharedTrades: 0, totalTradesA: 0, totalTradesB: 0, overlapPercent: 0, avgTimeDiffMinutes: 0, jointSuccessRate: 0, profitCorrelation: 0, clusterStrength: 0 };

    const [totalA, totalB] = await Promise.all([
      prisma.trade.count({ where: { walletId: wA, side: 'buy' } }),
      prisma.trade.count({ where: { walletId: wB, side: 'buy' } }),
    ]);

    const overlapPercent = (shared.length / Math.min(totalA, totalB)) * 100;
    const avgTimeDiff = Math.round(shared.reduce((s, t) => s + Math.abs(t.timeDiffMinutes), 0) / shared.length);
    const validPnls = shared.filter(t => t.tradeAPnl !== null && t.tradeBPnl !== null);
    const jointSuccess = validPnls.length > 0 ? (validPnls.filter(t => t.tradeAPnl! > 0 && t.tradeBPnl! > 0).length / validPnls.length) * 100 : 0;
    const profitCorr = this.pearson(validPnls.map(t => t.tradeAPnl!), validPnls.map(t => t.tradeBPnl!));
    const strength = this.clusterStrength(shared.length, overlapPercent, avgTimeDiff, jointSuccess, profitCorr);

    return { sharedTrades: shared.length, totalTradesA: totalA, totalTradesB: totalB, overlapPercent, avgTimeDiffMinutes: avgTimeDiff, jointSuccessRate: jointSuccess, profitCorrelation: profitCorr, clusterStrength: strength };
  }

  private pearson(x: number[], y: number[]): number {
    if (x.length !== y.length || x.length === 0) return 0;
    const n = x.length;
    const sumX = x.reduce((s, v) => s + v, 0);
    const sumY = y.reduce((s, v) => s + v, 0);
    const sumXY = x.reduce((s, v, i) => s + v * y[i], 0);
    const sumX2 = x.reduce((s, v) => s + v * v, 0);
    const sumY2 = y.reduce((s, v) => s + v * v, 0);
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return den === 0 ? 0 : num / den;
  }

  private clusterStrength(shared: number, overlap: number, timeDiff: number, success: number, corr: number): number {
    let score = 0;
    score += Math.min(30, shared * 2);
    score += Math.min(20, overlap / 5);
    score += Math.max(0, 20 - timeDiff / 3);
    score += (success / 100) * 20;
    score += ((corr + 1) / 2) * 10;
    return Math.round(Math.min(100, Math.max(0, score)));
  }

  async checkCluster(walletIds: string[], minStrength: number = 70) {
    if (walletIds.length < 2) return { isCorrelated: false, avgStrength: 0, pairs: [] };
    
    const correlations = await prisma.walletCorrelation.findMany({
      where: {
        OR: walletIds.flatMap(wA => walletIds.filter(wB => wB !== wA && wA < wB).map(wB => ({ walletAId: wA, walletBId: wB }))),
        clusterStrength: { gte: minStrength },
      },
    });

    if (correlations.length === 0) return { isCorrelated: false, avgStrength: 0, pairs: [] };

    const avgStrength = Math.round(correlations.reduce((s, c) => s + c.clusterStrength, 0) / correlations.length);
    return { isCorrelated: true, avgStrength, pairs: correlations };
  }

  async getClusterPerformance(walletIds: string[]): Promise<number> {
    const shared = await prisma.sharedTradeIndex.findMany({
      where: {
        OR: walletIds.flatMap(wA => walletIds.filter(wB => wB !== wA && wA < wB).map(wB => ({ walletAId: wA, walletBId: wB }))),
        tradeAPnl: { not: null },
        tradeBPnl: { not: null },
      },
    });
    if (shared.length === 0) return 0;
    const bothProfit = shared.filter(t => t.tradeAPnl! > 0 && t.tradeBPnl! > 0).length;
    return Math.round((bothProfit / shared.length) * 100);
  }
}
