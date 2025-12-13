import express from 'express';
import { PaperTradeRepository } from '../repositories/paper-trade.repository.js';
import { PaperTradeService } from '../services/paper-trade.service.js';
import { PaperTradingModelsService } from '../services/paper-trading-models.service.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';

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
        // Get all closed trades
        const { data: closedData } = await supabase
          .from('PaperTrade')
          .select('*')
          .eq('status', 'closed')
          .order('closedAt', { ascending: false })
          .limit(limit);
        // Map rows using repository's internal method
        trades = (closedData || []).map((row: any) => {
          const toNumber = (value: any) => (value === null || value === undefined ? 0 : Number(value));
          return {
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
            meta: row.meta || {},
          };
        });
      } else {
        // Get all trades (open + closed)
        const openTrades = await paperTradeRepo.findOpenPositions();
        const { data: closedData } = await supabase
          .from('PaperTrade')
          .select('*')
          .eq('status', 'closed')
          .order('closedAt', { ascending: false })
          .limit(limit);
        const toNumber = (value: any) => (value === null || value === undefined ? 0 : Number(value));
        const closedTrades = (closedData || []).map((row: any) => ({
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
          meta: row.meta || {},
        }));
        trades = [...openTrades, ...closedTrades].slice(0, limit);
      }
    }

    // Enrich with wallet and token data
    const enrichedTrades = await Promise.all(
      trades.map(async (trade) => {
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
 * Získá historii portfolio snapshots
 */
router.get('/portfolio/history', async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const { data, error } = await (await import('../lib/supabase.js')).supabase
      .from('PaperPortfolio')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(error.message);
    }

    res.json({
      success: true,
      snapshots: data || [],
    });
  } catch (error: any) {
    console.error('❌ Error fetching portfolio history:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch portfolio history',
    });
  }
});

export default router;
