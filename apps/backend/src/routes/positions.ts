/**
 * Positions API Routes
 *
 * Endpointy pro správu virtuálních pozic a exit signálů
 */

import express from 'express';
import { prisma } from '../lib/prisma.js';
import { PositionMonitorService } from '../services/position-monitor.service.js';
import { TokenMarketDataService } from '../services/token-market-data.service.js';
import { SignalPerformanceService } from '../services/signal-performance.service.js';
import { VirtualPositionRepository } from '../repositories/virtual-position.repository.js';
import { ExitSignalRepository } from '../repositories/exit-signal.repository.js';

const router = express.Router();
const positionMonitor = new PositionMonitorService();
const tokenMarketData = new TokenMarketDataService();
const signalPerformance = new SignalPerformanceService();
const positionRepo = new VirtualPositionRepository();
const exitSignalRepo = new ExitSignalRepository();

/**
 * GET /api/positions
 * Získá všechny pozice (default: open)
 */
router.get('/', async (req, res) => {
  try {
    const { status = 'open', limit = 50 } = req.query;

    const positions = await positionRepo.findOpen({
      status: status !== 'all' ? (status as 'open' | 'closed' | 'partial_exit') : undefined,
      limit: Number(limit),
    });

    // Get token info
    const tokenIds = [...new Set(positions.map(p => p.tokenId))];
    const tokens = await prisma.token.findMany({
      where: { id: { in: tokenIds } },
      select: { id: true, symbol: true, mintAddress: true },
    });
    const tokenMap = new Map(tokens.map(t => [t.id, t]));

    // Enrich positions
    const enrichedPositions = positions.map(pos => {
      const token = tokenMap.get(pos.tokenId);
      const holdTimeMinutes = (Date.now() - pos.entryTimestamp.getTime()) / (1000 * 60);

      return {
        ...pos,
        token: token || null,
        holdTimeMinutes: Math.round(holdTimeMinutes),
        holdTimeFormatted: formatHoldTime(holdTimeMinutes),
      };
    });

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
    const stats = await positionRepo.getStats();

    // Get exit signals from last 24h
    const exitSignals = await exitSignalRepo.findRecent({ hours: 24, limit: 1000 });

    // Group by type
    const signalsByType = exitSignals.reduce((acc: any, s) => {
      acc[s.type] = (acc[s.type] || 0) + 1;
      return acc;
    }, {});

    res.json({
      success: true,
      stats: {
        openPositions: stats.totalOpen,
        closedPositions: stats.totalClosed,
        avgOpenPnlPercent: stats.avgOpenPnlPercent,
        avgClosedPnlPercent: stats.avgClosedPnlPercent,
        winRate: stats.winRate,
        exitSignals24h: exitSignals.length,
        signalsByType,
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
    const position = await positionRepo.findById(id);

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

    // Get token info for price lookup
    const token = await prisma.token.findUnique({
      where: { id: position.tokenId },
      select: { mintAddress: true },
    });

    // Get current price if not provided
    let closePrice = exitPriceUsd;
    if (!closePrice && token?.mintAddress) {
      try {
        const marketData = await tokenMarketData.getMarketData(token.mintAddress);
        closePrice = marketData?.price || position.currentPriceUsd;
      } catch (e) {
        closePrice = position.currentPriceUsd;
      }
    }

    await positionMonitor.closePosition(id, exitReason, closePrice || 0);

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
 * GET /api/positions/exit-signals/recent
 * Získá exit signály
 */
router.get('/exit-signals/recent', async (req, res) => {
  try {
    const { hours = 24, limit = 50 } = req.query;

    const signals = await exitSignalRepo.findRecent({
      hours: Number(hours),
      limit: Number(limit),
    });

    // Get position and token info
    const positionIds = [...new Set(signals.map(s => s.positionId))];
    const positions = await prisma.virtualPosition.findMany({
      where: { id: { in: positionIds } },
      include: {
        token: {
          select: { id: true, symbol: true, mintAddress: true },
        },
      },
    });
    const positionMap = new Map(positions.map(p => [p.id, p]));

    // Enrich signals
    const enrichedSignals = signals.map(signal => {
      const position = positionMap.get(signal.positionId);
      return {
        ...signal,
        position: position ? {
          entryPriceUsd: Number(position.entryPriceUsd),
          entryTimestamp: position.entryTimestamp,
          activeWalletCount: position.activeWalletCount,
          exitedWalletCount: position.exitedWalletCount,
          token: position.token,
        } : null,
      };
    });

    res.json({
      success: true,
      signals: enrichedSignals,
      count: enrichedSignals.length,
    });
  } catch (error: any) {
    console.error('Error fetching exit signals:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch exit signals',
    });
  }
});

/**
 * POST /api/positions/:id/set-trailing-stop
 * Nastaví trailing stop procento pro pozici
 */
router.post('/:id/set-trailing-stop', async (req, res) => {
  try {
    const { id } = req.params;
    const { trailingStopPercent } = req.body;

    if (typeof trailingStopPercent !== 'number' || trailingStopPercent < 0 || trailingStopPercent > 100) {
      return res.status(400).json({
        success: false,
        error: 'trailingStopPercent must be a number between 0 and 100',
      });
    }

    const position = await positionMonitor.setTrailingStop(id, trailingStopPercent);

    if (!position) {
      return res.status(404).json({
        success: false,
        error: 'Position not found',
      });
    }

    res.json({
      success: true,
      position,
      message: `Trailing stop set to ${trailingStopPercent}%`,
    });
  } catch (error: any) {
    console.error('Error setting trailing stop:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to set trailing stop',
    });
  }
});

/**
 * GET /api/positions/:id/performance
 * Získá performance metriky pro pozici
 */
router.get('/:id/performance', async (req, res) => {
  try {
    const { id } = req.params;

    const position = await positionRepo.findById(id);
    if (!position) {
      return res.status(404).json({
        success: false,
        error: 'Position not found',
      });
    }

    // Get signal performance if linked
    let signalPerf = null;
    if (position.signalId) {
      signalPerf = await signalPerformance.getPerformance(position.signalId);
    }

    // Calculate additional metrics
    const holdTimeMinutes = (Date.now() - position.entryTimestamp.getTime()) / (1000 * 60);
    const pnlPerMinute = holdTimeMinutes > 0 ? (position.unrealizedPnlPercent || 0) / holdTimeMinutes : 0;

    res.json({
      success: true,
      performance: {
        position: {
          id: position.id,
          status: position.status,
          entryPriceUsd: position.entryPriceUsd,
          currentPriceUsd: position.currentPriceUsd,
          highestPriceUsd: position.highestPriceUsd,
          lowestPriceUsd: position.lowestPriceUsd,
          unrealizedPnlPercent: position.unrealizedPnlPercent,
          drawdownFromPeak: position.drawdownFromPeak,
          holdTimeMinutes: Math.round(holdTimeMinutes),
          pnlPerMinute,
          trailingStopPercent: position.trailingStopPercent,
          trailingStopPrice: position.trailingStopPrice,
          lastAiDecision: position.lastAiDecision,
          lastAiConfidence: position.lastAiConfidence,
        },
        signal: signalPerf,
      },
    });
  } catch (error: any) {
    console.error('Error fetching position performance:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch position performance',
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


