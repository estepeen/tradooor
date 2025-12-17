import express from 'express';
import { PaperTradeRepository } from '../repositories/paper-trade.repository.js';
import { PaperTradeService } from '../services/paper-trade.service.js';
import { PaperTradingModelsService } from '../services/paper-trading-models.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { prisma } from '../lib/prisma.js';

const router = express.Router();

/**
 * GET /api/paper-trading/portfolio
 * Získá aktuální portfolio stats
 */
router.get('/portfolio', async (req, res) => {
  try {
    const paperTradeRepo = new PaperTradeRepository();
    const stats = await paperTradeRepo.getPortfolioStats();
    
    res.json({
      success: true,
      ...stats,
    });
  } catch (error: any) {
    console.error('❌ Error fetching paper trading portfolio:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch portfolio',
    });
  }
});

/**
 * GET /api/paper-trading/consensus-trades
 * Získá aktuální consensus trades (Model 2)
 */
router.get('/consensus-trades', async (req, res) => {
  try {
    const timeWindowHours = req.query.hours ? Number(req.query.hours) : 2;
    const paperTradingModels = new PaperTradingModelsService();
    const consensusTrades = await paperTradingModels.findConsensusTrades(timeWindowHours);
    
    res.json({
      success: true,
      consensusTrades,
      count: consensusTrades.length,
    });
  } catch (error: any) {
    console.error('❌ Error fetching consensus trades:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch consensus trades',
    });
  }
});

/**
 * GET /api/paper-trading/trades
 * Získá seznam paper trades
 */
router.get('/trades', async (req, res) => {
  try {
    const walletId = req.query.walletId as string | undefined;
    const status = req.query.status as 'open' | 'closed' | 'cancelled' | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;

    const paperTradeRepo = new PaperTradeRepository();
    const smartWalletRepo = new SmartWalletRepository();
    const tokenRepo = new TokenRepository();

    let trades;
    if (walletId) {
      trades = await paperTradeRepo.findByWallet(walletId, {
        status,
        limit,
        orderBy: 'timestamp',
        orderDirection: 'desc',
      });
    } else {
      // Get all trades
      if (status === 'open') {
        trades = await paperTradeRepo.findOpenPositions();
      } else if (status === 'closed') {
        // Get all closed trades (Prisma)
        const rows = await prisma.paperTrade.findMany({
          where: { status: 'closed' },
          orderBy: { closedAt: 'desc' },
          take: limit,
        });
        const toNumber = (value: any) => (value === null || value === undefined ? 0 : Number(value));
        trades = rows.map((row: any) => ({
          id: row.id,
          walletId: row.walletId,
          tokenId: row.tokenId,
          originalTradeId: row.originalTradeId,
          side: row.side,
          amountToken: toNumber(row.amountToken),
          amountBase: toNumber(row.amountBase),
          priceBasePerToken: toNumber(row.priceBasePerToken),
          timestamp: new Date(row.timestamp),
          status: row.status,
          realizedPnl: row.realizedPnl ? toNumber(row.realizedPnl) : null,
          realizedPnlPercent: row.realizedPnlPercent ? toNumber(row.realizedPnlPercent) : null,
          closedAt: row.closedAt ? new Date(row.closedAt) : null,
          meta: (row.meta as any) || {},
        }));
      } else {
        // Get all trades (open + closed)
        const openTrades = await paperTradeRepo.findOpenPositions();
        const rows = await prisma.paperTrade.findMany({
          where: { status: 'closed' },
          orderBy: { closedAt: 'desc' },
          take: limit,
        });
        const toNumber = (value: any) => (value === null || value === undefined ? 0 : Number(value));
        const closedTrades = rows.map((row: any) => ({
          id: row.id,
          walletId: row.walletId,
          tokenId: row.tokenId,
          originalTradeId: row.originalTradeId,
          side: row.side,
          amountToken: toNumber(row.amountToken),
          amountBase: toNumber(row.amountBase),
          priceBasePerToken: toNumber(row.priceBasePerToken),
          timestamp: new Date(row.timestamp),
          status: row.status,
          realizedPnl: row.realizedPnl ? toNumber(row.realizedPnl) : null,
          realizedPnlPercent: row.realizedPnlPercent ? toNumber(row.realizedPnlPercent) : null,
          closedAt: row.closedAt ? new Date(row.closedAt) : null,
          meta: (row.meta as any) || {},
        }));
        trades = [...openTrades, ...closedTrades].slice(0, limit);
      }
    }

    // Enrich with wallet and token data
    const enrichedTrades = await Promise.all(
      trades.map(async (trade: any) => {
        const [wallet, token] = await Promise.all([
          smartWalletRepo.findById(trade.walletId).catch(() => null),
          tokenRepo.findById(trade.tokenId).catch(() => null),
        ]);

        return {
          ...trade,
          wallet: wallet ? {
            id: wallet.id,
            address: wallet.address,
            label: wallet.label,
          } : null,
          token: token ? {
            id: token.id,
            symbol: token.symbol,
            name: token.name,
            mintAddress: token.mintAddress,
          } : null,
        };
      })
    );

    res.json({
      success: true,
      trades: enrichedTrades,
      total: enrichedTrades.length,
    });
  } catch (error: any) {
    console.error('❌ Error fetching paper trades:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch trades',
    });
  }
});

/**
 * GET /api/paper-trading/trades/:id
 * Získá detail paper trade
 */
router.get('/trades/:id', async (req, res) => {
  try {
    const paperTradeRepo = new PaperTradeRepository();
    const smartWalletRepo = new SmartWalletRepository();
    const tokenRepo = new TokenRepository();

    const trade = await paperTradeRepo.findById(req.params.id);
    if (!trade) {
      return res.status(404).json({
        success: false,
        error: 'Paper trade not found',
      });
    }

    const [wallet, token] = await Promise.all([
      smartWalletRepo.findById(trade.walletId).catch(() => null),
      tokenRepo.findById(trade.tokenId).catch(() => null),
    ]);

    res.json({
      success: true,
      trade: {
        ...trade,
        wallet: wallet ? {
          id: wallet.id,
          address: wallet.address,
          label: wallet.label,
        } : null,
        token: token ? {
          id: token.id,
          symbol: token.symbol,
          name: token.name,
          mintAddress: token.mintAddress,
        } : null,
      },
    });
  } catch (error: any) {
    console.error('❌ Error fetching paper trade:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch trade',
    });
  }
});

/**
 * POST /api/paper-trading/copy-trade
 * Manuálně zkopíruje trade jako paper trade
 */
router.post('/copy-trade', async (req, res) => {
  try {
    const { tradeId, config } = req.body;

    if (!tradeId) {
      return res.status(400).json({
        success: false,
        error: 'tradeId is required',
      });
    }

    const paperTradeService = new PaperTradeService();
    const defaultConfig = {
      enabled: true,
      copyAllTrades: true,
      positionSizePercent: 5,
      maxOpenPositions: 10,
    };

    const finalConfig = { ...defaultConfig, ...config };
    const paperTrade = await paperTradeService.copyBuyTrade(tradeId, finalConfig);

    if (!paperTrade) {
      return res.status(400).json({
        success: false,
        error: 'Trade could not be copied (may already be copied or does not meet criteria)',
      });
    }

    res.json({
      success: true,
      paperTrade,
    });
  } catch (error: any) {
    console.error('❌ Error copying trade:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to copy trade',
    });
  }
});

/**
 * GET /api/paper-trading/portfolio/history
 * (Disabled – paper trading analytics removed)
 */
router.get('/portfolio/history', async (_req, res) => {
  return res.status(501).json({
    success: false,
    error: 'Paper trading portfolio history is disabled.',
  });
});

export default router;
