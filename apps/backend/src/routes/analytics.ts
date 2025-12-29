/**
 * Analytics API Routes
 * 
 * Endpoints pro Level 1 & 2 features:
 * - Signal stats & outcomes
 * - Backtesting
 * - Wallet correlations
 * - Token risk
 */

import express from 'express';
import { SignalOutcomeService } from '../services/signal-outcome.service.js';
import { BacktestService } from '../services/backtest.service.js';
import { WalletCorrelationService } from '../services/wallet-correlation.service.js';
import { TokenRiskService } from '../services/token-risk.service.js';
import { PriceMonitorService } from '../services/price-monitor.service.js';
import { NotificationService } from '../services/notification.service.js';

const router = express.Router();
const outcomeService = new SignalOutcomeService();
const backtestService = new BacktestService();
const correlationService = new WalletCorrelationService();
const tokenRiskService = new TokenRiskService();
const priceMonitor = new PriceMonitorService();
const notificationService = new NotificationService();

// ============================================
// SIGNAL STATS & OUTCOMES
// ============================================

/**
 * GET /api/analytics/stats
 * Získá agregované statistiky signálů
 */
router.get('/stats', async (req, res) => {
  try {
    const { period = 'all_time', signalType } = req.query;
    
    const stats = await outcomeService.calculateStats(
      period as any,
      signalType as string | undefined
    );
    
    res.json({
      success: true,
      stats,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/analytics/stats/history
 * Získá historii denních statistik
 */
router.get('/stats/history', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const history = await outcomeService.getHistoricalStats(Number(days));
    
    res.json({
      success: true,
      history,
      count: history.length,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/analytics/check-outcomes
 * Manuálně zkontroluje outcomes pending signálů
 */
router.post('/check-outcomes', async (req, res) => {
  try {
    const result = await outcomeService.checkAllPendingSignals();
    
    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/analytics/signal/:id/outcome
 * Získá/spočítá outcome konkrétního signálu
 */
router.get('/signal/:id/outcome', async (req, res) => {
  try {
    const outcome = await outcomeService.checkSignalOutcome(req.params.id);
    
    if (!outcome) {
      return res.status(404).json({ success: false, error: 'Signal not found or no price data' });
    }
    
    res.json({
      success: true,
      outcome,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// BACKTESTING
// ============================================

/**
 * POST /api/analytics/backtest
 * Spustí nový backtest
 */
router.post('/backtest', async (req, res) => {
  try {
    const {
      name,
      description,
      startDate,
      endDate,
      signalTypes,
      minWalletScore,
      minWalletCount,
      minAiConfidence,
      positionSizePercent,
      maxPositionsOpen,
      stopLossPercent,
      takeProfitPercent,
      maxHoldTimeMinutes,
      initialCapitalUsd,
    } = req.body;

    if (!name || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'name, startDate, and endDate are required',
      });
    }

    const result = await backtestService.runBacktest({
      name,
      description,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      signalTypes,
      minWalletScore,
      minWalletCount,
      minAiConfidence,
      positionSizePercent,
      maxPositionsOpen,
      stopLossPercent,
      takeProfitPercent,
      maxHoldTimeMinutes,
      initialCapitalUsd,
    });

    res.json({
      success: true,
      result: {
        id: result.id,
        status: result.status,
        totalSignals: result.totalSignals,
        totalTrades: result.totalTrades,
        winRate: result.winRate,
        totalPnlPercent: result.totalPnlPercent,
        maxDrawdownPercent: result.maxDrawdownPercent,
        sharpeRatio: result.sharpeRatio,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/analytics/backtests
 * Získá seznam všech backtestů
 */
router.get('/backtests', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const runs = await backtestService.getBacktestRuns(Number(limit));
    
    res.json({
      success: true,
      backtests: runs,
      count: runs.length,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/analytics/backtest/:id
 * Získá detaily backtestu včetně trades
 */
router.get('/backtest/:id', async (req, res) => {
  try {
    const result = await backtestService.getBacktestDetails(req.params.id);
    
    if (!result) {
      return res.status(404).json({ success: false, error: 'Backtest not found' });
    }
    
    res.json({
      success: true,
      backtest: result,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// WALLET CORRELATIONS
// ============================================

/**
 * POST /api/analytics/correlations/analyze
 * Spustí analýzu korelací
 * DEPRECATED: Old correlation system - not used with new incremental WalletCorrelationService
 */
/*
router.post('/correlations/analyze', async (req, res) => {
  try {
    const result = await correlationService.analyzeAllCorrelations();

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
*/

/**
 * GET /api/analytics/correlations/groups
 * Získá detekované skupiny walletů
 * DEPRECATED: Old correlation system - not used with new incremental WalletCorrelationService
 */
/*
router.get('/correlations/groups', async (req, res) => {
  try {
    const groups = await correlationService.getGroups();

    res.json({
      success: true,
      groups,
      count: groups.length,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
*/

/**
 * GET /api/analytics/correlations/wallet/:id
 * Získá korelace pro konkrétní wallet
 * DEPRECATED: Old correlation system - not used with new incremental WalletCorrelationService
 */
/*
router.get('/correlations/wallet/:id', async (req, res) => {
  try {
    const correlations = await correlationService.getCorrelationsForWallet(req.params.id);

    res.json({
      success: true,
      correlations,
      count: correlations.length,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
*/

/**
 * POST /api/analytics/correlations/weighted-consensus
 * Spočítá weighted consensus score
 * DEPRECATED: Old correlation system - not used with new incremental WalletCorrelationService
 */
/*
router.post('/correlations/weighted-consensus', async (req, res) => {
  try {
    const { tokenId, walletIds } = req.body;

    if (!tokenId || !walletIds || !Array.isArray(walletIds)) {
      return res.status(400).json({
        success: false,
        error: 'tokenId and walletIds array are required',
      });
    }

    const result = await correlationService.getWeightedConsensusScore(tokenId, walletIds);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
*/

// ============================================
// TOKEN RISK
// ============================================

/**
 * GET /api/analytics/token-risk/:mintAddress
 * Analyzuje riziko tokenu
 */
router.get('/token-risk/:mintAddress', async (req, res) => {
  try {
    const { tokenId } = req.query;
    
    const analysis = await tokenRiskService.analyzeToken(
      (tokenId as string) || req.params.mintAddress,
      req.params.mintAddress
    );
    
    res.json({
      success: true,
      analysis,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// PRICE ALERTS
// ============================================

/**
 * GET /api/analytics/alerts
 * Získá aktivní price alerty
 */
router.get('/alerts', async (req, res) => {
  try {
    const { tokenId } = req.query;
    const alerts = await priceMonitor.getActiveAlerts(tokenId as string | undefined);
    
    res.json({
      success: true,
      alerts,
      count: alerts.length,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/analytics/alerts
 * Vytvoří nový price alert
 */
router.post('/alerts', async (req, res) => {
  try {
    const { signalId, tokenId, mintAddress, alertType, triggerPrice, entryPrice } = req.body;
    
    if (!tokenId || !mintAddress || !alertType || !triggerPrice) {
      return res.status(400).json({
        success: false,
        error: 'tokenId, mintAddress, alertType, and triggerPrice are required',
      });
    }
    
    const alert = await priceMonitor.createAlert({
      signalId,
      tokenId,
      mintAddress,
      alertType,
      triggerPrice,
      entryPrice,
    });
    
    if (!alert) {
      return res.status(500).json({ success: false, error: 'Failed to create alert' });
    }
    
    res.json({
      success: true,
      alert,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/analytics/alerts/check
 * Manuálně zkontroluje všechny alerty
 */
router.post('/alerts/check', async (req, res) => {
  try {
    const result = await priceMonitor.checkAllAlerts();
    
    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// NOTIFICATIONS
// ============================================

/**
 * POST /api/analytics/notifications/test
 * Odešle testovací notifikaci
 */
router.post('/notifications/test', async (req, res) => {
  try {
    const { channel = 'discord', message = 'Test notification from Tradooor' } = req.body;
    
    const success = await notificationService.send({
      type: 'signal',
      channel: channel as any,
      urgency: 'medium',
      title: '🧪 Test Notification',
      message,
    });
    
    res.json({
      success,
      message: success ? 'Notification sent' : 'Failed to send notification',
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

