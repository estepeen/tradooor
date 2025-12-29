import { prisma, generateId } from '../lib/prisma.js';

export interface VirtualPositionRecord {
  id: string;
  tokenId: string;
  signalId: string | null;
  consensusSignalId: string | null;

  // Entry data
  entryPriceUsd: number;
  entryTimestamp: Date;
  entryWalletCount: number;
  entryMarketCapUsd: number | null;
  entryLiquidityUsd: number | null;

  // Position tracking
  positionSizeUsd: number | null;
  currentPriceUsd: number | null;
  lastPriceUpdate: Date | null;

  // PnL tracking
  unrealizedPnlPercent: number | null;
  unrealizedPnlUsd: number | null;

  // Price extremes
  highestPriceUsd: number | null;
  lowestPriceUsd: number | null;
  drawdownFromPeak: number | null;

  // Wallet tracking
  walletIds: string[];
  activeWalletCount: number;
  exitedWalletCount: number;

  // Exit strategy
  suggestedStopLoss: number | null;
  suggestedTakeProfit: number | null;
  trailingStopPercent: number | null;
  trailingStopPrice: number | null;

  // AI exit tracking
  lastAiDecision: string | null;
  lastAiConfidence: number | null;
  lastAiReasoning: string | null;
  lastAiEvaluation: Date | null;

  // Status
  status: 'open' | 'partial_exit' | 'closed' | 'stopped';
  exitReason: string | null;
  exitPriceUsd: number | null;
  exitTimestamp: Date | null;
  realizedPnlPercent: number | null;
  realizedPnlUsd: number | null;

  // Notifications
  lastNotificationSent: Date | null;
  notificationCount: number;

  createdAt: Date;
  updatedAt: Date;
}

export class VirtualPositionRepository {
  async create(data: {
    tokenId: string;
    signalId?: string | null;
    consensusSignalId?: string | null;
    entryPriceUsd: number;
    entryTimestamp?: Date;
    entryWalletCount?: number;
    entryMarketCapUsd?: number | null;
    entryLiquidityUsd?: number | null;
    positionSizeUsd?: number | null;
    walletIds?: string[];
    suggestedStopLoss?: number | null;
    suggestedTakeProfit?: number | null;
    trailingStopPercent?: number | null;
  }): Promise<VirtualPositionRecord> {
    const entryPrice = data.entryPriceUsd;
    const walletIds = data.walletIds || [];

    const result = await prisma.virtualPosition.create({
      data: {
        id: generateId(),
        tokenId: data.tokenId,
        signalId: data.signalId ?? null,
        consensusSignalId: data.consensusSignalId ?? null,
        entryPriceUsd: entryPrice,
        entryTimestamp: data.entryTimestamp || new Date(),
        entryWalletCount: data.entryWalletCount || walletIds.length || 1,
        entryMarketCapUsd: data.entryMarketCapUsd ?? undefined,
        entryLiquidityUsd: data.entryLiquidityUsd ?? undefined,
        positionSizeUsd: data.positionSizeUsd ?? undefined,
        // Initialize price tracking with entry values
        currentPriceUsd: entryPrice,
        highestPriceUsd: entryPrice,
        lowestPriceUsd: entryPrice,
        // Initialize PnL at 0
        unrealizedPnlPercent: 0,
        unrealizedPnlUsd: 0,
        drawdownFromPeak: 0,
        // Wallet tracking
        walletIds,
        activeWalletCount: walletIds.length,
        exitedWalletCount: 0,
        // Exit strategy
        suggestedStopLoss: data.suggestedStopLoss ?? undefined,
        suggestedTakeProfit: data.suggestedTakeProfit ?? undefined,
        trailingStopPercent: data.trailingStopPercent ?? 20, // Default 20% trailing
        status: 'open',
      },
    });

    return this.mapToRecord(result);
  }

  async findById(id: string): Promise<VirtualPositionRecord | null> {
    const result = await prisma.virtualPosition.findUnique({
      where: { id },
    });
    return result ? this.mapToRecord(result) : null;
  }

  async findBySignalId(signalId: string): Promise<VirtualPositionRecord | null> {
    const result = await prisma.virtualPosition.findFirst({
      where: { signalId },
    });
    return result ? this.mapToRecord(result) : null;
  }

  async findByTokenId(tokenId: string, status?: string): Promise<VirtualPositionRecord[]> {
    const where: any = { tokenId };
    if (status) where.status = status;

    const results = await prisma.virtualPosition.findMany({
      where,
      orderBy: { entryTimestamp: 'desc' },
    });

    return results.map(this.mapToRecord);
  }

  async findOpen(options?: {
    tokenId?: string;
    status?: 'open' | 'closed' | 'partial_exit' | 'stopped';
    limit?: number;
    orderBy?: 'entryTimestamp' | 'unrealizedPnlPercent' | 'drawdownFromPeak';
    orderDirection?: 'asc' | 'desc';
  }): Promise<VirtualPositionRecord[]> {
    const where: any = {};

    // Default to 'open' if no status provided
    if (options?.status) {
      where.status = options.status;
    } else {
      where.status = 'open';
    }

    if (options?.tokenId) {
      where.tokenId = options.tokenId;
    }

    const orderBy = options?.orderBy || 'entryTimestamp';
    const orderDirection = options?.orderDirection || 'desc';

    const results = await prisma.virtualPosition.findMany({
      where,
      orderBy: { [orderBy]: orderDirection },
      ...(options?.limit && { take: options.limit }),
    });

    return results.map(this.mapToRecord);
  }

  async findAll(options?: {
    status?: 'open' | 'partial_exit' | 'closed' | 'stopped';
    tokenId?: string;
    limit?: number;
    offset?: number;
  }): Promise<VirtualPositionRecord[]> {
    const where: any = {};

    if (options?.status) {
      where.status = options.status;
    }

    if (options?.tokenId) {
      where.tokenId = options.tokenId;
    }

    const results = await prisma.virtualPosition.findMany({
      where,
      orderBy: { entryTimestamp: 'desc' },
      ...(options?.limit && { take: options.limit }),
      ...(options?.offset && { skip: options.offset }),
    });

    return results.map(this.mapToRecord);
  }

  async updatePriceAndPnl(
    id: string,
    currentPriceUsd: number,
    now: Date = new Date()
  ): Promise<VirtualPositionRecord | null> {
    const existing = await prisma.virtualPosition.findUnique({
      where: { id },
    });

    if (!existing) return null;

    const entryPrice = Number(existing.entryPriceUsd);
    const positionSize = Number(existing.positionSizeUsd) || 0;

    const unrealizedPnlPercent = ((currentPriceUsd - entryPrice) / entryPrice) * 100;
    const unrealizedPnlUsd = positionSize * (unrealizedPnlPercent / 100);

    // Update high/low tracking
    const highestPrice = Math.max(Number(existing.highestPriceUsd) || entryPrice, currentPriceUsd);
    const lowestPrice = Math.min(Number(existing.lowestPriceUsd) || entryPrice, currentPriceUsd);

    // Calculate drawdown from peak
    const drawdownFromPeak = highestPrice > 0 ? ((highestPrice - currentPriceUsd) / highestPrice) * 100 : 0;

    // Update trailing stop price if needed (only ratchet up)
    const trailingPercent = Number(existing.trailingStopPercent) || 20;
    const newTrailingStopPrice = currentPriceUsd * (1 - trailingPercent / 100);
    const trailingStopPrice = Math.max(
      Number(existing.trailingStopPrice) || 0,
      newTrailingStopPrice
    );

    const result = await prisma.virtualPosition.update({
      where: { id },
      data: {
        currentPriceUsd,
        lastPriceUpdate: now,
        unrealizedPnlPercent,
        unrealizedPnlUsd,
        highestPriceUsd: highestPrice,
        lowestPriceUsd: lowestPrice,
        drawdownFromPeak,
        trailingStopPrice,
        updatedAt: now,
      },
    });

    return this.mapToRecord(result);
  }

  async updateAiDecision(
    id: string,
    aiDecision: string,
    aiConfidence: number,
    aiReasoning: string
  ): Promise<VirtualPositionRecord | null> {
    const result = await prisma.virtualPosition.update({
      where: { id },
      data: {
        lastAiDecision: aiDecision,
        lastAiConfidence: aiConfidence,
        lastAiReasoning: aiReasoning,
        lastAiEvaluation: new Date(),
        updatedAt: new Date(),
      },
    });

    return this.mapToRecord(result);
  }

  async updateWalletCounts(
    id: string,
    activeWalletCount: number,
    exitedWalletCount: number
  ): Promise<VirtualPositionRecord | null> {
    const result = await prisma.virtualPosition.update({
      where: { id },
      data: {
        activeWalletCount,
        exitedWalletCount,
        updatedAt: new Date(),
      },
    });

    return this.mapToRecord(result);
  }

  async recordNotificationSent(id: string): Promise<VirtualPositionRecord | null> {
    const result = await prisma.virtualPosition.update({
      where: { id },
      data: {
        lastNotificationSent: new Date(),
        notificationCount: { increment: 1 },
        updatedAt: new Date(),
      },
    });

    return this.mapToRecord(result);
  }

  async setTrailingStop(
    id: string,
    trailingStopPercent: number
  ): Promise<VirtualPositionRecord | null> {
    const existing = await prisma.virtualPosition.findUnique({
      where: { id },
    });

    if (!existing) return null;

    const currentPrice = Number(existing.currentPriceUsd) || Number(existing.entryPriceUsd);
    const trailingStopPrice = currentPrice * (1 - trailingStopPercent / 100);

    const result = await prisma.virtualPosition.update({
      where: { id },
      data: {
        trailingStopPercent,
        trailingStopPrice,
        updatedAt: new Date(),
      },
    });

    return this.mapToRecord(result);
  }

  async close(
    id: string,
    exitReason: string,
    exitPriceUsd: number,
    exitTimestamp: Date = new Date()
  ): Promise<VirtualPositionRecord | null> {
    const existing = await prisma.virtualPosition.findUnique({
      where: { id },
    });

    if (!existing) return null;

    const entryPrice = Number(existing.entryPriceUsd);
    const positionSize = Number(existing.positionSizeUsd) || 0;

    const realizedPnlPercent = ((exitPriceUsd - entryPrice) / entryPrice) * 100;
    const realizedPnlUsd = positionSize * (realizedPnlPercent / 100);

    const result = await prisma.virtualPosition.update({
      where: { id },
      data: {
        status: 'closed',
        exitReason,
        exitPriceUsd,
        exitTimestamp,
        currentPriceUsd: exitPriceUsd,
        realizedPnlPercent,
        realizedPnlUsd,
        updatedAt: exitTimestamp,
      },
    });

    return this.mapToRecord(result);
  }

  async markPartialExit(id: string): Promise<VirtualPositionRecord | null> {
    const result = await prisma.virtualPosition.update({
      where: { id },
      data: {
        status: 'partial_exit',
        updatedAt: new Date(),
      },
    });

    return this.mapToRecord(result);
  }

  async getStats(): Promise<{
    totalOpen: number;
    totalClosed: number;
    avgOpenPnlPercent: number;
    avgClosedPnlPercent: number;
    winRate: number;
  }> {
    const openPositions = await prisma.virtualPosition.findMany({
      where: { status: 'open' },
    });

    const closedPositions = await prisma.virtualPosition.findMany({
      where: { status: 'closed' },
    });

    const avgOpenPnl = openPositions.length > 0
      ? openPositions.reduce((sum, p) => sum + (Number(p.unrealizedPnlPercent) || 0), 0) / openPositions.length
      : 0;

    const avgClosedPnl = closedPositions.length > 0
      ? closedPositions.reduce((sum, p) => sum + (Number(p.realizedPnlPercent) || 0), 0) / closedPositions.length
      : 0;

    const winCount = closedPositions.filter(p => Number(p.realizedPnlPercent) > 0).length;
    const winRate = closedPositions.length > 0 ? (winCount / closedPositions.length) * 100 : 0;

    return {
      totalOpen: openPositions.length,
      totalClosed: closedPositions.length,
      avgOpenPnlPercent: avgOpenPnl,
      avgClosedPnlPercent: avgClosedPnl,
      winRate,
    };
  }

  private mapToRecord(result: any): VirtualPositionRecord {
    return {
      id: result.id,
      tokenId: result.tokenId,
      signalId: result.signalId ?? null,
      consensusSignalId: result.consensusSignalId ?? null,
      entryPriceUsd: Number(result.entryPriceUsd),
      entryTimestamp: result.entryTimestamp,
      entryWalletCount: result.entryWalletCount,
      entryMarketCapUsd: result.entryMarketCapUsd ? Number(result.entryMarketCapUsd) : null,
      entryLiquidityUsd: result.entryLiquidityUsd ? Number(result.entryLiquidityUsd) : null,
      positionSizeUsd: result.positionSizeUsd ? Number(result.positionSizeUsd) : null,
      currentPriceUsd: result.currentPriceUsd ? Number(result.currentPriceUsd) : null,
      lastPriceUpdate: result.lastPriceUpdate ?? null,
      unrealizedPnlPercent: result.unrealizedPnlPercent ? Number(result.unrealizedPnlPercent) : null,
      unrealizedPnlUsd: result.unrealizedPnlUsd ? Number(result.unrealizedPnlUsd) : null,
      highestPriceUsd: result.highestPriceUsd ? Number(result.highestPriceUsd) : null,
      lowestPriceUsd: result.lowestPriceUsd ? Number(result.lowestPriceUsd) : null,
      drawdownFromPeak: result.drawdownFromPeak ? Number(result.drawdownFromPeak) : null,
      walletIds: result.walletIds || [],
      activeWalletCount: result.activeWalletCount,
      exitedWalletCount: result.exitedWalletCount,
      suggestedStopLoss: result.suggestedStopLoss ? Number(result.suggestedStopLoss) : null,
      suggestedTakeProfit: result.suggestedTakeProfit ? Number(result.suggestedTakeProfit) : null,
      trailingStopPercent: result.trailingStopPercent ? Number(result.trailingStopPercent) : null,
      trailingStopPrice: result.trailingStopPrice ? Number(result.trailingStopPrice) : null,
      lastAiDecision: result.lastAiDecision ?? null,
      lastAiConfidence: result.lastAiConfidence ?? null,
      lastAiReasoning: result.lastAiReasoning ?? null,
      lastAiEvaluation: result.lastAiEvaluation ?? null,
      status: result.status as 'open' | 'partial_exit' | 'closed' | 'stopped',
      exitReason: result.exitReason ?? null,
      exitPriceUsd: result.exitPriceUsd ? Number(result.exitPriceUsd) : null,
      exitTimestamp: result.exitTimestamp ?? null,
      realizedPnlPercent: result.realizedPnlPercent ? Number(result.realizedPnlPercent) : null,
      realizedPnlUsd: result.realizedPnlUsd ? Number(result.realizedPnlUsd) : null,
      lastNotificationSent: result.lastNotificationSent ?? null,
      notificationCount: result.notificationCount,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
  }
}
