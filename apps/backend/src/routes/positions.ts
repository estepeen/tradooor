/**
 * Positions API Routes
 * 
 * Endpointy pro správu virtuálních pozic a exit signálů
 */

import express from 'express';
import { supabase, TABLES } from '../lib/supabase.js';
import { PositionMonitorService } from '../services/position-monitor.service.js';
import { TokenMarketDataService } from '../services/token-market-data.service.js';

const router = express.Router();
const positionMonitor = new PositionMonitorService();
const tokenMarketData = new TokenMarketDataService();

/**
 * GET /api/positions
 * Získá všechny pozice (default: open)
 */
router.get('/', async (req, res) => {
  try {
    const { status = 'open', limit = 50 } = req.query;
    
    let query = supabase
      .from('VirtualPosition')
      .select(`
        *,
        token:tokenId(symbol, mintAddress)
      `)
      .order('entryTime', { ascending: false })
      .limit(Number(limit));

    if (status !== 'all') {
      query = query.eq('status', status);
    }

    const { data: positions, error } = await query;

    if (error) {
      throw error;
    }

    // Enrich with current price if needed
    const enrichedPositions = await Promise.all(
      (positions || []).map(async (pos: any) => {
        // Calculate hold time
        const holdTimeMinutes = (Date.now() - new Date(pos.entryTime).getTime()) / (1000 * 60);
        
        return {
          ...pos,
          holdTimeMinutes: Math.round(holdTimeMinutes),
          holdTimeFormatted: formatHoldTime(holdTimeMinutes),
        };
      })
    );

    res.json({
      success: true,
      positions: enrichedPositions,
      count: enrichedPositions.length,
    });
  } catch (error: any) {
    console.error('Error fetching positions:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch positions',
    });
  }
});

/**
 * GET /api/positions/stats
 * Statistiky pozic
 */
router.get('/stats', async (req, res) => {
  try {
    const { data: openPositions } = await supabase
      .from('VirtualPosition')
      .select('unrealizedPnlPercent, unrealizedPnlUsd, activeWalletCount, exitedWalletCount')
      .eq('status', 'open');

    const { data: closedPositions } = await supabase
      .from('VirtualPosition')
      .select('realizedPnlPercent, realizedPnlUsd, exitReason')
      .eq('status', 'closed');

    const { data: exitSignals } = await supabase
      .from('ExitSignal')
      .select('type, recommendation')
      .gte('createdAt', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    const open = openPositions || [];
    const closed = closedPositions || [];
    const signals = exitSignals || [];

    // Calculate stats
    const totalOpenPnl = open.reduce((sum, p) => sum + (Number(p.unrealizedPnlPercent) || 0), 0);
    const avgOpenPnl = open.length > 0 ? totalOpenPnl / open.length : 0;

    const totalClosedPnl = closed.reduce((sum, p) => sum + (Number(p.realizedPnlPercent) || 0), 0);
    const avgClosedPnl = closed.length > 0 ? totalClosedPnl / closed.length : 0;

    const profitableCount = closed.filter(p => (Number(p.realizedPnlPercent) || 0) > 0).length;
    const winRate = closed.length > 0 ? (profitableCount / closed.length) * 100 : 0;

    res.json({
      success: true,
      stats: {
        openPositions: open.length,
        closedPositions: closed.length,
        avgOpenPnlPercent: avgOpenPnl,
        avgClosedPnlPercent: avgClosedPnl,
        winRate,
        exitSignals24h: signals.length,
        signalsByType: signals.reduce((acc: any, s) => {
          acc[s.type] = (acc[s.type] || 0) + 1;
          return acc;
        }, {}),
      },
    });
  } catch (error: any) {
    console.error('Error fetching position stats:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch position stats',
    });
  }
});

/**
 * GET /api/positions/:id
 * Detail pozice s wallet aktivitami a exit signály
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const details = await positionMonitor.getPositionWithDetails(id);
    
    if (!details) {
      return res.status(404).json({
        success: false,
        error: 'Position not found',
      });
    }

    res.json({
      success: true,
      ...details,
    });
  } catch (error: any) {
    console.error('Error fetching position details:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch position details',
    });
  }
});

/**
 * POST /api/positions/:id/close
 * Manuální zavření pozice
 */
router.post('/:id/close', async (req, res) => {
  try {
    const { id } = req.params;
    const { exitReason = 'manual', exitPriceUsd } = req.body;

    // Get position
    const { data: position } = await supabase
      .from('VirtualPosition')
      .select('*, token:tokenId(mintAddress)')
      .eq('id', id)
      .single();

    if (!position) {
      return res.status(404).json({
        success: false,
        error: 'Position not found',
      });
    }

    if (position.status !== 'open') {
      return res.status(400).json({
        success: false,
        error: 'Position is not open',
      });
    }

    // Get current price if not provided
    let closePrice = exitPriceUsd;
    if (!closePrice && position.token?.mintAddress) {
      try {
        const marketData = await tokenMarketData.getMarketData(position.token.mintAddress);
        closePrice = marketData?.price || position.currentPriceUsd;
      } catch (e) {
        closePrice = position.currentPriceUsd;
      }
    }

    await positionMonitor.closePosition(id, exitReason, closePrice);

    res.json({
      success: true,
      message: 'Position closed successfully',
    });
  } catch (error: any) {
    console.error('Error closing position:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to close position',
    });
  }
});

/**
 * POST /api/positions/update-all
 * Ručně spustit update všech pozic
 */
router.post('/update-all', async (req, res) => {
  try {
    await positionMonitor.updateAllOpenPositions();
    
    res.json({
      success: true,
      message: 'Position update triggered',
    });
  } catch (error: any) {
    console.error('Error updating positions:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update positions',
    });
  }
});

/**
 * GET /api/positions/exit-signals
 * Získá exit signály
 */
router.get('/exit-signals/recent', async (req, res) => {
  try {
    const { hours = 24, limit = 50 } = req.query;
    
    const { data: signals, error } = await supabase
      .from('ExitSignal')
      .select(`
        *,
        position:positionId(
          entryPriceUsd,
          entryTime,
          activeWalletCount,
          exitedWalletCount,
          token:tokenId(symbol, mintAddress)
        )
      `)
      .gte('createdAt', new Date(Date.now() - Number(hours) * 60 * 60 * 1000).toISOString())
      .order('createdAt', { ascending: false })
      .limit(Number(limit));

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      signals: signals || [],
      count: (signals || []).length,
    });
  } catch (error: any) {
    console.error('Error fetching exit signals:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch exit signals',
    });
  }
});

// Helper function
function formatHoldTime(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 24 * 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / (24 * 60)).toFixed(1)}d`;
}

export default router;

