import express from 'express';
import { SignalService } from '../services/signal.service.js';
import { SignalRepository } from '../repositories/signal.repository.js';

const router = express.Router();
const signalService = new SignalService();
const signalRepo = new SignalRepository();

/**
 * GET /api/signals
 * Získá aktivní signály
 */
router.get('/', async (req, res) => {
  try {
    const { type, walletId, tokenId, limit } = req.query;
    
    const signals = await signalService.getActiveSignals({
      type: type as 'buy' | 'sell' | undefined,
      walletId: walletId as string | undefined,
      tokenId: tokenId as string | undefined,
      limit: limit ? Number(limit) : undefined,
    });

    res.json({
      success: true,
      signals,
      count: signals.length,
    });
  } catch (error: any) {
    console.error('❌ Error fetching signals:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch signals',
    });
  }
});

/**
 * GET /api/signals/:id
 * Získá konkrétní signál
 */
router.get('/:id', async (req, res) => {
  try {
    const signal = await signalRepo.findById(req.params.id);
    
    if (!signal) {
      return res.status(404).json({
        success: false,
        error: 'Signal not found',
      });
    }

    res.json({
      success: true,
      signal,
    });
  } catch (error: any) {
    console.error('❌ Error fetching signal:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch signal',
    });
  }
});

/**
 * POST /api/signals/generate
 * Vygeneruje signál z trade
 */
router.post('/generate', async (req, res) => {
  try {
    const { tradeId, config } = req.body;
    
    if (!tradeId) {
      return res.status(400).json({
        success: false,
        error: 'tradeId is required',
      });
    }

    // Zjisti typ trade (BUY/SELL)
    const { TradeRepository } = await import('../repositories/trade.repository.js');
    const tradeRepo = new TradeRepository();
    const trade = await tradeRepo.findById(tradeId);

    if (!trade) {
      return res.status(404).json({
        success: false,
        error: 'Trade not found',
      });
    }

    let signal;
    if (trade.side === 'buy') {
      signal = await signalService.generateBuySignal(tradeId, config || {});
    } else if (trade.side === 'sell') {
      signal = await signalService.generateSellSignal(tradeId, config || {});
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid trade side',
      });
    }

    if (!signal) {
      return res.status(400).json({
        success: false,
        error: 'Signal generation failed (quality score too low or already exists)',
      });
    }

    res.json({
      success: true,
      signal,
    });
  } catch (error: any) {
    console.error('❌ Error generating signal:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate signal',
    });
  }
});

/**
 * POST /api/signals/:id/execute
 * Označí signál jako executed (použitý)
 */
router.post('/:id/execute', async (req, res) => {
  try {
    const signal = await signalRepo.markAsExecuted(req.params.id);
    
    res.json({
      success: true,
      signal,
    });
  } catch (error: any) {
    console.error('❌ Error executing signal:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to execute signal',
    });
  }
});

/**
 * POST /api/signals/expire-old
 * Expiruje staré signály
 */
router.post('/expire-old', async (req, res) => {
  try {
    const maxAgeHours = req.body.maxAgeHours || 24;
    const expiredCount = await signalRepo.expireOldSignals(maxAgeHours);
    
    res.json({
      success: true,
      expiredCount,
    });
  } catch (error: any) {
    console.error('❌ Error expiring old signals:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to expire old signals',
    });
  }
});

export default router;
