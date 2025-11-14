import { prisma } from '@solbot/db';

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
    return prisma.smartWalletMetricsHistory.create({
      data,
    });
  }

  async findByWalletId(walletId: string, fromDate?: Date) {
    return prisma.smartWalletMetricsHistory.findMany({
      where: {
        walletId,
        ...(fromDate && { timestamp: { gte: fromDate } }),
      },
      orderBy: { timestamp: 'asc' },
    });
  }
}

