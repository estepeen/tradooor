import { Router } from 'express';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';
import { prisma } from '../lib/prisma.js';

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
    // Get actual trade count from trades table (Prisma)
    const actualTradeCount = await prisma.trade.count();

    const wallets = await prisma.smartWallet.findMany({
      select: {
        id: true,
        address: true,
        label: true,
        score: true,
        totalTrades: true,
        winRate: true,
        pnlTotalBase: true,
        recentPnl30dPercent: true,
        recentPnl30dUsd: true,
        advancedStats: true,
        avgHoldingTimeMin: true,
        avgRr: true,
        avgPnlPercent: true,
      },
    });

    // Calculate recent PnL in USD for each wallet
    const walletIds = (wallets || []).map((w) => w.id);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const recentTrades = await prisma.trade.findMany({
      where: {
        walletId: { in: walletIds },
        timestamp: { gte: thirtyDaysAgo },
      },
      select: {
        walletId: true,
        side: true,
        valueUsd: true,
      },
    });

    const walletPnLMap = new Map<string, { buyValue: number; sellValue: number }>();
    if (recentTrades) {
      for (const trade of recentTrades as any[]) {
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

    // Add recentPnl30dBase to wallets (PnL v SOL)
    // DŮLEŽITÉ: Použij recentPnl30dBase z databáze (pokud existuje), jinak vypočítej z trades
    const walletsWithBase = (wallets || []).map((w: any) => {
      const pnl = walletPnLMap.get(w.id);
      // Preferuj recentPnl30dBase z DB (je to precomputed a přesnější), jinak vypočítej z trades
      // Mapujeme recentPnl30dUsd (DB sloupec) na recentPnl30dBase (SOL hodnota)
      // DŮLEŽITÉ: Všechny hodnoty jsou nyní v SOL, žádný přepočet!
      const recentPnl30dBase = w.recentPnl30dUsd !== null && w.recentPnl30dUsd !== undefined
        ? Number(w.recentPnl30dUsd) // V DB je to SOL hodnota (i když se jmenuje Usd)
        : 0; // Pokud není v DB, použij 0 (ne přepočítávej z trades)
      return {
        ...w,
        recentPnl30dBase, // PnL v SOL
      };
    });

    const walletList = walletsWithBase ?? [];
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
    const recentTrades7d = await prisma.trade.findMany({
      where: {
        timestamp: { gte: sevenDaysAgo },
      },
      select: { walletId: true },
    });
    const activeWallets7d = new Set((recentTrades7d || []).map((t: any) => t.walletId)).size;
    const activeWallets30d = new Set((recentTrades || []).map(t => t.walletId)).size;
    
    // Trades count by period
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    const trades1d = await prisma.trade.count({
      where: { timestamp: { gte: oneDayAgo } },
    });
    const trades7d = await prisma.trade.count({
      where: { timestamp: { gte: sevenDaysAgo } },
    });
    
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
    const allTrades = await prisma.trade.findMany({
      where: { timestamp: { gte: thirtyDaysAgo } },
      select: { valueUsd: true },
    });
    const totalVolume30d = (allTrades || []).reduce(
      (sum, t: any) => sum + (t.valueUsd !== null && t.valueUsd !== undefined ? Number(t.valueUsd) : 0),
      0
    );
    const avgVolumePerWallet = activeWallets30d > 0 ? totalVolume30d / activeWallets30d : 0;

    // Top performers
    const topByScore = [...walletList].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
    const topByPnl = [...walletList].sort((a, b) => (b.pnlTotalBase || 0) - (a.pnlTotalBase || 0)).slice(0, 5);
    
    // Calculate PnL for different time periods (1d, 7d, 14d, 30d) using advancedStats.rolling
    // STEJNÝ PRINCIP JAKO NA HOMEPAGE - používej rolling stats z advancedStats
    const periods = [
      { label: '1d', rollingKey: '7d' }, // Pro 1d použij 7d jako fallback (stejně jako homepage)
      { label: '7d', rollingKey: '7d' },
      { label: '14d', rollingKey: '30d' }, // Pro 14d použij 30d jako aproximaci
      { label: '30d', rollingKey: '30d' },
    ];
    
    const topByPeriod: Record<string, any[]> = {};
    
    for (const period of periods) {
      // Calculate PnL for each wallet for this period using advancedStats.rolling
      const walletsWithPeriodPnl = walletList.map((wallet) => {
        // STEJNÁ LOGIKA JAKO NA HOMEPAGE: použij advancedStats.rolling pokud je dostupné
        const rolling = (wallet.advancedStats as any)?.rolling;
        let pnlBase = 0; // PnL v SOL
        let pnlPercent = 0;
        
        if (rolling && rolling[period.rollingKey]) {
          // Použij rolling stats (stejně jako homepage)
          const rollingData = rolling[period.rollingKey];
          pnlBase = rollingData.realizedPnl || 0; // PnL v SOL (změněno z realizedPnlUsd)
          pnlPercent = rollingData.realizedRoiPercent || 0;
        } else {
          // Fallback: použij recentPnl30dBase/recentPnl30dPercent (stejně jako homepage)
          if (period.label === '30d' || period.rollingKey === '30d') {
            pnlBase = wallet.recentPnl30dBase || wallet.recentPnl30dUsd || 0; // PnL v SOL
            pnlPercent = wallet.recentPnl30dPercent || 0;
          } else if (period.rollingKey === '7d') {
            // Pro 7d a 1d použij 30d jako fallback, pokud není 7d rolling data
            pnlBase = wallet.recentPnl30dBase || wallet.recentPnl30dUsd || 0; // PnL v SOL
            pnlPercent = wallet.recentPnl30dPercent || 0;
          }
        }
        
        return {
          ...wallet,
          periodPnlBase: pnlBase, // PnL v SOL (změněno z periodPnlUsd)
          periodPnlPercent: pnlPercent,
        };
      });
      
      // Sort by PnL SOL and take top 5
      topByPeriod[period.label] = walletsWithPeriodPnl
        .sort((a, b) => (b.periodPnlBase || 0) - (a.periodPnlBase || 0))
        .slice(0, 5)
        .map(w => ({
          id: w.id,
          address: w.address,
          label: w.label,
          totalTrades: w.totalTrades,
          recentPnl30dBase: w.periodPnlBase, // PnL v SOL (změněno z recentPnl30dUsd)
          recentPnl30dPercent: w.periodPnlPercent, // Použij periodPnlPercent pro zobrazení
          advancedStats: w.advancedStats, // Keep for frontend - frontend použije rolling stats přímo
        }));
    }
    
    // Top traders by score (points) for each period - use overall score (independent of period)
    // Score je celkové skóre kvality tradera, nezávislé na období
    const topByPeriodByScore: Record<string, any[]> = {};
    for (const period of periods) {
      // Pro všechny období použij stejné top 5 podle celkového score
      topByPeriodByScore[period.label] = [...walletList]
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 5)
        .map(w => ({
          id: w.id,
          address: w.address,
          label: w.label,
          totalTrades: w.totalTrades,
          score: w.score,
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
        byPeriod: topByPeriod, // New: 1d, 7d, 14d, 30d (by USD)
        byPeriodByScore: topByPeriodByScore, // New: 1d, 7d, 14d, 30d (by points/score)
      },
    });
  } catch (error: any) {
    console.error('Error fetching overview stats:', error);
    res.status(500).json({ error: 'Internal server error', message: error?.message });
  }
});

// GET /api/stats/tokens - Token statistics with enhanced metrics
// Query params: period (1d, 7d, 14d, 30d, all-time) - default: all-time
router.get('/tokens', async (req, res) => {
  try {
    const period = (req.query.period as string) || 'all-time';
    
    // Calculate date filter based on period
    let fromDate: Date | null = null;
    const now = new Date();
    switch (period) {
      case '1d':
        fromDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
        break;
      case '7d':
        fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '14d':
        fromDate = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'all-time':
      default:
        fromDate = null; // No filter
        break;
    }

    // Get trades for basic stats (filtered by period if specified) – Prisma
    const trades = await prisma.trade.findMany({
      where: fromDate ? { timestamp: { gte: fromDate } } : {},
      include: {
        token: true,
        wallet: {
          select: { id: true, address: true },
        },
      },
    });

    // Get closed lots for PnL and win rate calculations (filtered by period if specified)
    const closedLots = await prisma.closedLot.findMany({
      where: fromDate ? { exitTime: { gte: fromDate } } : {},
      select: {
        tokenId: true,
        realizedPnl: true,
        realizedPnlPercent: true,
        costBasis: true,
        proceeds: true,
        walletId: true,
        exitTime: true,
      },
    });

    // Group by token
    const tokenMap = new Map<string, {
      token: any;
      tradeCount: number;
      uniqueWallets: Set<string>;
      buyCount: number;
      sellCount: number;
      totalVolume: number;
      closedLots: any[];
      totalPnl: number;
      totalCost: number;
      totalProceeds: number;
      winCount: number;
      lossCount: number;
    }>();

    // Process trades
    for (const trade of trades ?? []) {
      const tokenId = trade.tokenId;
      if (!tokenMap.has(tokenId)) {
        tokenMap.set(tokenId, {
          token: trade.token,
          tradeCount: 0,
          uniqueWallets: new Set(),
          buyCount: 0,
          sellCount: 0,
          totalVolume: 0,
          closedLots: [],
          totalPnl: 0,
          totalCost: 0,
          totalProceeds: 0,
          winCount: 0,
          lossCount: 0,
        });
      }
      const stats = tokenMap.get(tokenId)!;
      stats.tradeCount++;
      stats.uniqueWallets.add(trade.walletId);
      if (trade.side === 'buy') stats.buyCount++;
      else stats.sellCount++;
      
      // Add volume - try multiple sources
      const valueUsd = Number((trade as any).valueUsd || (trade as any).meta?.valueUsd || 0);
      const amountBase = Number(trade.amountBase || 0);
      // Use valueUsd if available, otherwise estimate from amountBase (assuming SOL price ~$150)
      const volume = valueUsd > 0 ? valueUsd : (amountBase * 150); // Fallback estimate
      stats.totalVolume += volume;
    }

    // Process closed lots for PnL and win rate
    for (const lot of closedLots ?? []) {
      const tokenId = lot.tokenId;
      if (!tokenMap.has(tokenId)) continue;
      
      const stats = tokenMap.get(tokenId)!;
      stats.closedLots.push(lot);
      
      const pnl = Number(lot.realizedPnl || 0);
      const cost = Number(lot.costBasis || 0);
      const proceeds = Number(lot.proceeds || 0);
      
      stats.totalPnl += pnl;
      stats.totalCost += cost;
      stats.totalProceeds += proceeds;
      
      if (pnl > 0) stats.winCount++;
      else if (pnl < 0) stats.lossCount++;
    }

    const tokenStats = Array.from(tokenMap.entries())
      .map(([tokenId, stats]) => {
        const closedPositions = stats.closedLots.length;
        const winRate = closedPositions > 0 
          ? (stats.winCount / closedPositions) * 100 
          : 0;
        const avgPnl = closedPositions > 0 
          ? stats.totalPnl / closedPositions 
          : 0;
        const avgPnlPercent = stats.totalCost > 0
          ? (stats.totalPnl / stats.totalCost) * 100
          : 0;

        return {
          tokenId,
          token: stats.token,
          tradeCount: stats.tradeCount,
          uniqueWallets: stats.uniqueWallets.size,
          buyCount: stats.buyCount,
          sellCount: stats.sellCount,
          totalVolume: stats.totalVolume,
          closedPositions,
          totalPnl: stats.totalPnl,
          totalCost: stats.totalCost,
          totalProceeds: stats.totalProceeds,
          winRate,
          avgPnl,
          avgPnlPercent,
          winCount: stats.winCount,
          lossCount: stats.lossCount,
        };
      })
      .sort((a, b) => b.tradeCount - a.tradeCount)
      .slice(0, 100); // Top 100 most traded tokens

    console.log(`📊 Token stats calculated: ${tokenStats.length} tokens, period: ${period}, closed lots: ${closedLots?.length || 0}`);

    res.json({ tokens: tokenStats });
  } catch (error: any) {
    console.error('Error fetching token stats:', error);
    res.status(500).json({ error: 'Internal server error', message: error?.message });
  }
});

// GET /api/stats/dex - DEX statistics
router.get('/dex', async (req, res) => {
  try {
    const trades = await prisma.trade.findMany({
      select: { dex: true },
    });

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
    // Detect primary base token from trades (for multichain support)
    // Count base tokens from recent trades to determine primary base token
    const baseTokenCounts = new Map<string, number>();
    const sampleTrades = await prisma.trade.findMany({
      take: 1000, // Sample 1000 trades
      select: { meta: true },
    });
    
    for (const trade of sampleTrades) {
      const meta = (trade.meta as any) || {};
      const baseToken = (meta.baseToken || 'SOL').toUpperCase();
      baseTokenCounts.set(baseToken, (baseTokenCounts.get(baseToken) || 0) + 1);
    }
    
    // Find most common base token, default to SOL
    let primaryBaseToken = 'SOL';
    let maxCount = 0;
    for (const [token, count] of baseTokenCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        primaryBaseToken = token;
      }
    }
    
    // Normalize WSOL → SOL for display
    if (primaryBaseToken === 'WSOL') {
      primaryBaseToken = 'SOL';
    }

    res.json({
      totalWallets,
      totalTrades: actualTradeCount,
      totalPnl,
      avgScore,
      avgWinRate,
      avgHoldingTime,
      avgRr,
      avgPnlPercent,
      avgTradesPerWallet,
      activeWallets7d,
      activeWallets30d,
      trades1d,
      trades7d,
      profitableWallets,
      losingWallets,
      breakEvenWallets,
      topPerformers,
      baseToken: primaryBaseToken, // Primary base token for display
    });
  } catch (error: any) {
    console.error('Error fetching stats overview:', error);
    res.status(500).json({ error: 'Internal server error', message: error?.message });
  }
});

export { router as statsRouter };
