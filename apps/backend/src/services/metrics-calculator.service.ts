import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';

interface Position {
  tokenId: string;
  buyAmount: number;
  buyPrice: number;
  buyTimestamp: Date;
  sellAmount?: number;
  sellPrice?: number;
  sellTimestamp?: Date;
}

export class MetricsCalculatorService {
  constructor(
    private smartWalletRepo: SmartWalletRepository,
    private tradeRepo: TradeRepository,
    private metricsHistoryRepo: MetricsHistoryRepository
  ) {}

  /**
   * Calculate all metrics for a wallet and update the database
   */
  async calculateMetricsForWallet(walletId: string) {
    const trades = await this.tradeRepo.findAllForMetrics(walletId);

    if (trades.length === 0) {
      // No trades, reset metrics
      await this.smartWalletRepo.update(walletId, {
        score: 0,
        totalTrades: 0,
        winRate: 0,
        avgRr: 0,
        avgPnlPercent: 0,
        pnlTotalBase: 0,
        avgHoldingTimeMin: 0,
        maxDrawdownPercent: 0,
        recentPnl30dPercent: 0,
      });
      return;
    }

    // Build positions from trades (pair buy/sell)
    const positions = this.buildPositions(trades);

    // Calculate metrics
    const totalTrades = positions.length;
    const winRate = this.calculateWinRate(positions);
    const avgRr = this.calculateAvgRiskReward(positions);
    const avgPnlPercent = this.calculateAvgPnlPercent(positions);
    const pnlTotalBase = this.calculateTotalPnl(positions);
    const avgHoldingTimeMin = this.calculateAvgHoldingTime(positions);
    const maxDrawdownPercent = this.calculateMaxDrawdown(positions);
    const recentPnl30dPercent = this.calculateRecentPnl30d(positions);

    // Calculate score (simple formula: can be improved later)
    const score = this.calculateScore({
      totalTrades,
      winRate,
      avgPnlPercent,
      recentPnl30dPercent,
      avgRr,
    });

    // Update wallet metrics
    await this.smartWalletRepo.update(walletId, {
      score,
      totalTrades,
      winRate,
      avgRr,
      avgPnlPercent,
      pnlTotalBase,
      avgHoldingTimeMin,
      maxDrawdownPercent,
      recentPnl30dPercent,
    });

    // Save to history
    await this.metricsHistoryRepo.create({
      walletId,
      timestamp: new Date(),
      score,
      totalTrades,
      winRate,
      avgRr,
      avgPnlPercent,
      pnlTotalBase,
      avgHoldingTimeMin,
      maxDrawdownPercent,
      recentPnl30dPercent,
    });

    return {
      score,
      totalTrades,
      winRate,
      avgRr,
      avgPnlPercent,
      pnlTotalBase,
      avgHoldingTimeMin,
      maxDrawdownPercent,
      recentPnl30dPercent,
    };
  }

  private buildPositions(trades: any[]): Position[] {
    const positions: Position[] = [];
    const openPositions = new Map<string, Position>();

    for (const trade of trades) {
      const tokenId = trade.tokenId;
      const side = trade.side;
      const amount = Number(trade.amountToken);
      const price = Number(trade.priceBasePerToken);
      const timestamp = trade.timestamp;

      if (side === 'buy') {
        // Check if there's an open position
        const existing = openPositions.get(tokenId);
        if (existing) {
          // Average the buy price
          const totalAmount = existing.buyAmount + amount;
          const totalValue = existing.buyAmount * existing.buyPrice + amount * price;
          existing.buyAmount = totalAmount;
          existing.buyPrice = totalValue / totalAmount;
        } else {
          openPositions.set(tokenId, {
            tokenId,
            buyAmount: amount,
            buyPrice: price,
            buyTimestamp: timestamp,
          });
        }
      } else if (side === 'sell') {
        const position = openPositions.get(tokenId);
        if (position) {
          // Close position (or partial)
          if (amount >= position.buyAmount) {
            // Full close
            position.sellAmount = position.buyAmount;
            position.sellPrice = price;
            position.sellTimestamp = timestamp;
            positions.push(position);
            openPositions.delete(tokenId);
          } else {
            // Partial close - create closed position and reduce open
            const closedPosition: Position = {
              tokenId,
              buyAmount: amount,
              buyPrice: position.buyPrice,
              buyTimestamp: position.buyTimestamp,
              sellAmount: amount,
              sellPrice: price,
              sellTimestamp: timestamp,
            };
            positions.push(closedPosition);
            position.buyAmount -= amount;
          }
        }
      }
    }

    // Add remaining open positions (not closed yet)
    // These won't count towards win rate but will affect other metrics

    return positions;
  }

  private calculateWinRate(positions: Position[]): number {
    const closedPositions = positions.filter(p => p.sellAmount && p.sellPrice);
    if (closedPositions.length === 0) return 0;

    const wins = closedPositions.filter(p => {
      const pnl = (p.sellPrice! - p.buyPrice) / p.buyPrice;
      return pnl > 0;
    }).length;

    return wins / closedPositions.length;
  }

  private calculateAvgRiskReward(positions: Position[]): number {
    const closedPositions = positions.filter(p => p.sellAmount && p.sellPrice);
    if (closedPositions.length === 0) return 0;

    const rrs = closedPositions.map(p => {
      const pnl = (p.sellPrice! - p.buyPrice) / p.buyPrice;
      // Simple RR: profit / loss (if loss, negative)
      return pnl > 0 ? pnl : pnl;
    });

    return rrs.reduce((sum, rr) => sum + rr, 0) / rrs.length;
  }

  private calculateAvgPnlPercent(positions: Position[]): number {
    const closedPositions = positions.filter(p => p.sellAmount && p.sellPrice);
    if (closedPositions.length === 0) return 0;

    const pnls = closedPositions.map(p => {
      return ((p.sellPrice! - p.buyPrice) / p.buyPrice) * 100;
    });

    return pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length;
  }

  private calculateTotalPnl(positions: Position[]): number {
    const closedPositions = positions.filter(p => p.sellAmount && p.sellPrice);
    
    return closedPositions.reduce((sum, p) => {
      const buyValue = p.buyAmount * p.buyPrice;
      const sellValue = p.sellAmount! * p.sellPrice!;
      return sum + (sellValue - buyValue);
    }, 0);
  }

  private calculateAvgHoldingTime(positions: Position[]): number {
    const closedPositions = positions.filter(p => p.sellTimestamp);
    if (closedPositions.length === 0) return 0;

    const holdingTimes = closedPositions.map(p => {
      const diff = p.sellTimestamp!.getTime() - p.buyTimestamp.getTime();
      return diff / (1000 * 60); // Convert to minutes
    });

    return holdingTimes.reduce((sum, time) => sum + time, 0) / holdingTimes.length;
  }

  private calculateMaxDrawdown(positions: Position[]): number {
    const closedPositions = positions.filter(p => p.sellAmount && p.sellPrice);
    if (closedPositions.length === 0) return 0;

    let peak = 0;
    let maxDrawdown = 0;
    let cumulativePnl = 0;

    for (const p of closedPositions) {
      const pnl = (p.sellPrice! - p.buyPrice) / p.buyPrice;
      cumulativePnl += pnl;
      
      if (cumulativePnl > peak) {
        peak = cumulativePnl;
      }
      
      const drawdown = peak - cumulativePnl;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown * 100; // Convert to percentage
  }

  private calculateRecentPnl30d(positions: Position[]): number {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentPositions = positions.filter(
      p => p.sellTimestamp && p.sellTimestamp >= thirtyDaysAgo
    );

    if (recentPositions.length === 0) return 0;

    const totalPnl = recentPositions.reduce((sum, p) => {
      const pnl = ((p.sellPrice! - p.buyPrice) / p.buyPrice) * 100;
      return sum + pnl;
    }, 0);

    return totalPnl;
  }

  private calculateScore(params: {
    totalTrades: number;
    winRate: number;
    avgPnlPercent: number;
    recentPnl30dPercent: number;
    avgRr: number;
  }): number {
    // Simple scoring formula (0-100)
    // Can be improved with more sophisticated logic
    
    const { totalTrades, winRate, avgPnlPercent, recentPnl30dPercent, avgRr } = params;

    // Normalize values
    const winRateScore = winRate * 30; // Max 30 points
    const avgPnlScore = Math.min(Math.max(avgPnlPercent / 2, 0), 30); // Max 30 points (2% avg = 30 points)
    const recentPnlScore = Math.min(Math.max(recentPnl30dPercent / 2, 0), 30); // Max 30 points
    const volumeScore = Math.min(totalTrades / 10, 10); // Max 10 points (100 trades = 10 points)

    const score = winRateScore + avgPnlScore + recentPnlScore + volumeScore;
    return Math.min(Math.max(score, 0), 100); // Clamp to 0-100
  }

  /**
   * Calculate advanced statistics for a wallet
   */
  async calculateAdvancedStats(walletId: string) {
    const trades = await this.tradeRepo.findAllForMetrics(walletId);
    if (trades.length === 0) {
      return null;
    }

    const positions = this.buildPositions(trades);
    const closedPositions = positions.filter(p => p.sellAmount && p.sellPrice);

    if (closedPositions.length === 0) {
      return null;
    }

    // Calculate PnL for each position
    const pnls = closedPositions.map(p => {
      const pnlPercent = ((p.sellPrice! - p.buyPrice) / p.buyPrice) * 100;
      const pnlBase = (p.sellPrice! - p.buyPrice) * p.buyAmount;
      return { pnlPercent, pnlBase, position: p };
    });

    // Profit Factor = Total Profit / Total Loss
    const totalProfit = pnls.filter(p => p.pnlBase > 0).reduce((sum, p) => sum + p.pnlBase, 0);
    const totalLoss = Math.abs(pnls.filter(p => p.pnlBase < 0).reduce((sum, p) => sum + p.pnlBase, 0));
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    // Best and worst trades
    const bestTrade = pnls.reduce((best, current) => 
      current.pnlPercent > best.pnlPercent ? current : best
    );
    const worstTrade = pnls.reduce((worst, current) => 
      current.pnlPercent < worst.pnlPercent ? current : worst
    );

    // Largest win/loss
    const largestWin = pnls.filter(p => p.pnlBase > 0).reduce((max, p) => 
      p.pnlBase > max.pnlBase ? p : max, { pnlBase: 0, pnlPercent: 0, position: null as any }
    );
    const largestLoss = pnls.filter(p => p.pnlBase < 0).reduce((min, p) => 
      p.pnlBase < min.pnlBase ? p : min, { pnlBase: 0, pnlPercent: 0, position: null as any }
    );

    // Average win/loss
    const wins = pnls.filter(p => p.pnlBase > 0);
    const losses = pnls.filter(p => p.pnlBase < 0);
    const avgWin = wins.length > 0 
      ? wins.reduce((sum, p) => sum + p.pnlPercent, 0) / wins.length 
      : 0;
    const avgLoss = losses.length > 0 
      ? losses.reduce((sum, p) => sum + p.pnlPercent, 0) / losses.length 
      : 0;

    // Win streak / Loss streak
    let currentWinStreak = 0;
    let maxWinStreak = 0;
    let currentLossStreak = 0;
    let maxLossStreak = 0;

    for (const pnl of pnls) {
      if (pnl.pnlBase > 0) {
        currentWinStreak++;
        currentLossStreak = 0;
        maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
      } else {
        currentLossStreak++;
        currentWinStreak = 0;
        maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
      }
    }

    // Token analysis
    const tokenStats = new Map<string, { count: number; totalPnl: number; wins: number; losses: number }>();
    for (const pnl of pnls) {
      const tokenId = pnl.position.tokenId;
      if (!tokenStats.has(tokenId)) {
        tokenStats.set(tokenId, { count: 0, totalPnl: 0, wins: 0, losses: 0 });
      }
      const stats = tokenStats.get(tokenId)!;
      stats.count++;
      stats.totalPnl += pnl.pnlBase;
      if (pnl.pnlBase > 0) stats.wins++;
      else stats.losses++;
    }

    // DEX analysis
    const dexStats = new Map<string, { count: number; totalPnl: number }>();
    for (const trade of trades) {
      if (trade.side === 'sell') {
        const dex = trade.dex;
        if (!dexStats.has(dex)) {
          dexStats.set(dex, { count: 0, totalPnl: 0 });
        }
        dexStats.get(dex)!.count++;
        // Find corresponding position PnL
        const position = closedPositions.find(p => p.tokenId === trade.tokenId);
        if (position && position.sellPrice) {
          const pnl = (position.sellPrice - position.buyPrice) * position.buyAmount;
          dexStats.get(dex)!.totalPnl += pnl;
        }
      }
    }

    return {
      profitFactor,
      bestTrade: {
        pnlPercent: bestTrade.pnlPercent,
        pnlBase: bestTrade.pnlBase,
        tokenId: bestTrade.position.tokenId,
      },
      worstTrade: {
        pnlPercent: worstTrade.pnlPercent,
        pnlBase: worstTrade.pnlBase,
        tokenId: worstTrade.position.tokenId,
      },
      largestWin: largestWin.position ? {
        pnlPercent: largestWin.pnlPercent,
        pnlBase: largestWin.pnlBase,
        tokenId: largestWin.position.tokenId,
      } : null,
      largestLoss: largestLoss.position ? {
        pnlPercent: largestLoss.pnlPercent,
        pnlBase: largestLoss.pnlBase,
        tokenId: largestLoss.position.tokenId,
      } : null,
      avgWin,
      avgLoss,
      maxWinStreak,
      maxLossStreak,
      tokenStats: Array.from(tokenStats.entries()).map(([tokenId, stats]) => ({
        tokenId,
        ...stats,
        winRate: stats.count > 0 ? stats.wins / stats.count : 0,
      })),
      dexStats: Array.from(dexStats.entries()).map(([dex, stats]) => ({
        dex,
        ...stats,
      })),
    };
  }
}

