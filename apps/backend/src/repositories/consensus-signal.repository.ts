import { prisma } from '../lib/prisma.js';

export interface ConsensusSignalData {
  id?: string;
  tokenId: string;
  walletCount: number;
  firstTradeTime: string | Date;
  latestTradeTime: string | Date;
  trades: any[];
  tokenSecurity?: any | null;
}

export class ConsensusSignalRepository {
  async create(data: ConsensusSignalData) {
    const result = await prisma.consensusSignal.create({
      data: {
        tokenId: data.tokenId,
        walletCount: data.walletCount,
        firstTradeTime: typeof data.firstTradeTime === 'string' 
          ? new Date(data.firstTradeTime)
          : data.firstTradeTime,
        latestTradeTime: typeof data.latestTradeTime === 'string'
          ? new Date(data.latestTradeTime)
          : data.latestTradeTime,
        trades: data.trades,
        tokenSecurity: data.tokenSecurity,
      },
    });

    return result;
  }

  async update(id: string, data: Partial<ConsensusSignalData>) {
    const updateData: any = {};
    
    if (data.walletCount !== undefined) updateData.walletCount = data.walletCount;
    if (data.firstTradeTime !== undefined) {
      updateData.firstTradeTime = typeof data.firstTradeTime === 'string'
        ? new Date(data.firstTradeTime)
        : data.firstTradeTime;
    }
    if (data.latestTradeTime !== undefined) {
      updateData.latestTradeTime = typeof data.latestTradeTime === 'string'
        ? new Date(data.latestTradeTime)
        : data.latestTradeTime;
    }
    if (data.trades !== undefined) updateData.trades = data.trades;
    if (data.tokenSecurity !== undefined) updateData.tokenSecurity = data.tokenSecurity;

    const result = await prisma.consensusSignal.update({
      where: { id },
      data: updateData,
    });

    return result;
  }

  async findByTokenAndTimeWindow(
    tokenId: string,
    firstTradeTime: Date,
    windowMs: number = 2 * 60 * 60 * 1000 // 2 hours default
  ) {
    const windowStart = new Date(firstTradeTime.getTime() - windowMs);
    const windowEnd = new Date(firstTradeTime.getTime() + windowMs);

    const results = await prisma.consensusSignal.findMany({
      where: {
        tokenId,
        firstTradeTime: {
          gte: windowStart,
          lte: windowEnd,
        },
      },
      orderBy: { firstTradeTime: 'desc' },
      take: 1,
    });

    return results.length > 0 ? results[0] : null;
  }

  async findRecent(limit: number = 100, hours: number = 1) {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const results = await prisma.consensusSignal.findMany({
      where: {
        latestTradeTime: { gte: since },
      },
      include: {
        token: {
          select: {
            id: true,
            symbol: true,
            name: true,
            mintAddress: true,
          },
        },
      },
      orderBy: { latestTradeTime: 'desc' },
      take: limit,
    });

    return results;
  }

  async findAll(limit: number = 100) {
    const results = await prisma.consensusSignal.findMany({
      include: {
        token: {
          select: {
            id: true,
            symbol: true,
            name: true,
            mintAddress: true,
          },
        },
      },
      orderBy: { latestTradeTime: 'desc' },
      take: limit,
    });

    return results;
  }
}
