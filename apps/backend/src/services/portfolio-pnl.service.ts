/**
 * Shared service for calculating PnL from closed positions
 * Used by both portfolio endpoint and metrics calculator
 * Ensures consistency between homepage/stats and detail page
 */

import { ClosedLotRepository, ClosedLotRecord } from '../repositories/closed-lot.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

export interface ClosedPositionPnL {
  realizedPnlUsd: number;
  realizedPnlPercent: number;
  numClosedPositions: number;
}

export class PortfolioPnlService {
  constructor(private closedLotRepo: ClosedLotRepository = new ClosedLotRepository()) {}

  /**
   * Calculate 30d PnL from closed positions using the EXACT SAME logic as portfolio endpoint
   * This ensures homepage/stats show the same PnL as detail page
   */
  async calculate30dPnlFromClosedPositions(walletId: string): Promise<ClosedPositionPnL> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Get all trades for this wallet
    const { data: trades } = await supabase
      .from(TABLES.TRADE)
      .select('*')
      .eq('walletId', walletId)
      .order('timestamp', { ascending: true });

    if (!trades || trades.length === 0) {
      return { realizedPnlUsd: 0, realizedPnlPercent: 0, numClosedPositions: 0 };
    }

    // Build positions from trades (SAME LOGIC AS PORTFOLIO ENDPOINT)
    const positionMap = new Map<string, {
      tokenId: string;
      totalBought: number;
      totalSold: number;
      balance: number;
      totalCostBase: number;
      totalProceedsBase: number;
      buyCount: number;
      sellCount: number;
      removeCount: number;
      firstBuyTimestamp: Date | null;
      lastSellTimestamp: Date | null;
      baseToken: string;
    }>();

    for (const trade of trades) {
      const tokenId = trade.tokenId;
      const amount = Math.abs(Number(trade.amountToken || 0));
      const amountBase = Math.abs(Number(trade.amountBase || 0));
      const baseToken = (trade.meta as any)?.baseToken || 'SOL';
      const tradeTimestamp = new Date(trade.timestamp);

      if (!positionMap.has(tokenId)) {
        positionMap.set(tokenId, {
          tokenId,
          totalBought: 0,
          totalSold: 0,
          balance: 0,
          totalCostBase: 0,
          totalProceedsBase: 0,
          buyCount: 0,
          sellCount: 0,
          removeCount: 0,
          firstBuyTimestamp: null,
          lastSellTimestamp: null,
          baseToken,
        });
      }

      const position = positionMap.get(tokenId)!;

      if (trade.side === 'buy' || trade.side === 'add') {
        position.totalBought += amount;
        position.balance += amount;
        position.totalCostBase += amountBase;
        position.buyCount++;
        if (!position.firstBuyTimestamp || tradeTimestamp < position.firstBuyTimestamp) {
          position.firstBuyTimestamp = tradeTimestamp;
        }
      } else if (trade.side === 'sell' || trade.side === 'remove') {
        position.totalSold += amount;
        position.balance -= amount;
        position.totalProceedsBase += amountBase;
        if (trade.side === 'sell') {
          position.sellCount++;
          if (!position.lastSellTimestamp || tradeTimestamp > position.lastSellTimestamp) {
            position.lastSellTimestamp = tradeTimestamp;
          }
        } else {
          position.removeCount++;
        }
      }
    }

    // Get all closed lots for this wallet
    const closedLots = await this.closedLotRepo.findByWallet(walletId, { fromDate: thirtyDaysAgo });

    // Group closed lots by tokenId
    const closedLotsByToken = new Map<string, ClosedLotRecord[]>();
    for (const lot of closedLots) {
      if (!closedLotsByToken.has(lot.tokenId)) {
        closedLotsByToken.set(lot.tokenId, []);
      }
      closedLotsByToken.get(lot.tokenId)!.push(lot);
    }

    // Filter closed positions (SAME LOGIC AS PORTFOLIO ENDPOINT)
    const closedPositions = Array.from(positionMap.values())
      .filter(p => {
        const normalizedBalance = p.balance < 0 && Math.abs(p.balance) < 0.0001 ? 0 : p.balance;
        return normalizedBalance <= 0 && p.buyCount > 0 && p.sellCount > 0 &&
               p.firstBuyTimestamp && p.lastSellTimestamp;
      });

    // Filter by lastSellTimestamp (SAME LOGIC AS PORTFOLIO ENDPOINT)
    const recentClosedPositions30d = closedPositions.filter(p => {
      if (!p.lastSellTimestamp) return false;
      const sellDate = new Date(p.lastSellTimestamp);
      return sellDate >= thirtyDaysAgo && sellDate <= new Date();
    });

    // Calculate PnL from ClosedLot (SAME LOGIC AS PORTFOLIO ENDPOINT)
    let totalRealizedPnlUsd = 0;
    let totalCostUsd = 0;

    for (const position of recentClosedPositions30d) {
      // Get all ClosedLot for this token
      const closedLotsForToken = (closedLotsByToken.get(position.tokenId) || []).filter((lot: any) =>
        lot.exitTime &&
        new Date(lot.exitTime) <= new Date()
      );

      // Sum realizedPnlUsd from all lots (SAME LOGIC AS PORTFOLIO ENDPOINT)
      const totalRealizedPnlUsdForToken = closedLotsForToken.reduce((sum: number, lot: any) => {
        if (lot.realizedPnlUsd !== null && lot.realizedPnlUsd !== undefined) {
          return sum + Number(lot.realizedPnlUsd);
        }
        return sum;
      }, 0);

      if (totalRealizedPnlUsdForToken !== 0) {
        totalRealizedPnlUsd += totalRealizedPnlUsdForToken;

        // Calculate cost for ROI
        const closedPnlBase = position.totalProceedsBase - position.totalCostBase;
        const closedPnlPercent = position.totalCostBase > 0
          ? (closedPnlBase / position.totalCostBase) * 100
          : 0;

        if (closedPnlPercent !== 0) {
          const cost = totalRealizedPnlUsdForToken / (closedPnlPercent / 100);
          totalCostUsd += Math.abs(cost);
        }
      }
    }

    const realizedPnlPercent = totalCostUsd > 0 ? (totalRealizedPnlUsd / totalCostUsd) * 100 : 0;

    return {
      realizedPnlUsd: totalRealizedPnlUsd,
      realizedPnlPercent,
      numClosedPositions: recentClosedPositions30d.length,
    };
  }
}

