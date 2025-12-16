import express from 'express';
import { SignalService } from '../services/signal.service.js';
import { SignalRepository } from '../repositories/signal.repository.js';
import { AdvancedSignalsService } from '../services/advanced-signals.service.js';
import { AIDecisionService } from '../services/ai-decision.service.js';
import { supabase, TABLES } from '../lib/supabase.js';

const router = express.Router();
const signalService = new SignalService();
const signalRepo = new SignalRepository();
const advancedSignals = new AdvancedSignalsService();
const aiDecision = new AIDecisionService();

/**
 * GET /api/signals
 * Získá aktivní signály s rozšířenými filtry
 */
router.get('/', async (req, res) => {
  try {
    const { type, walletId, tokenId, model, limit, status } = req.query;
    
    // Pro rozšířené filtry použij přímý dotaz
    let query = supabase
      .from('Signal')
      .select(`
        *,
        token:Token(symbol, mintAddress),
        wallet:SmartWallet(address, label, score)
      `)
      .order('createdAt', { ascending: false });

    // Filtry
    if (status) {
      query = query.eq('status', status);
    } else {
      query = query.eq('status', 'active');
    }
    
    if (type) {
      query = query.eq('type', type);
    }
    if (walletId) {
      query = query.eq('walletId', walletId);
    }
    if (tokenId) {
      query = query.eq('tokenId', tokenId);
    }
    if (model) {
      query = query.eq('model', model);
    }
    if (limit) {
      query = query.limit(Number(limit));
    } else {
      query = query.limit(50);
    }

    const { data: signals, error } = await query;

    if (error) {
      throw new Error(error.message);
    }

    res.json({
      success: true,
      signals: signals || [],
      count: signals?.length || 0,
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
 * GET /api/signals/summary
 * Vrátí shrnutí aktivních signálů
 */
router.get('/summary', async (req, res) => {
  try {
    const summary = await advancedSignals.getActiveSignalsSummary();
    
    res.json({
      success: true,
      summary,
    });
  } catch (error: any) {
    console.error('❌ Error fetching signals summary:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch signals summary',
    });
  }
});

/**
 * GET /api/signals/types
 * Vrátí dostupné typy signálů
 */
router.get('/types', async (req, res) => {
  res.json({
    success: true,
    types: [
      { id: 'consensus', name: 'Consensus', description: '2+ wallets koupilo stejný token' },
      { id: 'whale-entry', name: 'Whale Entry', description: 'Top trader nakoupil velkou pozici' },
      { id: 'early-sniper', name: 'Early Sniper', description: 'Smart wallet jako první koupila nový token' },
      { id: 'momentum', name: 'Momentum', description: 'Price/volume spike + smart wallet entry' },
      { id: 're-entry', name: 'Re-entry', description: 'Wallet se vrací k profitabilnímu tokenu' },
      { id: 'hot-token', name: 'Hot Token', description: '3+ kvalitních wallets koupilo token' },
      { id: 'accumulation', name: 'Accumulation', description: 'Wallet akumuluje pozici' },
      { id: 'exit-warning', name: 'Exit Warning', description: 'Více wallets prodává token' },
      { id: 'smart-copy', name: 'Smart Copy', description: 'Základní kopírování kvalitní wallet' },
    ],
  });
});

/**
 * GET /api/signals/:id
 * Získá konkrétní signál s detaily
 */
router.get('/:id', async (req, res) => {
  try {
    const { data: signal, error } = await supabase
      .from('Signal')
      .select(`
        *,
        token:Token(*),
        wallet:SmartWallet(*)
      `)
      .eq('id', req.params.id)
      .single();
    
    if (error || !signal) {
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
 * POST /api/signals/analyze
 * Analyzuje trade a vrátí všechny detekované signály
 */
router.post('/analyze', async (req, res) => {
  try {
    const { tradeId } = req.body;
    
    if (!tradeId) {
      return res.status(400).json({
        success: false,
        error: 'tradeId is required',
      });
    }

    const signals = await advancedSignals.analyzeTradeForSignals(tradeId);
    
    res.json({
      success: true,
      signals,
      count: signals.length,
    });
  } catch (error: any) {
    console.error('❌ Error analyzing trade:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to analyze trade',
    });
  }
});

/**
 * POST /api/signals/process
 * Zpracuje trade, detekuje signály a uloží je
 */
router.post('/process', async (req, res) => {
  try {
    const { tradeId } = req.body;
    
    if (!tradeId) {
      return res.status(400).json({
        success: false,
        error: 'tradeId is required',
      });
    }

    const result = await advancedSignals.processTradeForSignals(tradeId);
    
    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('❌ Error processing trade for signals:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process trade for signals',
    });
  }
});

/**
 * POST /api/signals/generate
 * Vygeneruje signál z trade (původní endpoint)
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

// ============================================
// AI Decision Endpoints
// ============================================

/**
 * POST /api/signals/ai/evaluate
 * Evaluuje signál pomocí AI
 */
router.post('/ai/evaluate', async (req, res) => {
  try {
    const { signalId, tradeId, config } = req.body;
    
    if (!signalId && !tradeId) {
      return res.status(400).json({
        success: false,
        error: 'signalId or tradeId is required',
      });
    }

    let signalsToEvaluate: any[] = [];

    if (tradeId) {
      // Analyzuj trade a získej signály
      signalsToEvaluate = await advancedSignals.analyzeTradeForSignals(tradeId);
    } else if (signalId) {
      // Načti signál z DB
      const { data: signalData } = await supabase
        .from('Signal')
        .select(`
          *,
          wallet:SmartWallet(*),
          token:Token(*)
        `)
        .eq('id', signalId)
        .single();

      if (signalData) {
        signalsToEvaluate = [{
          type: (signalData.meta as any)?.signalType || signalData.model,
          strength: (signalData.meta as any)?.strength || 'medium',
          confidence: signalData.qualityScore || 50,
          reasoning: signalData.reasoning || '',
          suggestedAction: signalData.type as 'buy' | 'sell',
          riskLevel: signalData.riskLevel || 'medium',
          context: (signalData.meta as any)?.context || {},
        }];
      }
    }

    if (signalsToEvaluate.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No signals found to evaluate',
      });
    }

    // Evaluuj každý signál pomocí AI
    const aiDecisionService = new AIDecisionService(config);
    const decisions = [];

    for (const signal of signalsToEvaluate) {
      // Sestavit context pro AI
      const aiContext = {
        signal,
        signalType: signal.type,
        walletScore: signal.context?.walletScore || 50,
        walletWinRate: signal.context?.walletWinRate || 0.5,
        walletRecentPnl30d: signal.context?.walletRecentPnl30d || 0,
        walletTotalTrades: 100,
        walletAvgHoldTimeMin: 60,
        tokenSymbol: signal.context?.tokenSymbol,
        tokenAge: signal.context?.tokenAge || 60,
        tokenLiquidity: signal.context?.tokenLiquidity,
        tokenVolume24h: signal.context?.tokenVolume24h,
        otherWalletsCount: signal.context?.consensusWalletCount,
        consensusStrength: signal.strength,
      };

      const decision = await aiDecisionService.evaluateSignal(signal, aiContext);
      decisions.push({
        signal,
        decision,
      });
    }
    
    res.json({
      success: true,
      evaluations: decisions,
      count: decisions.length,
    });
  } catch (error: any) {
    console.error('❌ Error evaluating signal with AI:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to evaluate signal with AI',
    });
  }
});

/**
 * GET /api/signals/ai/history
 * Získá historii AI rozhodnutí
 */
router.get('/ai/history', async (req, res) => {
  try {
    const { tokenId, walletId, decision, limit } = req.query;
    
    const history = await aiDecision.getDecisionHistory({
      tokenId: tokenId as string,
      walletId: walletId as string,
      decision: decision as 'buy' | 'sell' | 'hold' | 'skip',
      limit: limit ? Number(limit) : 50,
    });
    
    res.json({
      success: true,
      decisions: history,
      count: history.length,
    });
  } catch (error: any) {
    console.error('❌ Error fetching AI decision history:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch AI decision history',
    });
  }
});

/**
 * GET /api/signals/ai/performance
 * Získá performance statistiky AI
 */
router.get('/ai/performance', async (req, res) => {
  try {
    const performance = await aiDecision.analyzePerformance();
    
    res.json({
      success: true,
      performance,
    });
  } catch (error: any) {
    console.error('❌ Error fetching AI performance:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch AI performance',
    });
  }
});

export default router;
