import { Router } from 'express';
import { supabase, TABLES } from '../lib/supabase.js';
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
    // Get actual trade count from trades table
    const { count: actualTradeCount } = await supabase
      .from(TABLES.TRADE)
      .select('*', { count: 'exact', head: true });

    const { data: wallets, error } = await supabase
      .from(TABLES.SMART_WALLET)
      .select('id, address, label, score, totalTrades, winRate, pnlTotalBase, recentPnl30dPercent');

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
    const walletsWithUsd = (wallets || []).map(w => {
      const pnl = walletPnLMap.get(w.id);
      return {
        ...w,
        recentPnl30dUsd: pnl ? pnl.sellValue - pnl.buyValue : 0,
      };
    });

    if (error) {
      throw new Error(`Failed to fetch wallets: ${error.message}`);
    }

    const walletList = walletsWithUsd ?? [];
    const totalWallets = walletList.length;
    const totalTrades = actualTradeCount ?? 0; // Use actual count from trades table
    const totalPnl = walletList.reduce((sum, w) => sum + (w.pnlTotalBase || 0), 0);
    const avgScore = totalWallets > 0 
      ? walletList.reduce((sum, w) => sum + (w.score || 0), 0) / totalWallets 
      : 0;
    const avgWinRate = totalWallets > 0
      ? walletList.reduce((sum, w) => sum + (w.winRate || 0), 0) / totalWallets
      : 0;

    // Top performers
    const topByScore = [...walletList].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
    const topByPnl = [...walletList].sort((a, b) => (b.pnlTotalBase || 0) - (a.pnlTotalBase || 0)).slice(0, 5);
    const topByRecentPnl = [...walletList].sort((a, b) => (b.recentPnl30dPercent || 0) - (a.recentPnl30dPercent || 0)).slice(0, 5);

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
