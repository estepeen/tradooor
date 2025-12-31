/**
 * SPECTRE Bot API Routes
 *
 * Endpoints for viewing SPECTRE trading bot statistics and trades
 */

import { Router } from 'express';
import { spectreTradeService } from '../services/spectre-trade.service.js';

export const spectreRouter = Router();

/**
 * GET /api/spectre/stats
 * Get overall trading statistics
 */
spectreRouter.get('/stats', async (req, res) => {
  try {
    const stats = await spectreTradeService.getStats();
    res.json(stats);
  } catch (error: any) {
    console.error('❌ [Spectre] Error getting stats:', error.message);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * GET /api/spectre/trades
 * Get list of trades with optional filters
 *
 * Query params:
 * - signalType: 'ninja' | 'consensus'
 * - side: 'buy' | 'sell'
 * - success: 'true' | 'false'
 * - limit: number (default 100)
 * - offset: number (default 0)
 */
spectreRouter.get('/trades', async (req, res) => {
  try {
    const { signalType, side, success, limit, offset } = req.query;

    const trades = await spectreTradeService.getTrades({
      signalType: signalType as string | undefined,
      side: side as string | undefined,
      success: success === 'true' ? true : success === 'false' ? false : undefined,
      limit: limit ? parseInt(limit as string) : 100,
      offset: offset ? parseInt(offset as string) : 0,
    });

    res.json(trades);
  } catch (error: any) {
    console.error('❌ [Spectre] Error getting trades:', error.message);
    res.status(500).json({ error: 'Failed to get trades' });
  }
});

/**
 * GET /api/spectre/recent
 * Get recent trades (simplified view)
 */
spectreRouter.get('/recent', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const trades = await spectreTradeService.getRecentTrades(limit);
    res.json(trades);
  } catch (error: any) {
    console.error('❌ [Spectre] Error getting recent trades:', error.message);
    res.status(500).json({ error: 'Failed to get recent trades' });
  }
});
