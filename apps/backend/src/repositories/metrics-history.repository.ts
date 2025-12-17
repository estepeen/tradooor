import prisma, { generateId } from '../lib/prisma.js';

export class MetricsHistoryRepository {
  async create(data: {
    walletId: string;
    timestamp: Date;
    score: number;
    totalTrades: number;
    winRate: number;
    avgRr: number;
    avgPnlPercent: number;
    pnlTotalBase: number;
    avgHoldingTimeMin: number;
    maxDrawdownPercent: number;
    recentPnl30dPercent: number;
  }) {
    const result = await prisma.smartWalletMetricsHistory.create({
      data: {
        id: generateId(),
        walletId: data.walletId,
        timestamp: data.timestamp,
        score: data.score,
        totalTrades: data.totalTrades,
        winRate: data.winRate,
        avgRr: data.avgRr,
        avgPnlPercent: data.avgPnlPercent,
        pnlTotalBase: data.pnlTotalBase,
        avgHoldingTimeMin: data.avgHoldingTimeMin,
        maxDrawdownPercent: data.maxDrawdownPercent,
        recentPnl30dPercent: data.recentPnl30dPercent,
      },
    });

    return result;
  }

  async findByWalletId(walletId: string, fromDate?: Date) {
    const where: any = { walletId };

    if (fromDate) {
      where.timestamp = { gte: fromDate };
    }

    const history = await prisma.smartWalletMetricsHistory.findMany({
      where,
      orderBy: { timestamp: 'asc' },
    });

    return history;
  }
}
