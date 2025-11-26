import { Router } from 'express';
import { supabase, TABLES } from '../lib/supabase.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';

const router = Router();
const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();
const metricsHistoryRepo = new MetricsHistoryRepository();
const closedLotRepo = new ClosedLotRepository();
const metricsCalculator = new MetricsCalculatorService(
  smartWalletRepo,
  tradeRepo,
  metricsHistoryRepo
);

// GET /api/stats/overview - Overall statistics across all wallets
router.get('/overview', async (req, res) => {
  try {
    // Get actual trade count from trades table
    const { count: actualTradeCount } = await supabase
      .from(TABLES.TRADE)
      .select('*', { count: 'exact', head: true });

    const { data: wallets, error } = await supabase
      .from(TABLES.SMART_WALLET)
      .select('id, address, label, score, totalTrades, winRate, pnlTotalBase, recentPnl30dPercent, recentPnl30dUsd, advancedStats, avgHoldingTimeMin, avgRr, avgPnlPercent');

    // Calculate recent PnL in USD for each wallet
    const walletIds = (wallets || []).map(w => w.id);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const { data: recentTrades, error: recentTradesError } = await supabase
      .from(TABLES.TRADE)
      .select('walletId, side, valueUsd')
      .in('walletId', walletIds)
      .gte('timestamp', thirtyDaysAgo.toISOString());

    const walletPnLMap = new Map<string, { buyValue: number; sellValue: number }>();
    if (!recentTradesError && recentTrades) {
      for (const trade of recentTrades) {
        if (!walletPnLMap.has(trade.walletId)) {
          walletPnLMap.set(trade.walletId, { buyValue: 0, sellValue: 0 });
        }
        const pnl = walletPnLMap.get(trade.walletId)!;
        const valueUsd = Number(trade.valueUsd || 0);
        if (trade.side === 'buy') {
          pnl.buyValue += valueUsd;
        } else if (trade.side === 'sell') {
          pnl.sellValue += valueUsd;
        }
      }
    }

    // Add recentPnl30dUsd to wallets
    // DŮLEŽITÉ: Použij recentPnl30dUsd z databáze (pokud existuje), jinak vypočítej z trades
    const walletsWithUsd = (wallets || []).map(w => {
      const pnl = walletPnLMap.get(w.id);
      // Preferuj recentPnl30dUsd z DB (je to precomputed a přesnější), jinak vypočítej z trades
      const recentPnl30dUsd = w.recentPnl30dUsd !== null && w.recentPnl30dUsd !== undefined
        ? Number(w.recentPnl30dUsd)
        : (pnl ? pnl.sellValue - pnl.buyValue : 0);
      return {
        ...w,
        recentPnl30dUsd,
      };
    });

    if (error) {
      throw new Error(`Failed to fetch wallets: ${error.message}`);
    }

    const walletList = walletsWithUsd ?? [];
    const totalWallets = walletList.length;
    const totalTrades = actualTradeCount ?? 0; // Use actual count from trades table
    
    // DŮLEŽITÉ: Počítej totalPnl pouze z walletů, které mají platné pnlTotalBase
    // Ignoruj null, undefined a NaN hodnoty
    const totalPnl = walletList.reduce((sum, w) => {
      const pnl = w.pnlTotalBase;
      if (pnl === null || pnl === undefined || isNaN(Number(pnl))) {
        return sum;
      }
      return sum + Number(pnl);
    }, 0);
    const avgScore = totalWallets > 0 
      ? walletList.reduce((sum, w) => sum + (w.score || 0), 0) / totalWallets 
      : 0;
    const avgWinRate = totalWallets > 0
      ? walletList.reduce((sum, w) => sum + (w.winRate || 0), 0) / totalWallets
      : 0;
    
    // Calculate additional statistics
    const avgHoldingTime = totalWallets > 0
      ? walletList.reduce((sum, w) => sum + (w.avgHoldingTimeMin || 0), 0) / totalWallets
      : 0;
    const avgRr = totalWallets > 0
      ? walletList.reduce((sum, w) => sum + (w.avgRr || 0), 0) / totalWallets
      : 0;
    const avgPnlPercent = totalWallets > 0
      ? walletList.reduce((sum, w) => sum + (w.avgPnlPercent || 0), 0) / totalWallets
      : 0;
    const avgTradesPerWallet = totalWallets > 0
      ? totalTrades / totalWallets
      : 0;
    
    // Activity stats - wallets with trades in last 7/30 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const { data: recentTrades7d } = await supabase
      .from(TABLES.TRADE)
      .select('walletId')
      .gte('timestamp', sevenDaysAgo.toISOString());
    const activeWallets7d = new Set((recentTrades7d || []).map(t => t.walletId)).size;
    const activeWallets30d = new Set((recentTrades || []).map(t => t.walletId)).size;
    
    // Trades count by period
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    const { count: trades1d } = await supabase
      .from(TABLES.TRADE)
      .select('*', { count: 'exact', head: true })
      .gte('timestamp', oneDayAgo.toISOString());
    const { count: trades7d } = await supabase
      .from(TABLES.TRADE)
      .select('*', { count: 'exact', head: true })
      .gte('timestamp', sevenDaysAgo.toISOString());
    
    // Performance distribution
    const profitableWallets = walletList.filter(w => (w.pnlTotalBase || 0) > 0).length;
    const losingWallets = walletList.filter(w => (w.pnlTotalBase || 0) < 0).length;
    const scoreDistribution = {
      high: walletList.filter(w => (w.score || 0) >= 70).length,
      medium: walletList.filter(w => (w.score || 0) >= 50 && (w.score || 0) < 70).length,
      low: walletList.filter(w => (w.score || 0) < 50).length,
    };
    
    // Bottom performers
    const bottomByPnl = [...walletList]
      .filter(w => (w.pnlTotalBase || 0) < 0)
      .sort((a, b) => (a.pnlTotalBase || 0) - (b.pnlTotalBase || 0))
      .slice(0, 5);
    const bottomByWinRate = [...walletList]
      .filter(w => (w.winRate || 0) < 0.5)
      .sort((a, b) => (a.winRate || 0) - (b.winRate || 0))
      .slice(0, 5);
    
    // Volume stats - calculate from trades valueUsd
    const { data: allTrades } = await supabase
      .from(TABLES.TRADE)
      .select('valueUsd')
      .gte('timestamp', thirtyDaysAgo.toISOString());
    const totalVolume30d = (allTrades || []).reduce((sum, t) => sum + (Number(t.valueUsd) || 0), 0);
    const avgVolumePerWallet = activeWallets30d > 0 ? totalVolume30d / activeWallets30d : 0;

    // Top performers
    const topByScore = [...walletList].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
    const topByPnl = [...walletList].sort((a, b) => (b.pnlTotalBase || 0) - (a.pnlTotalBase || 0)).slice(0, 5);
    
    // Calculate PnL for different time periods (1d, 7d, 14d, 30d) using closed lots
    const now = new Date();
    const periods = [
      { label: '1d', days: 1 },
      { label: '7d', days: 7 },
      { label: '14d', days: 14 },
      { label: '30d', days: 30 },
    ];
    
    const topByPeriod: Record<string, any[]> = {};
    
    for (const period of periods) {
      const fromDate = new Date(now);
      fromDate.setDate(fromDate.getDate() - period.days);
      
      // Calculate PnL for each wallet for this period
      const walletsWithPeriodPnl = await Promise.all(
        walletList.map(async (wallet) => {
          // Try to use advancedStats.rolling if available
          const rolling = (wallet.advancedStats as any)?.rolling;
          let pnlUsd = 0;
          let pnlPercent = 0;
          
          if (rolling) {
            // Use rolling stats if available
            const rollingKey = period.label === '1d' ? '7d' : period.label; // Use 7d for 1d as fallback
            const rollingData = rolling[rollingKey];
            if (rollingData) {
              pnlUsd = rollingData.realizedPnlUsd || 0;
              pnlPercent = rollingData.realizedRoiPercent || 0;
            }
          }
          
          // If no rolling stats, calculate from closed lots
          if (pnlUsd === 0 && pnlPercent === 0) {
            try {
              const closedLots = await closedLotRepo.findByWallet(wallet.id, { fromDate });
              const periodLots = closedLots.filter(lot => {
                const closeDate = new Date(lot.exitTime);
                return closeDate >= fromDate && lot.costKnown !== false;
              });
              
              if (periodLots.length > 0) {
                // Sum realized PnL from closed lots
                const totalRealizedPnl = periodLots.reduce((sum, lot) => sum + (lot.realizedPnl || 0), 0);
                const totalCostBasis = periodLots.reduce((sum, lot) => sum + (lot.costBasis || 0), 0);
                pnlUsd = totalRealizedPnl;
                pnlPercent = totalCostBasis > 0 ? ((totalRealizedPnl / totalCostBasis) * 100) : 0;
              }
            } catch (error: any) {
              // If closed lots fetch fails, use fallback
              if (period.label === '30d') {
                pnlUsd = wallet.recentPnl30dUsd || 0;
                pnlPercent = wallet.recentPnl30dPercent || 0;
              }
            }
          }
          
          return {
            ...wallet,
            periodPnlUsd: pnlUsd,
            periodPnlPercent: pnlPercent,
          };
        })
      );
      
      // Sort by PnL USD and take top 5
      topByPeriod[period.label] = walletsWithPeriodPnl
        .sort((a, b) => (b.periodPnlUsd || 0) - (a.periodPnlUsd || 0))
        .slice(0, 5)
        .map(w => ({
          id: w.id,
          address: w.address,
          label: w.label,
          totalTrades: w.totalTrades,
          recentPnl30dUsd: w.periodPnlUsd,
          recentPnl30dPercent: w.periodPnlPercent,
          advancedStats: w.advancedStats, // Keep for frontend
        }));
    }

    res.json({
      totalWallets,
      totalTrades,
      totalPnl,
      avgScore,
      avgWinRate,
      // Overview metrics
      avgHoldingTime,
      avgRr,
      avgPnlPercent,
      avgTradesPerWallet,
      // Activity stats
      activeWallets7d,
      activeWallets30d,
      trades1d: trades1d || 0,
      trades7d: trades7d || 0,
      // Performance distribution
      profitableWallets,
      losingWallets,
      scoreDistribution,
      bottomPerformers: {
        byPnl: bottomByPnl,
        byWinRate: bottomByWinRate,
      },
      // Volume stats
      totalVolume30d,
      avgVolumePerWallet,
      // Top performers
      topPerformers: {
        byScore: topByScore,
        byPnl: topByPnl,
        byRecentPnl: topByPeriod['30d'], // Keep for backward compatibility
        byPeriod: topByPeriod, // New: 1d, 7d, 14d, 30d
      },
    });
  } catch (error: any) {
    console.error('Error fetching overview stats:', error);
    res.status(500).json({ error: 'Internal server error', message: error?.message });
  }
});

// GET /api/stats/tokens - Token statistics
router.get('/tokens', async (req, res) => {
  try {
    const { data: trades, error } = await supabase
      .from(TABLES.TRADE)
      .select(`
        *,
        token:${TABLES.TOKEN}(*),
        wallet:${TABLES.SMART_WALLET}(id, address)
      `);

    if (error) {
      throw new Error(`Failed to fetch trades: ${error.message}`);
    }

    // Group by token
    const tokenMap = new Map<string, {
      token: any;
      tradeCount: number;
      uniqueWallets: Set<string>;
      buyCount: number;
      sellCount: number;
    }>();

    for (const trade of trades ?? []) {
      const tokenId = trade.tokenId;
      if (!tokenMap.has(tokenId)) {
        tokenMap.set(tokenId, {
          token: trade.token,
          tradeCount: 0,
          uniqueWallets: new Set(),
          buyCount: 0,
          sellCount: 0,
        });
      }
      const stats = tokenMap.get(tokenId)!;
      stats.tradeCount++;
      stats.uniqueWallets.add(trade.walletId);
      if (trade.side === 'buy') stats.buyCount++;
      else stats.sellCount++;
    }

    const tokenStats = Array.from(tokenMap.entries())
      .map(([tokenId, stats]) => ({
        tokenId,
        token: stats.token,
        tradeCount: stats.tradeCount,
        uniqueWallets: stats.uniqueWallets.size,
        buyCount: stats.buyCount,
        sellCount: stats.sellCount,
      }))
      .sort((a, b) => b.tradeCount - a.tradeCount)
      .slice(0, 50); // Top 50 most traded tokens

    res.json({ tokens: tokenStats });
  } catch (error: any) {
    console.error('Error fetching token stats:', error);
    res.status(500).json({ error: 'Internal server error', message: error?.message });
  }
});

// GET /api/stats/dex - DEX statistics
router.get('/dex', async (req, res) => {
  try {
    const { data: trades, error } = await supabase
      .from(TABLES.TRADE)
      .select('dex');

    if (error) {
      throw new Error(`Failed to fetch trades: ${error.message}`);
    }

    // Group by DEX
    const dexMap = new Map<string, number>();
    for (const trade of trades ?? []) {
      const count = dexMap.get(trade.dex) || 0;
      dexMap.set(trade.dex, count + 1);
    }

    const dexStats = Array.from(dexMap.entries())
      .map(([dex, tradeCount]) => ({
        dex,
        tradeCount,
      }))
      .sort((a, b) => b.tradeCount - a.tradeCount);

    res.json({ dexes: dexStats });
  } catch (error: any) {
    console.error('Error fetching DEX stats:', error);
    res.status(500).json({ error: 'Internal server error', message: error?.message });
  }
});

export { router as statsRouter };
