import { prisma } from '../lib/prisma.js';

export interface PaperTradeRecord {
  id: string;
  walletId: string;
  tokenId: string;
  originalTradeId: string | null;
  side: 'buy' | 'sell';
  amountToken: number;
  amountBase: number;
  priceBasePerToken: number;
  timestamp: Date;
  status: 'open' | 'closed' | 'cancelled';
  realizedPnl: number | null;
  realizedPnlPercent: number | null;
  closedAt: Date | null;
  meta: Record<string, any> | null;
}

export interface PaperPortfolioRecord {
  id: string;
  timestamp: Date;
  totalValueUsd: number;
  totalCostUsd: number;
  totalPnlUsd: number;
  totalPnlPercent: number;
  openPositions: number;
  closedPositions: number;
  winRate: number | null;
  totalTrades: number;
  meta: Record<string, any> | null;
}

const toNumber = (value: any) => (value === null || value === undefined ? 0 : Number(value));

export class PaperTradeRepository {
  async create(data: {
    walletId: string;
    tokenId: string;
    originalTradeId?: string | null;
    side: 'buy' | 'sell';
    amountToken: number;
    amountBase: number;
    priceBasePerToken: number;
    timestamp?: Date;
    status?: 'open' | 'closed' | 'cancelled';
    realizedPnl?: number | null;
    realizedPnlPercent?: number | null;
    closedAt?: Date | null;
    meta?: Record<string, any> | null;
  }): Promise<PaperTradeRecord> {
    const id = `pt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    
    const result = await prisma.paperTrade.create({
      data: {
        id,
        walletId: data.walletId,
        tokenId: data.tokenId,
        originalTradeId: data.originalTradeId ?? null,
        side: data.side,
        amountToken: data.amountToken,
        amountBase: data.amountBase,
        priceBasePerToken: data.priceBasePerToken,
        timestamp: data.timestamp || new Date(),
        status: data.status || 'open',
        realizedPnl: data.realizedPnl ?? null,
        realizedPnlPercent: data.realizedPnlPercent ?? null,
        closedAt: data.closedAt ?? null,
        meta: data.meta ?? null,
      },
    });

    return result as PaperTradeRecord;
  }

  async findById(id: string): Promise<PaperTradeRecord | null> {
    const result = await prisma.paperTrade.findUnique({
      where: { id },
    });

    return result as PaperTradeRecord | null;
  }

  async findByWallet(walletId: string, options?: {
    status?: 'open' | 'closed' | 'cancelled';
    limit?: number;
    orderBy?: 'timestamp' | 'closedAt';
    orderDirection?: 'asc' | 'desc';
  }): Promise<PaperTradeRecord[]> {
    const where: any = { walletId };

    if (options?.status) {
      where.status = options.status;
    }

    const orderBy = options?.orderBy || 'timestamp';
    const orderDirection = options?.orderDirection || 'desc';

    const results = await prisma.paperTrade.findMany({
      where,
      orderBy: { [orderBy]: orderDirection },
      ...(options?.limit && { take: options.limit }),
    });

    return results as PaperTradeRecord[];
  }

  async findOpenPositions(walletId?: string): Promise<PaperTradeRecord[]> {
    const where: any = { status: 'open' };

    if (walletId) {
      where.walletId = walletId;
    }

    const results = await prisma.paperTrade.findMany({ where });

    return results as PaperTradeRecord[];
  }

  async update(id: string, data: Partial<{
    status: 'open' | 'closed' | 'cancelled';
    realizedPnl: number | null;
    realizedPnlPercent: number | null;
    closedAt: Date | null;
    meta: Record<string, any> | null;
  }>): Promise<PaperTradeRecord> {
    const result = await prisma.paperTrade.update({
      where: { id },
      data,
    });

    return result as PaperTradeRecord;
  }

  async getPortfolioStats(): Promise<{
    totalValueUsd: number;
    totalCostUsd: number;
    totalPnlUsd: number;
    totalPnlPercent: number;
    openPositions: number;
    closedPositions: number;
    winRate: number | null;
    totalTrades: number;
    initialCapital: number;
    byModel?: {
      'smart-copy': {
        totalTrades: number;
        openPositions: number;
        closedPositions: number;
        totalPnlUsd: number;
        totalPnlPercent: number;
        winRate: number | null;
        totalCostUsd: number;
      };
      'consensus': {
        totalTrades: number;
        openPositions: number;
        closedPositions: number;
        totalPnlUsd: number;
        totalPnlPercent: number;
        winRate: number | null;
        totalCostUsd: number;
      };
    };
  }> {
    const INITIAL_CAPITAL_USD = 1000;
    
    const [openPositions, closedPositions, closedBuys, allClosed] = await Promise.all([
      this.findOpenPositions(),
      prisma.paperTrade.findMany({
        where: { status: 'closed' },
        select: { realizedPnl: true, realizedPnlPercent: true },
      }),
      prisma.paperTrade.findMany({
        where: { status: 'closed', side: 'buy' },
        select: { amountBase: true },
      }),
      prisma.paperTrade.findMany({
        where: { status: 'closed', side: 'buy' },
        select: { realizedPnl: true, realizedPnlPercent: true, amountBase: true, meta: true },
      }),
    ]);

    const totalTrades = openPositions.length + closedPositions.length;
    
    // Calculate total cost
    const openCost = openPositions.reduce((sum, pos) => {
      return sum + (pos.side === 'buy' ? toNumber(pos.amountBase) : 0);
    }, 0);

    const closedCost = closedBuys.reduce((sum, pos) => {
      return sum + toNumber(pos.amountBase);
    }, 0);

    const totalCostUsd = openCost + closedCost;

    // Calculate total REALIZED PnL
    const totalRealizedPnl = closedPositions.reduce((sum, pos) => {
      return sum + (toNumber(pos.realizedPnl) || 0);
    }, 0);

    const totalPnlUsd = totalRealizedPnl;
    const totalPnlPercent = INITIAL_CAPITAL_USD > 0 ? (totalPnlUsd / INITIAL_CAPITAL_USD) * 100 : 0;
    const totalValueUsd = INITIAL_CAPITAL_USD + totalRealizedPnl;

    // Calculate win rate
    const winningTrades = closedPositions.filter(pos => (toNumber(pos.realizedPnl) || 0) > 0).length;
    const winRate = closedPositions.length > 0 ? winningTrades / closedPositions.length : null;

    // Calculate stats by model
    const smartCopyOpen = openPositions.filter(pos => pos.meta?.model === 'smart-copy');
    const consensusOpen = openPositions.filter(pos => pos.meta?.model === 'consensus');
    
    const smartCopyClosed = allClosed.filter((pos: any) => {
      const meta = pos.meta || {};
      return meta.model === 'smart-copy';
    });
    const consensusClosed = allClosed.filter((pos: any) => {
      const meta = pos.meta || {};
      return meta.model === 'consensus';
    });

    // Smart Copy stats
    const smartCopyTotalTrades = smartCopyOpen.length + smartCopyClosed.length;
    const smartCopyOpenCost = smartCopyOpen.reduce((sum, pos) => sum + toNumber(pos.amountBase), 0);
    const smartCopyClosedCost = smartCopyClosed.reduce((sum: any, pos: any) => sum + toNumber(pos.amountBase), 0);
    const smartCopyTotalCost = smartCopyOpenCost + smartCopyClosedCost;
    const smartCopyTotalPnl = smartCopyClosed.reduce((sum: any, pos: any) => sum + (toNumber(pos.realizedPnl) || 0), 0);
    const smartCopyTotalPnlPercent = smartCopyTotalCost > 0 ? (smartCopyTotalPnl / smartCopyTotalCost) * 100 : 0;
    const smartCopyWinning = smartCopyClosed.filter((pos: any) => (toNumber(pos.realizedPnl) || 0) > 0).length;
    const smartCopyWinRate = smartCopyClosed.length > 0 ? smartCopyWinning / smartCopyClosed.length : null;

    // Consensus stats
    const consensusTotalTrades = consensusOpen.length + consensusClosed.length;
    const consensusOpenCost = consensusOpen.reduce((sum, pos) => sum + toNumber(pos.amountBase), 0);
    const consensusClosedCost = consensusClosed.reduce((sum: any, pos: any) => sum + toNumber(pos.amountBase), 0);
    const consensusTotalCost = consensusOpenCost + consensusClosedCost;
    const consensusTotalPnl = consensusClosed.reduce((sum: any, pos: any) => sum + (toNumber(pos.realizedPnl) || 0), 0);
    const consensusTotalPnlPercent = consensusTotalCost > 0 ? (consensusTotalPnl / consensusTotalCost) * 100 : 0;
    const consensusWinning = consensusClosed.filter((pos: any) => (toNumber(pos.realizedPnl) || 0) > 0).length;
    const consensusWinRate = consensusClosed.length > 0 ? consensusWinning / consensusClosed.length : null;

    return {
      totalValueUsd,
      totalCostUsd,
      totalPnlUsd,
      totalPnlPercent,
      openPositions: openPositions.length,
      closedPositions: closedPositions.length,
      winRate,
      totalTrades,
      initialCapital: INITIAL_CAPITAL_USD,
      byModel: {
        'smart-copy': {
          totalTrades: smartCopyTotalTrades,
          openPositions: smartCopyOpen.length,
          closedPositions: smartCopyClosed.length,
          totalPnlUsd: smartCopyTotalPnl,
          totalPnlPercent: smartCopyTotalPnlPercent,
          winRate: smartCopyWinRate,
          totalCostUsd: smartCopyTotalCost,
        },
        'consensus': {
          totalTrades: consensusTotalTrades,
          openPositions: consensusOpen.length,
          closedPositions: consensusClosed.length,
          totalPnlUsd: consensusTotalPnl,
          totalPnlPercent: consensusTotalPnlPercent,
          winRate: consensusWinRate,
          totalCostUsd: consensusTotalCost,
        },
      },
    };
  }

  async createPortfolioSnapshot(stats: {
    totalValueUsd: number;
    totalCostUsd: number;
    totalPnlUsd: number;
    totalPnlPercent: number;
    openPositions: number;
    closedPositions: number;
    winRate: number | null;
    totalTrades: number;
  }): Promise<PaperPortfolioRecord> {
    const id = `pp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const result = await prisma.paperPortfolio.create({
      data: {
        id,
        timestamp: new Date(),
        totalValueUsd: stats.totalValueUsd,
        totalCostUsd: stats.totalCostUsd,
        totalPnlUsd: stats.totalPnlUsd,
        totalPnlPercent: stats.totalPnlPercent,
        openPositions: stats.openPositions,
        closedPositions: stats.closedPositions,
        winRate: stats.winRate,
        totalTrades: stats.totalTrades,
        meta: null,
      },
    });

    return result as PaperPortfolioRecord;
  }
}
