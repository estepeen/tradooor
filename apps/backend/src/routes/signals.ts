import express from 'express';
import { SignalService } from '../services/signal.service.js';
import { SignalRepository } from '../repositories/signal.repository.js';
import { AdvancedSignalsService } from '../services/advanced-signals.service.js';
import { AIDecisionService } from '../services/ai-decision.service.js';
import { ConsensusSignalRepository } from '../repositories/consensus-signal.repository.js';
import { TokenMarketDataService } from '../services/token-market-data.service.js';
import { DiscordNotificationService } from '../services/discord-notification.service.js';
import { RugCheckService } from '../services/rugcheck.service.js';
import { supabase, TABLES } from '../lib/supabase.js';

const router = express.Router();
const signalService = new SignalService();
const signalRepo = new SignalRepository();
const advancedSignals = new AdvancedSignalsService();
const aiDecision = new AIDecisionService();
const consensusSignalRepo = new ConsensusSignalRepository();
const tokenMarketData = new TokenMarketDataService();
const discordNotification = new DiscordNotificationService();
const rugCheck = new RugCheckService();

/**
 * GET /api/signals/unified
 * Unified signály - agregované a deduplikované pro trading
 * Kombinuje ConsensusSignal (primární zdroj) s AI evaluacemi
 */
router.get('/unified', async (req, res) => {
  try {
    const { limit = 50, hours = 48 } = req.query;
    
    // 1. Načti ConsensusSignals (jsou už deduplikované per-token)
    const consensusSignals = await consensusSignalRepo.findAll(Number(limit));
    
    // 2. Pro každý consensus signal vybuduj unified strukturu
    const unifiedSignals = await Promise.all(
      consensusSignals.map(async (cs: any) => {
        try {
          const token = cs.token || {};
          const trades = cs.trades || [];
          
          // Aggreguj info o walletech z trades
          // trades array má strukturu: {id, wallet: {id, address, label}, amountBase, priceBasePerToken, timestamp}
          const wallets = await Promise.all(
            trades.map(async (t: any) => {
              // Wallet může být uložen jako nested objekt nebo jako walletId
              const walletData = t.wallet || {};
              const walletId = walletData.id || t.walletId;
              
              // Zkus načíst aktuální wallet data z DB (pro score)
              let dbWallet: any = null;
              if (walletId) {
                const { data } = await supabase
                  .from(TABLES.SMART_WALLET)
                  .select('address, label, score, winRate')
                  .eq('id', walletId)
                  .single();
                dbWallet = data;
              }
              
              return {
                address: dbWallet?.address || walletData.address || 'Unknown',
                label: dbWallet?.label || walletData.label || null,
                score: dbWallet?.score || 0,
                winRate: dbWallet?.winRate || 0,
                tradePrice: Number(t.priceBasePerToken || 0),
                tradeAmount: Number(t.amountBase || 0),
                tradeTime: t.timestamp,
              };
            })
          );
          
          // Spočítej průměrné score
          const avgWalletScore = wallets.length > 0 
            ? wallets.reduce((sum, w) => sum + (w.score || 0), 0) / wallets.length 
            : 0;
          
          // Seřaď wallety podle času trade
          const sortedWallets = [...wallets].sort((a, b) => 
            new Date(a.tradeTime).getTime() - new Date(b.tradeTime).getTime()
          );
          
          // Entry price = cena DRUHÉHO nákupu (kdy vzniká consensus)
          // Pokud je jen 1 wallet, použij jeho cenu
          const consensusTrade = sortedWallets.length >= 2 ? sortedWallets[1] : sortedWallets[0];
          const entryPriceUsd = consensusTrade?.tradePrice || 0;
          
          // Zkus načíst aktuální market data
          let marketData: any = null;
          if (token.mintAddress) {
            try {
              marketData = await tokenMarketData.getMarketData(token.mintAddress);
            } catch (e) {
              // Market data není kritická
            }
          }
          
          // Zkus načíst AI decision z Signal tabulky (pokud existuje)
          const { data: relatedSignal } = await supabase
            .from(TABLES.SIGNAL)
            .select('*')
            .eq('tokenId', cs.tokenId)
            .eq('model', 'consensus')
            .order('createdAt', { ascending: false })
            .limit(1)
            .single();
          
          // Načti security data z RugCheck
          let securityData: any = null;
          if (token.mintAddress) {
            try {
              const rugReport = await rugCheck.getReport(token.mintAddress);
              if (rugReport) {
                securityData = {
                  riskLevel: rugReport.riskLevel,
                  riskScore: rugReport.riskScore,
                  isLpLocked: rugReport.isLpLocked,
                  lpLockedPercent: rugReport.lpLockedPercent,
                  isDexPaid: rugReport.isDexPaid,
                  isMintable: rugReport.isMintable,
                  isFreezable: rugReport.isFreezable,
                  isHoneypot: rugReport.isHoneypot,
                  honeypotReason: rugReport.honeypotReason,
                  buyTax: rugReport.buyTax,
                  sellTax: rugReport.sellTax,
                  hasDangerousTax: rugReport.hasDangerousTax,
                  risks: rugReport.risks,
                };
              }
            } catch (e) {
              // RugCheck není kritický
            }
          }
          
          // Spočítej price change
          const currentPrice = marketData?.price || 0;
          const priceChangePercent = entryPriceUsd > 0 && currentPrice > 0
            ? ((currentPrice - entryPriceUsd) / entryPriceUsd) * 100
            : undefined;
          
          // Urči strength na základě wallet count a scores
          let strength: 'weak' | 'medium' | 'strong' = 'medium';
          if (cs.walletCount >= 3 && avgWalletScore >= 70) strength = 'strong';
          else if (cs.walletCount === 2 && avgWalletScore < 50) strength = 'weak';
          
          // Urči risk level
          let riskLevel: 'low' | 'medium' | 'high' = 'medium';
          if (cs.walletCount >= 3 && avgWalletScore >= 70) riskLevel = 'low';
          else if (cs.walletCount === 2 && avgWalletScore < 50) riskLevel = 'high';
          
          return {
            id: cs.id,
            tokenId: cs.tokenId,
            tokenSymbol: token.symbol || 'Unknown',
            tokenMint: token.mintAddress || '',
            type: 'buy' as const,
            signalType: 'consensus',
            strength,
            
            // Traders info
            walletCount: cs.walletCount || wallets.length,
            wallets: wallets.slice(0, 5), // Max 5 pro UI
            avgWalletScore: Math.round(avgWalletScore),
            
            // Prices
            entryPriceUsd,
            currentPriceUsd: currentPrice || undefined,
            priceChangePercent,
            stopLossPrice: relatedSignal?.stopLossPriceUsd ? Number(relatedSignal.stopLossPriceUsd) : undefined,
            takeProfitPrice: relatedSignal?.takeProfitPriceUsd ? Number(relatedSignal.takeProfitPriceUsd) : undefined,
            
            // Market data
            marketCapUsd: marketData?.marketCap,
            liquidityUsd: marketData?.liquidity,
            volume24hUsd: marketData?.volume24h,
            tokenAgeMinutes: marketData?.ageMinutes,
            
            // AI Decision (z relatedSignal pokud existuje)
            aiDecision: relatedSignal?.aiDecision as any,
            aiConfidence: relatedSignal?.aiConfidence ? Number(relatedSignal.aiConfidence) : undefined,
            aiReasoning: relatedSignal?.aiReasoning,
            aiPositionPercent: relatedSignal?.aiSuggestedPositionPercent ? Number(relatedSignal.aiSuggestedPositionPercent) : undefined,
            aiStopLossPercent: relatedSignal?.aiStopLossPercent ? Number(relatedSignal.aiStopLossPercent) : undefined,
            aiTakeProfitPercent: relatedSignal?.aiTakeProfitPercent ? Number(relatedSignal.aiTakeProfitPercent) : undefined,
            aiRiskScore: relatedSignal?.aiRiskScore ? Number(relatedSignal.aiRiskScore) : undefined,
            
            // Status
            status: 'active' as const,
            qualityScore: Math.round(avgWalletScore * 0.5 + cs.walletCount * 15),
            riskLevel,
            
            // Security (RugCheck)
            security: securityData,
            
            // Timestamps
            firstTradeTime: cs.firstTradeTime,
            latestTradeTime: cs.latestTradeTime,
            createdAt: cs.createdAt || cs.firstTradeTime,
            expiresAt: undefined,
          };
        } catch (err) {
          console.warn(`Error processing consensus signal ${cs.id}:`, err);
          return null;
        }
      })
    );
    
    // Filter out nulls and sort by latest trade time
    const validSignals = unifiedSignals
      .filter(s => s !== null)
      .sort((a, b) => new Date(b!.latestTradeTime).getTime() - new Date(a!.latestTradeTime).getTime());
    
    res.json({
      success: true,
      signals: validSignals,
      count: validSignals.length,
      source: 'consensus',
    });
  } catch (error: any) {
    console.error('❌ Error fetching unified signals:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch unified signals',
    });
  }
});

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

/**
 * POST /api/signals/cleanup-all-duplicates
 * Smaže duplicity z obou tabulek - Signal i ConsensusSignal
 */
router.post('/cleanup-all-duplicates', async (req, res) => {
  try {
    let deletedSignals = 0;
    let deletedConsensus = 0;

    // 1. Cleanup Signal table duplicates
    const { data: signals } = await supabase
      .from(TABLES.SIGNAL)
      .select('id, tokenId, createdAt')
      .eq('model', 'consensus')
      .order('createdAt', { ascending: false });

    if (signals) {
      const tokenMap = new Map<string, string[]>();
      signals.forEach((s: any) => {
        const ids = tokenMap.get(s.tokenId) || [];
        ids.push(s.id);
        tokenMap.set(s.tokenId, ids);
      });

      for (const [tokenId, ids] of tokenMap.entries()) {
        if (ids.length > 1) {
          // Keep only the first (newest), delete rest
          const idsToDelete = ids.slice(1);
          const { error } = await supabase
            .from(TABLES.SIGNAL)
            .delete()
            .in('id', idsToDelete);
          if (!error) deletedSignals += idsToDelete.length;
        }
      }
    }

    // 2. Cleanup ConsensusSignal table duplicates
    const { data: consensusSignals } = await supabase
      .from(TABLES.CONSENSUS_SIGNAL)
      .select('id, tokenId, latestTradeTime')
      .order('latestTradeTime', { ascending: false });

    if (consensusSignals) {
      const tokenMap = new Map<string, string[]>();
      consensusSignals.forEach((s: any) => {
        const ids = tokenMap.get(s.tokenId) || [];
        ids.push(s.id);
        tokenMap.set(s.tokenId, ids);
      });

      for (const [tokenId, ids] of tokenMap.entries()) {
        if (ids.length > 1) {
          // Keep only the first (newest), delete rest
          const idsToDelete = ids.slice(1);
          const { error } = await supabase
            .from(TABLES.CONSENSUS_SIGNAL)
            .delete()
            .in('id', idsToDelete);
          if (!error) deletedConsensus += idsToDelete.length;
        }
      }
    }

    console.log(`🧹 Cleanup: Deleted ${deletedSignals} Signal duplicates, ${deletedConsensus} ConsensusSignal duplicates`);

    res.json({
      success: true,
      message: `Cleaned up ${deletedSignals + deletedConsensus} total duplicates`,
      deletedSignals,
      deletedConsensus,
    });
  } catch (error: any) {
    console.error('❌ Error cleaning up all duplicates:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clean up duplicates',
    });
  }
});

/**
 * POST /api/signals/cleanup-duplicates
 * Smaže duplicitní signály - ponechá pouze jeden per token
 */
router.post('/cleanup-duplicates', async (req, res) => {
  try {
    // 1. Najdi duplicitní tokeny
    const { data: duplicates, error: findError } = await supabase
      .from(TABLES.SIGNAL)
      .select('tokenId')
      .eq('model', 'consensus');

    if (findError) {
      throw new Error(`Failed to find signals: ${findError.message}`);
    }

    // Spočítej duplicity
    const tokenCounts: Record<string, number> = {};
    (duplicates || []).forEach((s: any) => {
      tokenCounts[s.tokenId] = (tokenCounts[s.tokenId] || 0) + 1;
    });

    const duplicateTokens = Object.entries(tokenCounts)
      .filter(([_, count]) => count > 1)
      .map(([tokenId, count]) => ({ tokenId, count }));

    if (duplicateTokens.length === 0) {
      return res.json({
        success: true,
        message: 'No duplicates found',
        deleted: 0,
      });
    }

    // 2. Pro každý token s duplicitami ponech jen nejnovější
    let deletedCount = 0;
    for (const { tokenId } of duplicateTokens) {
      // Najdi všechny signály pro token
      const { data: tokenSignals } = await supabase
        .from(TABLES.SIGNAL)
        .select('id, createdAt')
        .eq('tokenId', tokenId)
        .eq('model', 'consensus')
        .order('createdAt', { ascending: false });

      if (tokenSignals && tokenSignals.length > 1) {
        // Smaž všechny kromě nejnovějšího
        const idsToDelete = tokenSignals.slice(1).map((s: any) => s.id);
        
        const { error: deleteError } = await supabase
          .from(TABLES.SIGNAL)
          .delete()
          .in('id', idsToDelete);

        if (!deleteError) {
          deletedCount += idsToDelete.length;
        }
      }
    }

    console.log(`🧹 Cleaned up ${deletedCount} duplicate signals`);

    res.json({
      success: true,
      message: `Cleaned up ${deletedCount} duplicate signals`,
      deleted: deletedCount,
      duplicateTokens: duplicateTokens.length,
    });
  } catch (error: any) {
    console.error('❌ Error cleaning up duplicates:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clean up duplicates',
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
 * POST /api/signals/ai/reevaluate-all
 * Re-evaluuje všechny active signály bez AI decision
 */
router.post('/ai/reevaluate-all', async (req, res) => {
  try {
    // Najdi všechny active signály bez AI decision
    const { data: signalsToEvaluate, error } = await supabase
      .from(TABLES.SIGNAL)
      .select(`
        *,
        token:Token(*),
        wallet:SmartWallet(*)
      `)
      .eq('status', 'active')
      .is('aiDecision', null)
      .order('createdAt', { ascending: false })
      .limit(20);

    if (error) {
      throw new Error(`Failed to fetch signals: ${error.message}`);
    }

    if (!signalsToEvaluate || signalsToEvaluate.length === 0) {
      return res.json({
        success: true,
        message: 'No signals to evaluate',
        evaluated: 0,
      });
    }

    console.log(`🤖 Re-evaluating ${signalsToEvaluate.length} signals with AI...`);

    let evaluatedCount = 0;
    const results = [];

    for (const signal of signalsToEvaluate) {
      try {
        // Načti market data
        let marketData: any = null;
        if (signal.token?.mintAddress) {
          try {
            marketData = await tokenMarketData.getMarketData(signal.token.mintAddress);
          } catch (e) {
            // ignoruj
          }
        }

        // Vytvoř context (must match SignalContext interface)
        const context = {
          // Required fields
          walletScore: signal.wallet?.score || 50,
          walletWinRate: signal.wallet?.winRate || 0.5,
          walletRecentPnl30d: 0, // Not available in this context
          // Optional fields  
          walletTotalTrades: 100,
          walletAvgHoldTimeMin: 60,
          tokenAge: marketData?.ageMinutes || 0,
          tokenSymbol: signal.token?.symbol || 'Unknown',
          tokenMint: signal.token?.mintAddress,
          tokenLiquidity: marketData?.liquidity || 0,
          tokenVolume24h: marketData?.volume24h || 0,
          tokenMarketCap: marketData?.marketCap || 0,
          consensusWalletCount: (signal.meta as any)?.walletCount || 1,
          entryPriceUsd: Number(signal.priceBasePerToken || 0),
        };

        // Vytvoř signál pro AI
        const walletCount = (signal.meta as any)?.walletCount || 1;
        const signalForAI = {
          type: (signal.model || 'consensus') as 'consensus' | 'whale-entry' | 'early-sniper' | 'momentum' | 're-entry' | 'exit-warning' | 'hot-token' | 'accumulation',
          strength: (walletCount >= 3 ? 'strong' : 'medium') as 'weak' | 'medium' | 'strong',
          confidence: signal.qualityScore || 50,
          reasoning: signal.reasoning || '',
          suggestedAction: signal.type as 'buy' | 'sell',
          riskLevel: (signal.riskLevel || 'medium') as 'low' | 'medium' | 'high',
          context,
        };

        // Zavolej AI
        const decision = await aiDecision.evaluateSignal(signalForAI, context);
        
        if (decision) {
          // Aktualizuj signal
          const entryPrice = Number(signal.priceBasePerToken || 0);
          const stopLossPrice = entryPrice > 0 && decision.stopLossPercent
            ? entryPrice * (1 - decision.stopLossPercent / 100)
            : null;
          const takeProfitPrice = entryPrice > 0 && decision.takeProfitPercent
            ? entryPrice * (1 + decision.takeProfitPercent / 100)
            : null;

          await supabase
            .from(TABLES.SIGNAL)
            .update({
              aiDecision: decision.decision,
              aiConfidence: decision.confidence,
              aiReasoning: decision.reasoning,
              aiSuggestedPositionPercent: decision.suggestedPositionPercent,
              aiStopLossPercent: decision.stopLossPercent,
              aiTakeProfitPercent: decision.takeProfitPercent,
              aiRiskScore: decision.riskScore,
              entryPriceUsd: entryPrice,
              stopLossPriceUsd: stopLossPrice,
              takeProfitPriceUsd: takeProfitPrice,
              suggestedHoldTimeMinutes: decision.expectedHoldTimeMinutes,
              tokenMarketCapUsd: marketData?.marketCap,
              tokenLiquidityUsd: marketData?.liquidity,
              tokenVolume24hUsd: marketData?.volume24h,
              tokenAgeMinutes: marketData?.ageMinutes,
              updatedAt: new Date().toISOString(),
            })
            .eq('id', signal.id);

          evaluatedCount++;
          results.push({
            signalId: signal.id,
            token: signal.token?.symbol,
            decision: decision.decision,
            confidence: decision.confidence,
          });

          console.log(`   ✅ ${signal.token?.symbol}: ${decision.decision} (${decision.confidence}%)`);
        }

        // Rate limiting - čekej 500ms mezi voláními
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (signalError: any) {
        console.warn(`   ⚠️  Failed to evaluate signal ${signal.id}: ${signalError.message}`);
      }
    }

    res.json({
      success: true,
      message: `Re-evaluated ${evaluatedCount}/${signalsToEvaluate.length} signals`,
      evaluated: evaluatedCount,
      results,
    });
  } catch (error: any) {
    console.error('❌ Error re-evaluating signals:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to re-evaluate signals',
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

// ============================================
// Discord Notification Endpoints
// ============================================

/**
 * POST /api/signals/discord/test
 * Pošle testovací Discord notifikaci
 */
router.post('/discord/test', async (req, res) => {
  try {
    const success = await discordNotification.sendTestNotification();
    
    if (success) {
      res.json({
        success: true,
        message: 'Test notification sent to Discord',
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to send Discord notification. Check DISCORD_WEBHOOK_URL in .env',
      });
    }
  } catch (error: any) {
    console.error('❌ Error sending Discord test notification:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send Discord test notification',
    });
  }
});

export default router;
