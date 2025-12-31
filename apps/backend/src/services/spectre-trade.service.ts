/**
 * SPECTRE Trade Service
 *
 * Handles saving trades from SPECTRE bot and providing statistics
 */

import { prisma } from '../lib/prisma.js';

export interface SpectreTradeInput {
  signalType: string;
  signalStrength: string;
  tokenMint: string;
  tokenSymbol: string;
  side: string;
  amountSol: number;
  amountTokens?: number;
  pricePerToken?: number;
  txSignature?: string;
  marketCapUsd?: number;
  liquidityUsd?: number;
  entryPriceUsd?: number;
  stopLossPercent?: number;
  takeProfitPercent?: number;
  slippageBps?: number;
  jitoTipLamports?: number;
  success: boolean;
  error?: string;
  latencyMs?: number;
  signalToTradeMs?: number;
  attemptNumber?: number;
  priceAtSignal?: number;
  priceAtTrade?: number;
  priceChangePercent?: number;
  positionId?: string;
  exitReason?: string;
  realizedPnlSol?: number;
  realizedPnlPercent?: number;
  realizedPnlUsd?: number;
  triggerWallets?: Array<{ address: string; label: string | null; score: number | null }>;
  signalTimestamp?: string;
}

export class SpectreTradeService {
  /**
   * Save a trade from SPECTRE bot
   */
  async saveTrade(input: SpectreTradeInput) {
    try {
      // Calculate signal-to-trade latency if we have signal timestamp
      let signalToTradeMs: number | undefined;
      if (input.signalTimestamp) {
        const signalTime = new Date(input.signalTimestamp).getTime();
        const now = Date.now();
        signalToTradeMs = now - signalTime;
      }

      const trade = await prisma.spectreTrade.create({
        data: {
          signalType: input.signalType,
          signalStrength: input.signalStrength,
          tokenMint: input.tokenMint,
          tokenSymbol: input.tokenSymbol,
          side: input.side,
          amountSol: input.amountSol,
          amountTokens: input.amountTokens,
          pricePerToken: input.pricePerToken,
          txSignature: input.txSignature,
          marketCapUsd: input.marketCapUsd,
          liquidityUsd: input.liquidityUsd,
          entryPriceUsd: input.entryPriceUsd,
          stopLossPercent: input.stopLossPercent,
          takeProfitPercent: input.takeProfitPercent,
          slippageBps: input.slippageBps,
          jitoTipLamports: input.jitoTipLamports,
          success: input.success,
          error: input.error,
          latencyMs: input.latencyMs,
          signalToTradeMs: signalToTradeMs,
          attemptNumber: input.attemptNumber ?? 1,
          priceAtSignal: input.priceAtSignal,
          priceAtTrade: input.priceAtTrade,
          priceChangePercent: input.priceChangePercent,
          positionId: input.positionId,
          exitReason: input.exitReason,
          realizedPnlSol: input.realizedPnlSol,
          realizedPnlPercent: input.realizedPnlPercent,
          realizedPnlUsd: input.realizedPnlUsd,
          triggerWallets: input.triggerWallets,
          signalTimestamp: input.signalTimestamp ? new Date(input.signalTimestamp) : undefined,
        },
      });

      console.log(`👻 [SpectreTrade] Saved trade: ${trade.id} - ${input.side.toUpperCase()} ${input.tokenSymbol} (${input.success ? '✅' : '❌'})`);
      return trade;
    } catch (error: any) {
      // Handle duplicate txSignature
      if (error.code === 'P2002') {
        console.warn(`⚠️  [SpectreTrade] Duplicate trade: ${input.txSignature}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Get all trades with optional filters
   */
  async getTrades(options: {
    signalType?: string;
    side?: string;
    success?: boolean;
    limit?: number;
    offset?: number;
  } = {}) {
    const { signalType, side, success, limit = 100, offset = 0 } = options;

    const where: any = {};
    if (signalType) where.signalType = signalType;
    if (side) where.side = side;
    if (success !== undefined) where.success = success;

    const trades = await prisma.spectreTrade.findMany({
      where,
      orderBy: { executedAt: 'desc' },
      take: limit,
      skip: offset,
    });

    return trades;
  }

  /**
   * Get trading statistics
   */
  async getStats() {
    const allTrades = await prisma.spectreTrade.findMany({
      select: {
        signalType: true,
        side: true,
        success: true,
        amountSol: true,
        realizedPnlSol: true,
        realizedPnlPercent: true,
        latencyMs: true,
        signalToTradeMs: true,
        attemptNumber: true,
        priceChangePercent: true,
        executedAt: true,
      },
    });

    const buyTrades = allTrades.filter(t => t.side === 'buy');
    const sellTrades = allTrades.filter(t => t.side === 'sell');
    const successfulBuys = buyTrades.filter(t => t.success);
    const failedBuys = buyTrades.filter(t => !t.success);

    // Calculate PnL from closed positions
    const closedPositions = sellTrades.filter(t => t.realizedPnlSol !== null);
    const totalPnlSol = closedPositions.reduce((sum, t) => sum + Number(t.realizedPnlSol || 0), 0);
    const wins = closedPositions.filter(t => Number(t.realizedPnlSol || 0) > 0);
    const losses = closedPositions.filter(t => Number(t.realizedPnlSol || 0) < 0);

    // Calculate average latency (execution time)
    const latencies = successfulBuys.filter(t => t.latencyMs).map(t => t.latencyMs!);
    const avgLatencyMs = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

    // Calculate signal-to-trade latency
    const signalToTradeLatencies = successfulBuys.filter(t => t.signalToTradeMs).map(t => t.signalToTradeMs!);
    const avgSignalToTradeMs = signalToTradeLatencies.length > 0
      ? signalToTradeLatencies.reduce((a, b) => a + b, 0) / signalToTradeLatencies.length
      : 0;
    const minSignalToTradeMs = signalToTradeLatencies.length > 0 ? Math.min(...signalToTradeLatencies) : 0;
    const maxSignalToTradeMs = signalToTradeLatencies.length > 0 ? Math.max(...signalToTradeLatencies) : 0;

    // Retry statistics
    const retries = buyTrades.filter(t => (t.attemptNumber || 1) > 1);
    const retriesSuccessful = retries.filter(t => t.success);
    const avgPriceChange = buyTrades.filter(t => t.priceChangePercent != null)
      .map(t => t.priceChangePercent!);

    // Group by signal type
    const ninjaStats = {
      buys: buyTrades.filter(t => t.signalType === 'ninja').length,
      successRate: buyTrades.filter(t => t.signalType === 'ninja' && t.success).length /
                   Math.max(1, buyTrades.filter(t => t.signalType === 'ninja').length) * 100,
    };

    const consensusStats = {
      buys: buyTrades.filter(t => t.signalType === 'consensus').length,
      successRate: buyTrades.filter(t => t.signalType === 'consensus' && t.success).length /
                   Math.max(1, buyTrades.filter(t => t.signalType === 'consensus').length) * 100,
    };

    // Total SOL invested
    const totalInvested = successfulBuys.reduce((sum, t) => sum + Number(t.amountSol || 0), 0);

    return {
      totalTrades: allTrades.length,
      buyTrades: buyTrades.length,
      sellTrades: sellTrades.length,
      successfulBuys: successfulBuys.length,
      failedBuys: failedBuys.length,
      buySuccessRate: buyTrades.length > 0 ? (successfulBuys.length / buyTrades.length * 100).toFixed(1) : 0,
      closedPositions: closedPositions.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closedPositions.length > 0 ? (wins.length / closedPositions.length * 100).toFixed(1) : 0,
      totalPnlSol: totalPnlSol.toFixed(4),
      totalInvestedSol: totalInvested.toFixed(4),
      roi: totalInvested > 0 ? ((totalPnlSol / totalInvested) * 100).toFixed(2) : 0,
      avgLatencyMs: avgLatencyMs.toFixed(0),
      // Signal to trade latency stats
      signalToTrade: {
        avgMs: avgSignalToTradeMs.toFixed(0),
        minMs: minSignalToTradeMs,
        maxMs: maxSignalToTradeMs,
        count: signalToTradeLatencies.length,
      },
      // Retry stats
      retryStats: {
        totalRetries: retries.length,
        retriesSuccessful: retriesSuccessful.length,
        avgPriceChangePercent: avgPriceChange.length > 0
          ? (avgPriceChange.reduce((a, b) => a + b, 0) / avgPriceChange.length).toFixed(2)
          : 0,
      },
      ninjaStats,
      consensusStats,
      lastTradeAt: allTrades.length > 0 ? allTrades[0].executedAt : null,
    };
  }

  /**
   * Get recent trades for display
   */
  async getRecentTrades(limit = 20) {
    return prisma.spectreTrade.findMany({
      orderBy: { executedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        signalType: true,
        tokenSymbol: true,
        tokenMint: true,
        side: true,
        amountSol: true,
        success: true,
        latencyMs: true,
        txSignature: true,
        marketCapUsd: true,
        realizedPnlPercent: true,
        error: true,
        executedAt: true,
      },
    });
  }
}

export const spectreTradeService = new SpectreTradeService();
