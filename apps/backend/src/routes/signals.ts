import express from 'express';
import { SignalService } from '../services/signal.service.js';
import { SignalRepository } from '../repositories/signal.repository.js';
import { AdvancedSignalsService } from '../services/advanced-signals.service.js';
import { AIDecisionService } from '../services/ai-decision.service.js';
import { ConsensusSignalRepository } from '../repositories/consensus-signal.repository.js';
import { TokenMarketDataService } from '../services/token-market-data.service.js';
import { DiscordNotificationService } from '../services/discord-notification.service.js';
import { RugCheckService } from '../services/rugcheck.service.js';
import { SignalPerformanceService } from '../services/signal-performance.service.js';
import { signalFilter, ALL_ALLOWED_SIGNAL_TYPES } from '../services/signal-filter.service.js';
import { prisma } from '../lib/prisma.js';

const router = express.Router();
const signalService = new SignalService();
const signalRepo = new SignalRepository();
const advancedSignals = new AdvancedSignalsService();
const aiDecision = new AIDecisionService();
const consensusSignalRepo = new ConsensusSignalRepository();
const tokenMarketData = new TokenMarketDataService();
const discordNotification = new DiscordNotificationService();
const rugCheck = new RugCheckService();
const signalPerformance = new SignalPerformanceService();

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
              
              // Zkus načíst aktuální wallet data z DB (pro score) – Prisma
              let dbWallet: any = null;
              if (walletId) {
                try {
                  dbWallet = await prisma.smartWallet.findUnique({
                    where: { id: walletId },
                    select: {
                      address: true,
                      label: true,
                      score: true,
                      winRate: true,
                    },
                  });
                } catch {
                  dbWallet = null;
                }
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
            // Market data
            marketCapUsd: marketData?.marketCap,
            liquidityUsd: marketData?.liquidity,
            volume24hUsd: marketData?.volume24h,
            tokenAgeMinutes: marketData?.ageMinutes,
            
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

    const where: any = {};
    if (status) {
      where.status = status;
    } else {
      where.status = 'active';
    }
    if (type) {
      where.type = type;
    }
    if (walletId) {
      where.walletId = walletId;
    }
    if (tokenId) {
      where.tokenId = tokenId;
    }
    if (model) {
      where.model = model;
    }

    const take = limit ? Number(limit) : 50;

    const signals = await prisma.signal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        token: {
          select: {
            symbol: true,
            mintAddress: true,
          },
        },
        wallet: {
          select: {
            address: true,
            label: true,
            score: true,
          },
        },
      },
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
    const signal = await prisma.signal.findUnique({
      where: { id: req.params.id },
      include: {
        token: true,
        wallet: true,
      },
    });
    
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
    const signals = await prisma.signal.findMany({
      where: { model: 'consensus' },
      select: { id: true, tokenId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    if (signals && signals.length > 0) {
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
          const result = await prisma.signal.deleteMany({
            where: { id: { in: idsToDelete } },
          });
          deletedSignals += result.count;
        }
      }
    }

    // 2. Cleanup ConsensusSignal table duplicates
    const consensusSignals = await prisma.consensusSignal.findMany({
      select: { id: true, tokenId: true, latestTradeTime: true },
      orderBy: { latestTradeTime: 'desc' },
    });

    if (consensusSignals && consensusSignals.length > 0) {
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
          const result = await prisma.consensusSignal.deleteMany({
            where: { id: { in: idsToDelete } },
          });
          deletedConsensus += result.count;
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
    const duplicates = await prisma.signal.findMany({
      where: { model: 'consensus' },
      select: { tokenId: true },
    });

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
      const tokenSignals = await prisma.signal.findMany({
        where: {
          tokenId,
          model: 'consensus',
        },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });

      if (tokenSignals && tokenSignals.length > 1) {
        // Smaž všechny kromě nejnovějšího
        const idsToDelete = tokenSignals.slice(1).map((s: any) => s.id);
        
        const result = await prisma.signal.deleteMany({
          where: { id: { in: idsToDelete } },
        });

        deletedCount += result.count;
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
      const signalData = await prisma.signal.findUnique({
        where: { id: signalId },
        include: {
          wallet: true,
          token: true,
        },
      });

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
 * (Disabled in Prisma-only mode – AI fields are managed externally)
 */
router.post('/ai/reevaluate-all', async (_req, res) => {
  return res.status(501).json({
    success: false,
    message: 'AI re-evaluate-all is not implemented in Prisma-only mode.',
  });
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

// ============================================
// Signal Performance Endpoints
// ============================================

/**
 * GET /api/signals/performance/active
 * Získá aktivní signály s jejich performance daty
 */
router.get('/performance/active', async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const signalsWithPerformance = await signalPerformance.getSignalsWithPerformance({
      status: 'active',
      limit: Number(limit),
    });

    res.json({
      success: true,
      signals: signalsWithPerformance,
      count: signalsWithPerformance.length,
    });
  } catch (error: any) {
    console.error('❌ Error fetching active signal performances:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch signal performances',
    });
  }
});

/**
 * GET /api/signals/performance/analytics
 * Získá agregované analytics pro signály
 */
router.get('/performance/analytics', async (req, res) => {
  try {
    const { days = 7, tokenId } = req.query;

    const analytics = await signalPerformance.getAnalytics({
      days: Number(days),
      tokenId: tokenId as string | undefined,
    });

    res.json({
      success: true,
      analytics,
    });
  } catch (error: any) {
    console.error('❌ Error fetching signal analytics:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch signal analytics',
    });
  }
});

/**
 * GET /api/signals/:id/performance
 * Získá performance data pro konkrétní signál
 */
router.get('/:id/performance', async (req, res) => {
  try {
    const { id } = req.params;

    const performance = await signalPerformance.getPerformance(id);

    if (!performance) {
      return res.status(404).json({
        success: false,
        error: 'Signal performance record not found',
      });
    }

    res.json({
      success: true,
      performance,
    });
  } catch (error: any) {
    console.error('❌ Error fetching signal performance:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch signal performance',
    });
  }
});

/**
 * POST /api/signals/performance/update
 * Ručně spustit update všech aktivních signal performances
 */
router.post('/performance/update', async (req, res) => {
  try {
    const stats = await signalPerformance.updateAllActivePerformances();

    res.json({
      success: true,
      message: 'Signal performance update triggered',
      stats,
    });
  } catch (error: any) {
    console.error('❌ Error updating signal performances:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update signal performances',
    });
  }
});

// ============================================
// Advanced Analytics Endpoints for Dashboard
// ============================================

/**
 * GET /api/signals/analytics/dashboard
 * Získá všechna data pro Signals Analytics Dashboard
 */
router.get('/analytics/dashboard', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const daysNum = Number(days);
    const startDate = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000);

    // 1. Get signal performance analytics
    const analytics = await signalPerformance.getAnalytics({ days: daysNum });

    // 2. Get all signals with performance data for table
    const signalsWithPerf = await prisma.signalPerformance.findMany({
      where: {
        entryTimestamp: { gte: startDate },
      },
      orderBy: { entryTimestamp: 'desc' },
      take: 100,
      include: {
        signal: {
          include: {
            token: {
              select: { id: true, symbol: true, mintAddress: true },
            },
          },
        },
      },
    });

    // 3. AI accuracy - placeholder (AI decisions not stored in current schema)
    const aiAccuracy = {
      total: 0,
      buyCorrect: 0,
      buyWrong: 0,
      skipCorrect: 0,
      skipWrong: 0,
    };

    // 4. Format signals for table - apply centralized filter FIRST
    // This ensures winRateByType uses the same filtered data
    const signalsTable = signalsWithPerf
      .map(perf => {
        const signalType = (perf.signal?.meta as any)?.signalType || perf.signal?.model || 'unknown';
        const strength = (perf.signal?.meta as any)?.strength || 'medium';
        return {
          id: perf.id,
          signalId: perf.signalId,
          tokenId: perf.tokenId,
          tokenSymbol: perf.signal?.token?.symbol || 'Unknown',
          tokenMint: perf.signal?.token?.mintAddress || '',
          signalType,
          strength,
          entryPriceUsd: Number(perf.entryPriceUsd),
          entryTimestamp: perf.entryTimestamp,
          currentPriceUsd: Number(perf.currentPriceUsd) || null,
          highestPriceUsd: Number(perf.highestPriceUsd) || null,
          currentPnlPercent: Number(perf.currentPnlPercent) || null,
          maxPnlPercent: Number(perf.maxPnlPercent) || null,
          realizedPnlPercent: Number(perf.realizedPnlPercent) || null,
          missedPnlPercent: Number(perf.missedPnlPercent) || null,
          drawdownFromPeak: Number(perf.drawdownFromPeak) || null,
          timeToPeakMinutes: perf.timeToPeakMinutes,
          status: perf.status,
          exitReason: perf.exitReason,
          pnlSnapshots: perf.pnlSnapshots as Record<string, number> | null,
        };
      })
      // Apply centralized filter - same rules as Discord notifications
      .filter(s => signalFilter.filterSignals([s]).length > 0);

    // 5. Calculate missed gains summary - use filtered signals
    const closedSignals = signalsTable.filter(s => s.status === 'closed');
    const missedGains = {
      totalMissed: closedSignals.reduce((sum, p) => sum + (Number(p.missedPnlPercent) || 0), 0),
      avgMissed: closedSignals.length > 0
        ? closedSignals.reduce((sum, p) => sum + (Number(p.missedPnlPercent) || 0), 0) / closedSignals.length
        : 0,
      maxMissed: Math.max(...closedSignals.map(p => Number(p.missedPnlPercent) || 0), 0),
      signalsWithMissed50Plus: closedSignals.filter(p => (Number(p.missedPnlPercent) || 0) >= 50).length,
      signalsWithMissed100Plus: closedSignals.filter(p => (Number(p.missedPnlPercent) || 0) >= 100).length,
    };

    // 6. Get win rate by signal type - using FILTERED closed signals
    const signalsByType: Record<string, { total: number; wins: number; avgPnl: number; avgMissed: number }> = {};

    for (const signal of closedSignals) {
      const signalType = signal.signalType;
      if (!signalsByType[signalType]) {
        signalsByType[signalType] = { total: 0, wins: 0, avgPnl: 0, avgMissed: 0 };
      }

      signalsByType[signalType].total++;
      if ((signal.realizedPnlPercent || 0) > 0) {
        signalsByType[signalType].wins++;
      }
      signalsByType[signalType].avgPnl += signal.realizedPnlPercent || 0;
      signalsByType[signalType].avgMissed += signal.missedPnlPercent || 0;
    }

    // Calculate averages
    for (const type in signalsByType) {
      const data = signalsByType[type];
      if (data.total > 0) {
        data.avgPnl = data.avgPnl / data.total;
        data.avgMissed = data.avgMissed / data.total;
      }
    }

    res.json({
      success: true,
      analytics,
      signalsTable,
      aiAccuracy,
      winRateByType: signalsByType,
      missedGains,
      period: { days: daysNum, startDate, endDate: new Date() },
    });
  } catch (error: any) {
    console.error('❌ Error fetching analytics dashboard:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch analytics dashboard',
    });
  }
});

export default router;
