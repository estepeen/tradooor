import { Router } from 'express';
import { prisma } from '@solbot/db';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';

const router = Router();
const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();
const metricsHistoryRepo = new MetricsHistoryRepository();
const metricsCalculator = new MetricsCalculatorService(
  smartWalletRepo,
  tradeRepo,
  metricsHistoryRepo
);

// GET /api/stats/overview - Overall statistics across all wallets
router.get('/overview', async (req, res) => {
  try {
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
      },
    });

    const totalWallets = wallets.length;
    const totalTrades = wallets.reduce((sum, w) => sum + w.totalTrades, 0);
    const totalPnl = wallets.reduce((sum, w) => sum + w.pnlTotalBase, 0);
    const avgScore = totalWallets > 0 
      ? wallets.reduce((sum, w) => sum + w.score, 0) / totalWallets 
      : 0;
    const avgWinRate = totalWallets > 0
      ? wallets.reduce((sum, w) => sum + w.winRate, 0) / totalWallets
      : 0;

    // Top performers
    const topByScore = [...wallets].sort((a, b) => b.score - a.score).slice(0, 5);
    const topByPnl = [...wallets].sort((a, b) => b.pnlTotalBase - a.pnlTotalBase).slice(0, 5);
    const topByRecentPnl = [...wallets].sort((a, b) => b.recentPnl30dPercent - a.recentPnl30dPercent).slice(0, 5);

    res.json({
      totalWallets,
      totalTrades,
      totalPnl,
      avgScore,
      avgWinRate,
      topPerformers: {
        byScore: topByScore,
        byPnl: topByPnl,
        byRecentPnl: topByRecentPnl,
      },
    });
  } catch (error) {
    console.error('Error fetching overview stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stats/tokens - Token statistics
router.get('/tokens', async (req, res) => {
  try {
    const trades = await prisma.trade.findMany({
      include: {
        token: true,
        wallet: {
          select: {
            id: true,
            address: true,
          },
        },
      },
    });

    // Group by token
    const tokenMap = new Map<string, {
      token: any;
      tradeCount: number;
      uniqueWallets: Set<string>;
      buyCount: number;
      sellCount: number;
    }>();

    for (const trade of trades) {
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
  } catch (error) {
    console.error('Error fetching token stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stats/dex - DEX statistics
router.get('/dex', async (req, res) => {
  try {
    const trades = await prisma.trade.groupBy({
      by: ['dex'],
      _count: {
        id: true,
      },
    });

    const dexStats = trades
      .map(d => ({
        dex: d.dex,
        tradeCount: d._count.id,
      }))
      .sort((a, b) => b.tradeCount - a.tradeCount);

    res.json({ dexes: dexStats });
  } catch (error) {
    console.error('Error fetching DEX stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as statsRouter };

