/**
 * Advanced Signals Service
 *
 * ACTIVE SIGNAL TYPES (Core Signals Only):
 * - 💪 Conviction Buy: Trader nakupuje 2-5x+ více než obvykle (STRONG/MEDIUM/EXTREME tiers)
 * - 📈 Accumulation: Wallet postupně akumuluje pozici přes čas (2-4+ nákupy)
 * - 🚨 Exit Warning: 2-3+ smart wallets prodává stejný token (CRITICAL/WARNING tiers)
 *
 * CONSENSUS signals are handled separately in consensus-webhook.service.ts
 *
 * DEPRECATED (not actively used):
 * - Whale Entry, Early Sniper, Momentum, Re-entry, Hot Token, Volume Spike
 * These detectors remain in code for potential future use but are not called.
 */

import { SignalRepository, SignalRecord } from '../repositories/signal.repository.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { TradeFeatureRepository } from '../repositories/trade-feature.repository.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';
import { TokenMarketDataService } from './token-market-data.service.js';
import { AIDecisionService, AIContext, AIDecision } from './ai-decision.service.js';
import { DiscordNotificationService, SignalNotificationData } from './discord-notification.service.js';
import { SolPriceCacheService } from './sol-price-cache.service.js';
import { prisma } from '../lib/prisma.js';

// Signal type definitions - Core signals + deprecated (for backward compatibility)
export type AdvancedSignalType =
  | 'accumulation'      // Wallet gradually accumulates position over time
  | 'consensus'         // 2+ wallets bought same token within time window
  | 'conviction-buy'    // Trader buys significantly larger than average
  | 'exit-warning'      // 2+ wallets selling same token (warning signal)
  | 'consensus-update'  // New wallet joined existing consensus
  // Deprecated types (not actively used, kept for backward compatibility)
  | 'whale-entry' | 'early-sniper' | 'momentum' | 're-entry' | 'hot-token' | 'volume-spike' | 'large-position';

export interface SignalContext {
  walletScore: number;
  walletWinRate: number;
  walletRecentPnl30d: number;
  walletTotalTrades?: number;
  walletAvgHoldTimeMin?: number;
  tokenAge: number; // minutes since first trade
  tokenSymbol?: string;
  tokenMint?: string;
  tokenLiquidity?: number;
  tokenVolume24h?: number;
  tokenMarketCap?: number;
  tokenHolders?: number;
  consensusWalletCount?: number;
  previousPnlOnToken?: number; // For re-entry signals
  positionSizeUsd?: number;
  walletAvgPositionUsd?: number;
  entryPriceUsd?: number;
}

export interface AdvancedSignal {
  type: AdvancedSignalType;
  strength: 'weak' | 'medium' | 'strong';
  confidence: number; // 0-100
  reasoning: string;
  context: SignalContext;
  suggestedAction: 'buy' | 'sell' | 'hold' | 'watch';
  suggestedPositionPercent?: number;
  riskLevel: 'low' | 'medium' | 'high';
  // Enhanced fields for trading bot
  entryPriceUsd?: number;
  suggestedExitPriceUsd?: number;
  stopLossPriceUsd?: number;
  takeProfitPriceUsd?: number;
  suggestedHoldTimeMinutes?: number;
  // AI decision (filled after AI evaluation)
  aiDecision?: AIDecision;
}

// Tier system for signal strength classification
const SIGNAL_TIERS = {
  CONSENSUS: {
    STRONG: {
      minWallets: 3,
      minAvgScore: 70,
      timeWindowHours: 1,
      positionSizePercent: [15, 20],
    },
    MEDIUM: {
      minWallets: 2,
      minAvgScore: 65,
      timeWindowHours: 2,
      positionSizePercent: [10, 15],
    },
    WEAK: {
      minWallets: 2,
      minAvgScore: 55,
      timeWindowHours: 4,
      positionSizePercent: [5, 10],
    },
  },
  ACCUMULATION: {
    STRONG: {
      minBuys: 4,
      timeWindowHours: 24,
      minSizePerBuy: 0.5,      // SOL
      minTotalSize: 2.5,       // SOL total
      minWalletScore: 70,
      positionSizePercent: [10, 15],
    },
    MEDIUM: {
      minBuys: 3,
      timeWindowHours: 18,
      minSizePerBuy: 0.3,
      minTotalSize: 1.5,
      minWalletScore: 60,
      positionSizePercent: [7, 12],
    },
    WEAK: {
      minBuys: 2,
      timeWindowHours: 12,
      minSizePerBuy: 0.3,
      minTotalSize: 0.8,
      minWalletScore: 55,
      positionSizePercent: [5, 8],
    },
  },
  CONVICTION: {
    EXTREME: {
      multiplier: 5,           // 5x+ average
      minWalletScore: 75,
      minAbsoluteSize: 5,      // SOL minimum absolute size
      positionSizePercent: [20, 25],
    },
    STRONG: {
      multiplier: 3,
      minWalletScore: 70,
      minAbsoluteSize: 2,
      positionSizePercent: [15, 20],
    },
    MEDIUM: {
      multiplier: 2,
      minWalletScore: 65,
      minAbsoluteSize: 1,
      positionSizePercent: [10, 15],
    },
  },
  EXIT_WARNING: {
    CRITICAL: {
      minWallets: 3,
      timeWindowHours: 2,
      minAvgScore: 70,
      action: 'SELL_IMMEDIATELY',
    },
    WARNING: {
      minWallets: 2,
      timeWindowHours: 4,
      minAvgScore: 65,
      action: 'REDUCE_POSITION_50',
    },
  },
};

// Legacy thresholds (kept for backward compatibility with deprecated detectors)
const THRESHOLDS = {
  EXIT_WARNING_MIN_SELLERS: 2,
  ACCUMULATION_MIN_BUYS: 2,
  ACCUMULATION_TIME_WINDOW_HOURS: 12,
  CONVICTION_BUY_MULTIPLIER: 2,
  CONVICTION_MIN_WALLET_SCORE: 65,
  CONVICTION_MIN_ABSOLUTE_SIZE: 1,  // Minimum 1 SOL absolute size
  // Deprecated detector thresholds (not actively used)
  WHALE_MIN_SCORE: 70,
  WHALE_MIN_POSITION_MULTIPLIER: 1.5,
  EARLY_SNIPER_MAX_TOKEN_AGE_MINUTES: 60,
  EARLY_SNIPER_MIN_WALLET_SCORE: 55,
  MOMENTUM_MIN_PRICE_CHANGE_5M: 5,
  MOMENTUM_MIN_VOLUME_SPIKE: 2,
  REENTRY_MIN_PREVIOUS_PNL: 10,
  HOT_TOKEN_MIN_WALLETS: 3,
  HOT_TOKEN_MIN_AVG_SCORE: 60,
  VOLUME_SPIKE_MULTIPLIER: 5,
  VOLUME_SPIKE_MIN_USD: 50000,
};

interface PendingAccumulationSignal {
  tokenId: string;
  walletId: string;
  tokenSymbol: string;
  tokenMint: string;
  wallet: any;
  token: any;
  baseToken: string;
  marketData: { marketCap: number | null; liquidity: number | null; volume24h: number | null; tokenAgeMinutes: number | null };
  signal: AdvancedSignal;
  firstTradeTime: Date;
  lastTradeTime: Date;
  timeoutId?: NodeJS.Timeout;
}

export class AdvancedSignalsService {
  private signalRepo: SignalRepository;
  private smartWalletRepo: SmartWalletRepository;
  private tradeRepo: TradeRepository;
  private tokenRepo: TokenRepository;
  private tradeFeatureRepo: TradeFeatureRepository;
  private closedLotRepo: ClosedLotRepository;
  private tokenMarketData: TokenMarketDataService;
  private aiDecision: AIDecisionService;
  private discordNotification: DiscordNotificationService;
  private solPriceCacheService: SolPriceCacheService;
  
  // Cache pro seskupování accumulation signálů (key: tokenId-walletId)
  private pendingAccumulationSignals: Map<string, PendingAccumulationSignal> = new Map();
  private readonly ACCUMULATION_GROUP_WINDOW_MS = 60 * 1000; // 1 minuta

  constructor() {
    this.signalRepo = new SignalRepository();
    this.smartWalletRepo = new SmartWalletRepository();
    this.tradeRepo = new TradeRepository();
    this.tokenRepo = new TokenRepository();
    this.tradeFeatureRepo = new TradeFeatureRepository();
    this.closedLotRepo = new ClosedLotRepository();
    this.tokenMarketData = new TokenMarketDataService();
    this.aiDecision = new AIDecisionService();
    this.discordNotification = new DiscordNotificationService();
    this.solPriceCacheService = new SolPriceCacheService();
  }

  /**
   * Analyzuje trade a vrací všechny relevantní signály
   */
  async analyzeTradeForSignals(tradeId: string): Promise<AdvancedSignal[]> {
    const signals: AdvancedSignal[] = [];

    try {
      // Načti trade s wallet a token daty
      const trade = await prisma.trade.findUnique({
        where: { id: tradeId },
        include: {
          wallet: true,
          token: true,
        },
      });

      if (!trade) {
        console.warn(`Trade not found for signal analysis: ${tradeId}`);
        return signals;
      }

      const wallet = trade.wallet;
      const token = trade.token;

      if (!wallet || !token) {
        return signals;
      }

      // Základní context
      const context: SignalContext = {
        walletScore: wallet.score || 0,
        walletWinRate: wallet.winRate || 0,
        walletRecentPnl30d: wallet.recentPnl30dPercent || 0,
        tokenAge: await this.getTokenAgeMinutes(token.id),
        // Používejme base token velikost (SOL/USDC/USDT), ne USD odhad
        positionSizeUsd: Number(trade.amountBase || 0),
      };

      // Run only core signal detectors in parallel
      if (trade.side === 'buy') {
        const [
          accumulationSignal,
          convictionSignal,
        ] = await Promise.all([
          this.detectAccumulation(trade, wallet, token, context),
          this.detectConvictionBuy(trade, wallet, token, context),
        ]);

        if (accumulationSignal) signals.push(accumulationSignal);
        if (convictionSignal) signals.push(convictionSignal);
      } else if (trade.side === 'sell') {
        const exitSignal = await this.detectExitWarning(trade, token, context);
        if (exitSignal) signals.push(exitSignal);
      }

      return signals;
    } catch (error) {
      console.error(`Error analyzing trade for signals: ${error}`);
      return signals;
    }
  }

  /**
   * 🐋 Whale Entry Detection
   * Top trader (score >80) nakoupí pozici větší než 2x jeho průměr
   */
  private async detectWhaleEntry(
    trade: any,
    wallet: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    if (wallet.score < THRESHOLDS.WHALE_MIN_SCORE) {
      return null;
    }

    // Získej průměrnou velikost pozice wallety
    const recentTrades = await prisma.trade.findMany({
      where: {
        walletId: wallet.id,
        side: 'buy',
      },
      select: { amountBase: true },
      orderBy: { timestamp: 'desc' },
      take: 20,
    });

    if (!recentTrades || recentTrades.length < 5) {
      return null;
    }

    const avgPosition = recentTrades.reduce((sum, t) => sum + Number(t.amountBase), 0) / recentTrades.length;
    const currentPosition = Number(trade.amountBase);
    const positionMultiplier = currentPosition / avgPosition;

    if (positionMultiplier < THRESHOLDS.WHALE_MIN_POSITION_MULTIPLIER) {
      return null;
    }

    // Ukládejme průměrnou velikost pozice v base tokenu
    context.walletAvgPositionUsd = avgPosition;

    const strength = positionMultiplier >= 4 ? 'strong' : positionMultiplier >= 3 ? 'medium' : 'weak';
    const confidence = Math.min(95, 60 + wallet.score / 5 + positionMultiplier * 5);

    return {
      type: 'whale-entry',
      strength,
      confidence,
      reasoning: `🐋 Whale Entry: Top trader (score ${wallet.score.toFixed(0)}) nakoupil ${positionMultiplier.toFixed(1)}x větší pozici než obvykle. Win rate: ${(wallet.winRate * 100).toFixed(0)}%`,
      context,
      suggestedAction: 'buy',
      suggestedPositionPercent: strength === 'strong' ? 15 : strength === 'medium' ? 10 : 7,
      riskLevel: 'low',
    };
  }

  /**
   * 🎯 Early Sniper Detection
   * Smart wallet jako první koupí nový token (< 30 min starý)
   */
  private async detectEarlySniper(
    trade: any,
    wallet: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    if (wallet.score < THRESHOLDS.EARLY_SNIPER_MIN_WALLET_SCORE) {
      return null;
    }

    if (context.tokenAge > THRESHOLDS.EARLY_SNIPER_MAX_TOKEN_AGE_MINUTES) {
      return null;
    }

    // Je tento trade první BUY od smart wallets?
    const earlierBuys = await prisma.trade.findFirst({
      where: {
        tokenId: token.id,
        side: 'buy',
        timestamp: {
          lt: trade.timestamp,
        },
      },
      select: { id: true },
    });

    const isFirstSmartWalletBuy = !earlierBuys;

    if (!isFirstSmartWalletBuy) {
      return null;
    }

    const strength = context.tokenAge < 5 ? 'strong' : context.tokenAge < 15 ? 'medium' : 'weak';
    const confidence = Math.min(90, 50 + wallet.score / 3 + (30 - context.tokenAge));

    return {
      type: 'early-sniper',
      strength,
      confidence,
      reasoning: `🎯 Early Sniper: Smart wallet (score ${wallet.score.toFixed(0)}) je první, kdo koupil ${token.symbol || 'token'} (${context.tokenAge.toFixed(0)} min starý)`,
      context,
      suggestedAction: 'buy',
      suggestedPositionPercent: strength === 'strong' ? 12 : strength === 'medium' ? 8 : 5,
      riskLevel: context.tokenAge < 10 ? 'high' : 'medium', // Nové tokeny jsou riskantnější
    };
  }

  /**
   * 📈 Momentum Detection
   * Price/volume spike + smart wallet entry
   */
  private async detectMomentum(
    trade: any,
    wallet: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    // Potřebujeme market data - zkus načíst z TradeFeature
    const tradeFeature = await this.tradeFeatureRepo.findByTradeId(trade.id);

    if (!tradeFeature) {
      return null;
    }

    const priceChange5m = Number(tradeFeature.trend5mPercent || 0);
    const volume1h = Number(tradeFeature.volume1hUsd || 0);
    const volume24h = Number(tradeFeature.volume24hUsd || 0);

    // Vypočti volume spike (1h vs 24h average)
    const avgHourlyVolume = volume24h / 24;
    const volumeSpike = avgHourlyVolume > 0 ? volume1h / avgHourlyVolume : 0;

    context.tokenVolume24h = volume24h;

    const hasPriceSpike = priceChange5m >= THRESHOLDS.MOMENTUM_MIN_PRICE_CHANGE_5M;
    const hasVolumeSpike = volumeSpike >= THRESHOLDS.MOMENTUM_MIN_VOLUME_SPIKE;

    if (!hasPriceSpike && !hasVolumeSpike) {
      return null;
    }

    const strength = hasPriceSpike && hasVolumeSpike ? 'strong' : 'medium';
    const confidence = Math.min(85, 40 + priceChange5m + volumeSpike * 5 + wallet.score / 5);

    return {
      type: 'momentum',
      strength,
      confidence,
      reasoning: `📈 Momentum: ${token.symbol || 'Token'} +${priceChange5m.toFixed(1)}% (5m), volume ${volumeSpike.toFixed(1)}x normal. Smart wallet (score ${wallet.score.toFixed(0)}) nakupuje.`,
      context,
      suggestedAction: 'buy',
      suggestedPositionPercent: strength === 'strong' ? 10 : 7,
      riskLevel: 'medium',
    };
  }

  /**
   * 🔄 Re-entry Detection
   * Wallet znovu kupuje token kde předtím profitovala
   */
  private async detectReentry(
    trade: any,
    wallet: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    // Najdi předchozí uzavřené pozice na tomto tokenu
    const closedLots = await prisma.closedLot.findMany({
      where: {
        walletId: wallet.id,
        tokenId: token.id,
      },
      select: {
        realizedPnlPercent: true,
        exitTime: true,
      },
      orderBy: { exitTime: 'desc' },
      take: 5,
    });

    if (!closedLots || closedLots.length === 0) {
      return null;
    }

    // Spočítej průměrný PnL na předchozích trades
    const avgPnl = closedLots.reduce((sum, lot) => sum + (lot.realizedPnlPercent ? Number(lot.realizedPnlPercent) : 0), 0) / closedLots.length;
    const profitableTrades = closedLots.filter(lot => lot.realizedPnlPercent && Number(lot.realizedPnlPercent) > 0).length;
    const winRateOnToken = profitableTrades / closedLots.length;

    context.previousPnlOnToken = avgPnl;

    if (avgPnl < THRESHOLDS.REENTRY_MIN_PREVIOUS_PNL) {
      return null;
    }

    const strength = avgPnl >= 50 && winRateOnToken >= 0.8 ? 'strong' : avgPnl >= 30 ? 'medium' : 'weak';
    const confidence = Math.min(90, 50 + avgPnl / 2 + winRateOnToken * 20);

    return {
      type: 're-entry',
      strength,
      confidence,
      reasoning: `🔄 Re-entry: Wallet se vrací k ${token.symbol || 'tokenu'} kde předtím vydělala avg +${avgPnl.toFixed(0)}% (${profitableTrades}/${closedLots.length} profitable)`,
      context,
      suggestedAction: 'buy',
      suggestedPositionPercent: strength === 'strong' ? 12 : strength === 'medium' ? 8 : 5,
      riskLevel: 'low',
    };
  }

  /**
   * 🚨 Exit Warning Detection (Enhanced with tier system)
   * Více smart wallets začne prodávat stejný token = warning
   */
  private async detectExitWarning(
    trade: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    // Find all SELL trades for this token in recent time window
    const recentSells = await prisma.trade.findMany({
      where: {
        tokenId: token.id,
        side: 'sell',
        timestamp: {
          gte: new Date(Date.now() - SIGNAL_TIERS.EXIT_WARNING.WARNING.timeWindowHours * 60 * 60 * 1000),
        },
      },
      include: {
        wallet: {
          select: {
            id: true,
            score: true,
          },
        },
      },
    });

    if (!recentSells || recentSells.length === 0) {
      return null;
    }

    // Count unique sellers and calculate average score
    const sellerMap = new Map<string, number>();
    for (const sell of recentSells) {
      if (sell.wallet) {
        sellerMap.set(sell.walletId, sell.wallet.score || 0);
      }
    }

    const sellerCount = sellerMap.size;
    const avgScore = Array.from(sellerMap.values()).reduce((sum, score) => sum + score, 0) / sellerCount;

    // Determine tier based on seller count and avg score
    let tier: 'CRITICAL' | 'WARNING' | null = null;
    let tierConfig: any;

    if (
      sellerCount >= SIGNAL_TIERS.EXIT_WARNING.CRITICAL.minWallets &&
      avgScore >= SIGNAL_TIERS.EXIT_WARNING.CRITICAL.minAvgScore
    ) {
      tier = 'CRITICAL';
      tierConfig = SIGNAL_TIERS.EXIT_WARNING.CRITICAL;
    } else if (
      sellerCount >= SIGNAL_TIERS.EXIT_WARNING.WARNING.minWallets &&
      avgScore >= SIGNAL_TIERS.EXIT_WARNING.WARNING.minAvgScore
    ) {
      tier = 'WARNING';
      tierConfig = SIGNAL_TIERS.EXIT_WARNING.WARNING;
    }

    if (!tier) {
      return null;
    }

    const strength = tier === 'CRITICAL' ? 'strong' : 'medium';
    const confidence = Math.min(90, 50 + sellerCount * 12 + avgScore / 10);

    return {
      type: 'exit-warning',
      strength,
      confidence,
      reasoning: `🚨 Exit Warning (${tier}): ${sellerCount} smart wallets (avg score ${avgScore.toFixed(0)}) prodává ${token.symbol || 'token'} → ${tierConfig.action.replace('_', ' ')}`,
      context,
      suggestedAction: 'sell',
      riskLevel: 'high',
    };
  }

  /**
   * 🔥 Hot Token Detection
   * 3+ wallets s avg score >70 koupí stejný token
   */
  private async detectHotToken(
    trade: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    // Najdi všechny BUY trades na tento token v posledních 2h
    const recentBuys = await prisma.trade.findMany({
      where: {
        tokenId: token.id,
        side: 'buy',
        timestamp: { gte: twoHoursAgo },
      },
      select: {
        walletId: true,
        wallet: {
          select: { score: true },
        },
      },
    });

    if (!recentBuys) {
      return null;
    }

    // Unique wallets se score
    const walletScores = new Map<string, number>();
    for (const buy of recentBuys) {
      const wallet = buy.wallet;
      if (wallet?.score && !walletScores.has(buy.walletId)) {
        walletScores.set(buy.walletId, wallet.score);
      }
    }

    const walletCount = walletScores.size;
    if (walletCount < THRESHOLDS.HOT_TOKEN_MIN_WALLETS) {
      return null;
    }

    const avgScore = Array.from(walletScores.values()).reduce((sum, s) => sum + s, 0) / walletCount;
    if (avgScore < THRESHOLDS.HOT_TOKEN_MIN_AVG_SCORE) {
      return null;
    }

    context.consensusWalletCount = walletCount;

    const strength = walletCount >= 5 && avgScore >= 80 ? 'strong' : walletCount >= 4 ? 'medium' : 'weak';
    const confidence = Math.min(95, 50 + walletCount * 8 + avgScore / 5);

    return {
      type: 'hot-token',
      strength,
      confidence,
      reasoning: `🔥 Hot Token: ${walletCount} kvalitních wallets (avg score ${avgScore.toFixed(0)}) koupilo ${token.symbol || 'token'} v 2h`,
      context,
      suggestedAction: 'buy',
      suggestedPositionPercent: strength === 'strong' ? 15 : strength === 'medium' ? 10 : 7,
      riskLevel: 'low',
    };
  }

  /**
   * 📦 Accumulation Detection
   * Wallet postupně akumuluje pozici (3+ nákupy během 6h)
   */
  private async detectAccumulation(
    trade: any,
    wallet: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    const sixHoursAgo = new Date(Date.now() - THRESHOLDS.ACCUMULATION_TIME_WINDOW_HOURS * 60 * 60 * 1000);

    // Najdi všechny BUY trades této wallet na tento token v posledních 6h
    const recentBuys = await prisma.trade.findMany({
      where: {
        walletId: wallet.id,
        tokenId: token.id,
        side: 'buy',
        timestamp: { gte: sixHoursAgo },
      },
      select: {
        id: true,
        amountBase: true,
        timestamp: true,
        meta: true, // Potřebujeme baseToken pro převod USDC/USDT na SOL
      },
      orderBy: { timestamp: 'asc' },
    });

    if (!recentBuys || recentBuys.length < THRESHOLDS.ACCUMULATION_MIN_BUYS) {
      return null;
    }

    // DŮLEŽITÉ: Každý jednotlivý nákup musí mít minimálně 0.3 SOL (ne součet!)
    // Filtrujeme pouze nákupy, které mají amountBase >= 0.3 SOL
    // POZOR: amountBase může být v SOL, USDC nebo USDT - musíme zkontrolovat base token a převést na SOL
    // Získej aktuální SOL cenu pro převod USDC/USDT na SOL
    let solPriceUsd = 125.0; // Fallback
    try {
      solPriceUsd = await this.solPriceCacheService.getCurrentSolPrice();
    } catch (error: any) {
      console.warn(`   ⚠️  Failed to fetch SOL price for accumulation check, using fallback: $${solPriceUsd}`);
    }
    
    const validBuys = recentBuys.filter(t => {
      const amountBase = Number(t.amountBase) || 0;
      if (amountBase <= 0) return false;
      
      // Získej base token z meta
      const meta = t.meta as any;
      const baseToken = (meta?.baseToken || 'SOL').toUpperCase();
      
      // Převod na SOL: pokud je trade v USDC/USDT, musíme převést na SOL
      let amountInSol = amountBase;
      if (baseToken === 'USDC' || baseToken === 'USDT') {
        // USDC/USDT: přibližně 1:1 s USD, převedeme na SOL pomocí aktuální ceny
        amountInSol = amountBase / solPriceUsd;
      }
      // Pro SOL: amountInSol = amountBase (už je v SOL)
      
      // Minimum je 0.3 SOL pro všechny base tokeny
      if (amountInSol < 0.3) {
        console.log(`   ⚠️  [Accumulation] Skipping buy: amountBase=${amountBase.toFixed(4)} ${baseToken} (${amountInSol.toFixed(4)} SOL) < 0.3 SOL minimum`);
        return false;
      }
      
      return true;
    });

    // Musí být alespoň ACCUMULATION_MIN_BUYS nákupů s minimálně 0.3 SOL každý
    if (validBuys.length < THRESHOLDS.ACCUMULATION_MIN_BUYS) {
      return null;
    }

    const totalAmount = validBuys.reduce((sum, t) => sum + Number(t.amountBase), 0);
    const buyCount = validBuys.length;

    const strength = buyCount >= 5 ? 'strong' : buyCount >= 4 ? 'medium' : 'weak';
    const confidence = Math.min(85, 40 + buyCount * 10 + wallet.score / 5);

    return {
      type: 'accumulation',
      strength,
      confidence,
      reasoning: `📦 Accumulation: Wallet (score ${wallet.score.toFixed(0)}) akumuluje ${token.symbol || 'token'} - ${buyCount} nákupů za ${THRESHOLDS.ACCUMULATION_TIME_WINDOW_HOURS}h`,
      context,
      suggestedAction: 'buy',
      suggestedPositionPercent: strength === 'strong' ? 10 : 7,
      riskLevel: 'medium',
    };
  }

  /**
   * 💪 Conviction Buy Detection (Enhanced with tier system)
   * Trader nakupuje významně více než obvykle = vysoká conviction
   */
  private async detectConvictionBuy(
    trade: any,
    wallet: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    // Get average trade size from recent history
    const recentTrades = await prisma.trade.findMany({
      where: {
        walletId: wallet.id,
        side: 'buy',
      },
      select: { amountBase: true },
      orderBy: { timestamp: 'desc' },
      take: 30,
    });

    if (!recentTrades || recentTrades.length < 5) {
      return null;
    }

    const avgTradeSize = recentTrades.reduce((sum, t) => sum + Number(t.amountBase), 0) / recentTrades.length;
    const currentTradeSize = Number(trade.amountBase);
    const multiplier = avgTradeSize > 0 ? currentTradeSize / avgTradeSize : 0;

    // Determine tier based on multiplier, score, and absolute size
    let tier: 'EXTREME' | 'STRONG' | 'MEDIUM' | null = null;
    let tierConfig: any;

    if (
      multiplier >= SIGNAL_TIERS.CONVICTION.EXTREME.multiplier &&
      wallet.score >= SIGNAL_TIERS.CONVICTION.EXTREME.minWalletScore &&
      currentTradeSize >= SIGNAL_TIERS.CONVICTION.EXTREME.minAbsoluteSize
    ) {
      tier = 'EXTREME';
      tierConfig = SIGNAL_TIERS.CONVICTION.EXTREME;
    } else if (
      multiplier >= SIGNAL_TIERS.CONVICTION.STRONG.multiplier &&
      wallet.score >= SIGNAL_TIERS.CONVICTION.STRONG.minWalletScore &&
      currentTradeSize >= SIGNAL_TIERS.CONVICTION.STRONG.minAbsoluteSize
    ) {
      tier = 'STRONG';
      tierConfig = SIGNAL_TIERS.CONVICTION.STRONG;
    } else if (
      multiplier >= SIGNAL_TIERS.CONVICTION.MEDIUM.multiplier &&
      wallet.score >= SIGNAL_TIERS.CONVICTION.MEDIUM.minWalletScore &&
      currentTradeSize >= SIGNAL_TIERS.CONVICTION.MEDIUM.minAbsoluteSize
    ) {
      tier = 'MEDIUM';
      tierConfig = SIGNAL_TIERS.CONVICTION.MEDIUM;
    }

    if (!tier) {
      return null;
    }

    // Add to context
    context.walletAvgPositionUsd = avgTradeSize;
    context.positionSizeUsd = currentTradeSize;

    const strength = tier === 'EXTREME' ? 'strong' : tier === 'STRONG' ? 'strong' : 'medium';
    const confidence = Math.min(95, 55 + multiplier * 8 + wallet.score / 5);
    const [minPos, maxPos] = tierConfig.positionSizePercent;

    return {
      type: 'conviction-buy',
      strength,
      confidence,
      reasoning: `💪 Conviction Buy (${tier}): ${wallet.label || 'Trader'} (score ${wallet.score.toFixed(0)}) nakoupil ${multiplier.toFixed(1)}x více než obvykle (${currentTradeSize.toFixed(2)} SOL vs avg ${avgTradeSize.toFixed(2)} SOL)`,
      context,
      suggestedAction: 'buy',
      suggestedPositionPercent: Math.floor((minPos + maxPos) / 2), // Average of range
      riskLevel: tier === 'EXTREME' ? 'low' : tier === 'STRONG' ? 'low' : 'medium',
    };
  }

  /**
   * 📊 Volume Spike Detection
   * Token má extrémně vysoký volume
   */
  private async detectVolumeSpike(
    trade: any,
    wallet: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    // Zkus načíst volume data
    const tradeFeature = await this.tradeFeatureRepo.findByTradeId(trade.id);

    if (!tradeFeature) {
      return null;
    }

    const volume1h = Number(tradeFeature.volume1hUsd || 0);
    const volume24h = Number(tradeFeature.volume24hUsd || 0);

    if (volume24h < THRESHOLDS.VOLUME_SPIKE_MIN_USD) {
      return null;
    }

    // Spočítej volume spike (1h vs 24h average hourly)
    const avgHourlyVolume = volume24h / 24;
    const volumeSpike = avgHourlyVolume > 0 ? volume1h / avgHourlyVolume : 0;

    if (volumeSpike < THRESHOLDS.VOLUME_SPIKE_MULTIPLIER) {
      return null;
    }

    context.tokenVolume24h = volume24h;

    const strength = volumeSpike >= 10 ? 'strong' : volumeSpike >= 7 ? 'medium' : 'weak';
    const confidence = Math.min(90, 50 + volumeSpike * 3 + wallet.score / 10);

    return {
      type: 'volume-spike',
      strength,
      confidence,
      reasoning: `📊 Volume Spike: ${token.symbol || 'Token'} má ${volumeSpike.toFixed(1)}x vyšší volume než obvykle ($${(volume1h / 1000).toFixed(0)}K/h vs avg $${(avgHourlyVolume / 1000).toFixed(0)}K/h). Smart wallet nakupuje.`,
      context,
      suggestedAction: 'buy',
      suggestedPositionPercent: strength === 'strong' ? 12 : 8,
      riskLevel: 'medium',
    };
  }

  /**
   * Uloží signál do databáze
   */
  async saveSignal(
    trade: any,
    signal: AdvancedSignal
  ): Promise<SignalRecord | null> {
    try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      return await this.signalRepo.create({
        type: signal.suggestedAction === 'sell' ? 'sell' : 'buy',
        walletId: trade.walletId,
        tokenId: trade.tokenId,
        originalTradeId: trade.id,
        priceBasePerToken: Number(trade.priceBasePerToken || 0),
        amountBase: Number(trade.amountBase || 0),
        amountToken: Number(trade.amountToken || 0),
        timestamp: new Date(trade.timestamp),
        status: 'active',
        expiresAt,
        qualityScore: signal.confidence,
        riskLevel: signal.riskLevel,
        // Map advanced signal types to allowed model values (database constraint)
        model: signal.type === 'consensus' || signal.type === 'consensus-update' ? 'consensus' : 
               'smart-copy', // Fallback for all advanced signal types (whale-entry, accumulation, etc.)
        reasoning: signal.reasoning,
        meta: {
          signalType: signal.type,
          strength: signal.strength,
          context: signal.context,
          suggestedPositionPercent: signal.suggestedPositionPercent,
        },
      });
    } catch (error) {
      console.error(`Failed to save signal: ${error}`);
      return null;
    }
  }

  /**
   * Zpracuje trade a uloží všechny relevantní signály
   * Včetně token market data a AI evaluace
   */
  async processTradeForSignals(tradeId: string): Promise<{
    signals: AdvancedSignal[];
    savedCount: number;
    aiEvaluated: number;
  }> {
    const signals = await this.analyzeTradeForSignals(tradeId);
    
    if (signals.length === 0) {
      return { signals: [], savedCount: 0, aiEvaluated: 0 };
    }

    // Načti trade s token daty
    const trade = await prisma.trade.findUnique({
      where: { id: tradeId },
      include: {
        token: true,
        wallet: true,
      },
    });

    if (!trade) {
      return { signals, savedCount: 0, aiEvaluated: 0 };
    }

    const token = trade.token;
    const wallet = trade.wallet;

    // Fetch token market data
    let marketData = {
      marketCap: null as number | null,
      liquidity: null as number | null,
      volume24h: null as number | null,
      tokenAgeMinutes: null as number | null,
    };

    if (token?.mintAddress) {
      try {
        marketData = await this.tokenMarketData.getMarketData(token.mintAddress);
      } catch (e) {
        console.warn(`Failed to fetch market data for ${token.mintAddress}`);
      }
    }

    // Calculate entry price in USD per token
    // trade.valueUsd = total trade value in USD, trade.amountToken = token amount
    const amountToken = Number(trade.amountToken || 0);
    let entryPriceUsd = 0;
    if (amountToken > 0 && trade.valueUsd != null) {
      entryPriceUsd = Number(trade.valueUsd) / amountToken;
    } else {
      // Fallback: use base token price if USD value is not available
      entryPriceUsd = Number(trade.priceBasePerToken || 0);
    }

    let savedCount = 0;
    let aiEvaluated = 0;

    // DŮLEŽITÉ: AI decision se volá jen jednou pro trade (ne pro každý signál zvlášť)
    // Vyber nejlepší signál (nejvyšší confidence) pro AI evaluaci
    let bestSignalForAI: AdvancedSignal | null = null;
    let bestSignalConfidence = 0;

    for (const signal of signals) {
      if (signal.confidence < 50) continue;

      // Enrich signal context with market data
      signal.context.tokenSymbol = token?.symbol;
      signal.context.tokenMint = token?.mintAddress;
      signal.context.tokenMarketCap = marketData.marketCap || undefined;
      signal.context.tokenLiquidity = marketData.liquidity || undefined;
      signal.context.tokenVolume24h = marketData.volume24h || undefined;
      signal.context.entryPriceUsd = entryPriceUsd;
      signal.context.walletTotalTrades = wallet?.totalTrades;
      signal.context.walletAvgHoldTimeMin = wallet?.avgHoldingTimeMin;
      signal.entryPriceUsd = entryPriceUsd;

      // Calculate SL/TP based on risk level
      if (entryPriceUsd > 0) {
        const slPercent = signal.riskLevel === 'low' ? 0.20 : signal.riskLevel === 'medium' ? 0.30 : 0.40;
        const tpPercent = signal.riskLevel === 'low' ? 0.50 : signal.riskLevel === 'medium' ? 0.75 : 1.00;
        signal.stopLossPriceUsd = entryPriceUsd * (1 - slPercent);
        signal.takeProfitPriceUsd = entryPriceUsd * (1 + tpPercent);
        signal.suggestedHoldTimeMinutes = signal.riskLevel === 'low' ? 120 : signal.riskLevel === 'medium' ? 60 : 30;
      }

      // Najdi nejlepší signál pro AI evaluaci (nejvyšší confidence)
      if (signal.suggestedAction === 'buy' && signal.confidence > bestSignalConfidence) {
        bestSignalForAI = signal;
        bestSignalConfidence = signal.confidence;
      }
    }

      // AI Evaluation (if GROQ_API_KEY is set) - JEN PRO NEJLEPŠÍ SIGNÁL
    let sharedAIDecision: any = null;
    if (process.env.GROQ_API_KEY && bestSignalForAI && bestSignalForAI.suggestedAction === 'buy' && bestSignalForAI.confidence >= 50) {
      console.log(`🤖 [AdvancedSignals] Calling AI for best signal: ${bestSignalForAI.type} (confidence: ${bestSignalForAI.confidence}%) - will reuse for all ${signals.length} signals from this trade`);
        try {
          const aiContext: AIContext = {
          signal: bestSignalForAI,
          signalType: bestSignalForAI.type,
          walletScore: bestSignalForAI.context.walletScore,
          walletWinRate: bestSignalForAI.context.walletWinRate,
          walletRecentPnl30d: bestSignalForAI.context.walletRecentPnl30d,
          walletTotalTrades: bestSignalForAI.context.walletTotalTrades || 0,
          walletAvgHoldTimeMin: bestSignalForAI.context.walletAvgHoldTimeMin || 60,
          tokenSymbol: bestSignalForAI.context.tokenSymbol,
          tokenAge: bestSignalForAI.context.tokenAge,
          tokenLiquidity: bestSignalForAI.context.tokenLiquidity,
          tokenVolume24h: bestSignalForAI.context.tokenVolume24h,
          tokenMarketCap: bestSignalForAI.context.tokenMarketCap,
          otherWalletsCount: bestSignalForAI.context.consensusWalletCount,
          consensusStrength: bestSignalForAI.strength,
          };

        const aiResult = await this.aiDecision.evaluateSignal(bestSignalForAI, aiContext);
        sharedAIDecision = aiResult;
          
          if (aiResult && !aiResult.isFallback) {
          aiEvaluated++;
          console.log(`✅ [AdvancedSignals] AI evaluated best signal (${bestSignalForAI.type}): ${aiResult.decision} (${aiResult.confidence}% confidence) - will reuse for all signals`);
          } else if (aiResult && aiResult.isFallback) {
          console.warn(`⚠️  [AdvancedSignals] AI returned fallback - will not use (showing "-" instead)`);
          sharedAIDecision = null;
          } else {
          console.warn(`⚠️  [AdvancedSignals] AI evaluation returned null - AI not available`);
          sharedAIDecision = null;
          }
        } catch (aiError: any) {
        console.error(`❌ [AdvancedSignals] AI evaluation failed: ${aiError.message}`);
        sharedAIDecision = null;
        }
      } else if (!process.env.GROQ_API_KEY) {
      console.warn(`⚠️  [AdvancedSignals] GROQ_API_KEY not set - skipping AI evaluation`);
    }

    // Nyní projdi všechny signály a použij sdílené AI decision
    for (const signal of signals) {
      if (signal.confidence < 50) continue;

      // Použij sdílené AI decision pro všechny signály z tohoto trade
      if (sharedAIDecision && !sharedAIDecision.isFallback && signal.suggestedAction === 'buy') {
        signal.aiDecision = sharedAIDecision;
        
        // Update SL/TP based on AI recommendation
        if (sharedAIDecision.decision === 'buy' && entryPriceUsd > 0) {
          signal.stopLossPriceUsd = entryPriceUsd * (1 - (sharedAIDecision.stopLossPercent || 25) / 100);
          signal.takeProfitPriceUsd = entryPriceUsd * (1 + (sharedAIDecision.takeProfitPercent || 50) / 100);
          signal.suggestedHoldTimeMinutes = sharedAIDecision.expectedHoldTimeMinutes;
          signal.suggestedPositionPercent = sharedAIDecision.suggestedPositionPercent;
        }
      } else {
        signal.aiDecision = undefined;
      }

      // Save enhanced signal
      const saved = await this.saveEnhancedSignal(trade, signal, marketData);
      if (saved) {
        savedCount++;
        
        // Send Discord notification for core signals only
        // ACTIVE TYPES: consensus, accumulation, conviction-buy (BUY signals), exit-warning (SELL signal)
        // All other signal types are deprecated and not sent to Discord
        const allowedDiscordSignalTypes = ['consensus', 'consensus-update', 'accumulation', 'conviction-buy', 'exit-warning'];
        const shouldSendDiscord =
          (signal.suggestedAction === 'buy' && ['consensus', 'consensus-update', 'accumulation', 'conviction-buy'].includes(signal.type)) ||
          (signal.suggestedAction === 'sell' && signal.type === 'exit-warning');

        if (shouldSendDiscord) {
          try {
            // Get base token from trade meta (default SOL)
            // Try multiple ways to get baseToken
            let baseToken = 'SOL';
            if (trade.meta && typeof trade.meta === 'object') {
              const meta = trade.meta as any;
              baseToken = (meta.baseToken || meta.base_token || 'SOL').toUpperCase();
            } else if ((trade as any).meta?.baseToken) {
              baseToken = ((trade as any).meta.baseToken || 'SOL').toUpperCase();
            }
            
            // Pro accumulation signály: seskupit do jednoho embedu (debounce 1 minuta)
            if (signal.type === 'accumulation') {
              const key = `${token.id}-${wallet.id}`;
              const existing = this.pendingAccumulationSignals.get(key);
              
              if (existing) {
                // Aktualizuj existující pending signál
                existing.lastTradeTime = trade.timestamp;
                existing.signal = signal; // Aktualizuj signál (může se změnit strength)
                existing.marketData = marketData; // Aktualizuj market data
                
                // Reset timeout - počkáme další minutu od posledního trade
                if (existing.timeoutId) {
                  clearTimeout(existing.timeoutId);
                }
                existing.timeoutId = setTimeout(() => {
                  this.sendAccumulationNotification(existing);
                  this.pendingAccumulationSignals.delete(key);
                }, this.ACCUMULATION_GROUP_WINDOW_MS);
                
                console.log(`📦 [Accumulation] Updated pending signal for ${token.symbol} - ${wallet.label || wallet.address.substring(0, 8)}... (waiting for more trades)`);
                continue; // Pokračuj na další signál
              } else {
                // Nový accumulation signál - přidej do pending a nastav timeout
                const pending: PendingAccumulationSignal = {
                  tokenId: token.id,
                  walletId: wallet.id,
                  tokenSymbol: token?.symbol || 'Unknown',
                  tokenMint: token?.mintAddress || '',
                  wallet,
                  token,
                  baseToken,
                  marketData,
                  signal,
                  firstTradeTime: trade.timestamp,
                  lastTradeTime: trade.timestamp,
                };
                
                pending.timeoutId = setTimeout(() => {
                  this.sendAccumulationNotification(pending);
                  this.pendingAccumulationSignals.delete(key);
                }, this.ACCUMULATION_GROUP_WINDOW_MS);
                
                this.pendingAccumulationSignals.set(key, pending);
                console.log(`📦 [Accumulation] Created pending signal for ${token.symbol} - ${wallet.label || wallet.address.substring(0, 8)}... (will send in 1 minute if no more trades)`);
                continue; // Pokračuj na další signál
              }
            }
            
            // Pro ostatní signály: pošli okamžitě
            console.log(`📨 [AdvancedSignals] Sending Discord notification for ${signal.type} signal - baseToken: ${baseToken}, walletId: ${wallet?.id ? 'yes' : 'no'}, walletAddress: ${wallet?.address?.substring(0, 8)}...`);
            
            const notificationData: SignalNotificationData = {
              tokenSymbol: token?.symbol || 'Unknown',
              tokenMint: token?.mintAddress || '',
              signalType: signal.type,
              strength: signal.strength,
              walletCount: signal.context.consensusWalletCount || 1,
              avgWalletScore: signal.context.walletScore || 0,
              entryPriceUsd: signal.entryPriceUsd || 0,
              marketCapUsd: marketData.marketCap || undefined,
              liquidityUsd: marketData.liquidity || undefined,
              volume24hUsd: marketData.volume24h || undefined,
              tokenAgeMinutes: marketData.tokenAgeMinutes || undefined,
              baseToken, // Add base token
              // Only include AI decision if we have a real one (not fallback)
              aiDecision: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.decision : undefined,
              aiConfidence: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.confidence : undefined,
              aiReasoning: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.reasoning : undefined,
              aiPositionPercent: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.suggestedPositionPercent : undefined,
              stopLossPercent: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.stopLossPercent : undefined,
              takeProfitPercent: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.takeProfitPercent : undefined,
              stopLossPriceUsd: signal.aiDecision && !signal.aiDecision.isFallback ? signal.stopLossPriceUsd : undefined,
              takeProfitPriceUsd: signal.aiDecision && !signal.aiDecision.isFallback ? signal.takeProfitPriceUsd : undefined,
              aiRiskScore: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.riskScore : undefined,
              wallets: [{
                label: wallet?.label,
                address: wallet?.address || '',
                walletId: wallet?.id, // Add wallet ID for profile link
                score: wallet?.score || 0,
                // Velikost pozice v base tokenu (SOL/USDC/USDT)
                tradeAmountUsd: Number(trade.amountBase || 0),
                // Cena v USD za 1 token (preferuj valueUsd/amountToken, fallback na base price)
                tradePrice: (() => {
                  const amountToken = Number(trade.amountToken || 0);
                  const valueUsd = Number(trade.valueUsd || 0);
                  if (amountToken > 0 && valueUsd > 0) {
                    return valueUsd / amountToken;
                  }
                  return Number(trade.priceBasePerToken || 0);
                })(),
                tradeTime: trade.timestamp.toISOString(),
                // Pro accumulation signál: všechny nákupy tradera
                accumulationBuys: (signal.type as string) === 'accumulation' ? await (async () => {
                  // Načti všechny validní nákupy pro accumulation signál
                  const sixHoursAgo = new Date(Date.now() - THRESHOLDS.ACCUMULATION_TIME_WINDOW_HOURS * 60 * 60 * 1000);
                  const recentBuys = await prisma.trade.findMany({
                    where: {
                      walletId: wallet.id,
                      tokenId: token.id,
                      side: 'buy',
                      timestamp: { gte: sixHoursAgo },
                    },
                    select: {
                      id: true,
                      amountBase: true,
                      timestamp: true,
                      meta: true,
                      valueUsd: true, // Pro fallback market cap z meta
                    },
                    orderBy: { timestamp: 'desc' }, // Od nejnovějšího po nejstarší
                  });
                  
                  console.log(`[ACCUMULATION] Found ${recentBuys.length} recent buys for ${token.symbol}, checking meta for market cap...`);
                  
                  // Filtruj podle 0.3 SOL minimum (stejná logika jako v detectAccumulation)
                  let solPriceUsd = 125.0;
                  try {
                    solPriceUsd = await this.solPriceCacheService.getCurrentSolPrice();
                  } catch (error: any) {
                    // Fallback
                  }
                  
                  const validBuys = recentBuys.filter(t => {
                    const amountBase = Number(t.amountBase) || 0;
                    if (amountBase <= 0) return false;
                    const meta = t.meta as any;
                    const baseToken = (meta?.baseToken || 'SOL').toUpperCase();
                    let amountInSol = amountBase;
                    if (baseToken === 'USDC' || baseToken === 'USDT') {
                      amountInSol = amountBase / solPriceUsd;
                    }
                    return amountInSol >= 0.3;
                  });
                  
                  // Načti market cap pro každý trade z TradeFeature (fdvUsd) nebo z Trade.meta
                  // Pokud není k dispozici, necháme null (ne fallback na globální market cap)
                  const buyResults = await Promise.all(
                    validBuys.map(async (buy) => {
                      let marketCapUsd: number | undefined = undefined;
                      
                      // 1. Zkus načíst z TradeFeature (nejpřesnější - market cap v době trade)
                      try {
                        const tradeFeature = await this.tradeFeatureRepo.findByTradeId(buy.id);
                        if (tradeFeature?.fdvUsd !== null && tradeFeature?.fdvUsd !== undefined) {
                          marketCapUsd = tradeFeature.fdvUsd;
                        }
                      } catch (error: any) {
                        // TradeFeature neexistuje, zkus fallback na Trade.meta
                      }
                      
                      // 2. Fallback: zkus načíst z Trade.meta (pokud tam byl uložen při vytvoření trade)
                      if (!marketCapUsd && buy.meta) {
                        const meta = buy.meta as any;
                        console.log(`[ACCUMULATION] Trade ${buy.id} meta:`, JSON.stringify({ marketCapUsd: meta.marketCapUsd, fdvUsd: meta.fdvUsd, marketCap: meta.marketCap }));
                        if (meta.marketCapUsd !== null && meta.marketCapUsd !== undefined) {
                          marketCapUsd = Number(meta.marketCapUsd);
                          console.log(`[ACCUMULATION] Found marketCapUsd in meta: ${marketCapUsd} for trade ${buy.id}`);
                        } else if (meta.fdvUsd !== null && meta.fdvUsd !== undefined) {
                          marketCapUsd = Number(meta.fdvUsd);
                          console.log(`[ACCUMULATION] Found fdvUsd in meta: ${marketCapUsd} for trade ${buy.id}`);
                        } else if (meta.marketCap !== null && meta.marketCap !== undefined) {
                          marketCapUsd = Number(meta.marketCap);
                          console.log(`[ACCUMULATION] Found marketCap in meta: ${marketCapUsd} for trade ${buy.id}`);
                        } else {
                          console.warn(`[ACCUMULATION] No market cap found in meta for trade ${buy.id}`);
                        }
                      } else if (!buy.meta) {
                        console.warn(`[ACCUMULATION] No meta object for trade ${buy.id}`);
                      }
                      
                      // Pokud nemáme market cap, necháme undefined (zobrazí se "- MCap")
                      
                      return {
                        amountBase: Number(buy.amountBase),
                        timestamp: buy.timestamp.toISOString(),
                        marketCapUsd,
                      };
                    })
                  );
                  
                  return buyResults;
                })() : undefined,
              }],
            };
            
            console.log(`📨 [AdvancedSignals] About to send Discord notification - baseToken: ${notificationData.baseToken || 'MISSING'}, walletIds: ${notificationData.wallets?.map(w => w.walletId ? 'yes' : 'no').join(',') || 'none'}, aiDecision: ${notificationData.aiDecision || 'undefined'}`);
            await this.discordNotification.sendSignalNotification(notificationData);
          } catch (discordError: any) {
            console.warn(`⚠️  Discord notification failed: ${discordError.message}`);
          }
        }
      }
    }

    return { signals, savedCount, aiEvaluated };
  }

  /**
   * Pošle seskupený accumulation signál do Discordu
   */
  private async sendAccumulationNotification(pending: PendingAccumulationSignal): Promise<void> {
    try {
      const { token, wallet, baseToken, marketData, signal } = pending;
      
      // Načti všechny validní nákupy pro accumulation signál (stejná logika jako v detectAccumulation)
      const sixHoursAgo = new Date(Date.now() - THRESHOLDS.ACCUMULATION_TIME_WINDOW_HOURS * 60 * 60 * 1000);
      const recentBuys = await prisma.trade.findMany({
        where: {
          walletId: wallet.id,
          tokenId: token.id,
          side: 'buy',
          timestamp: { gte: sixHoursAgo },
        },
        select: {
          id: true,
          amountBase: true,
          timestamp: true,
          meta: true,
          valueUsd: true, // Pro fallback market cap z meta
        },
        orderBy: { timestamp: 'asc' },
      });
      
      // Filtruj podle 0.3 SOL minimum
      let solPriceUsd = 125.0;
      try {
        solPriceUsd = await this.solPriceCacheService.getCurrentSolPrice();
      } catch (error: any) {
        // Fallback
      }
      
      const validBuys = recentBuys.filter(t => {
        const amountBase = Number(t.amountBase) || 0;
        if (amountBase <= 0) return false;
        const meta = t.meta as any;
        const baseTokenFromMeta = (meta?.baseToken || 'SOL').toUpperCase();
        let amountInSol = amountBase;
        if (baseTokenFromMeta === 'USDC' || baseTokenFromMeta === 'USDT') {
          amountInSol = amountBase / solPriceUsd;
        }
        return amountInSol >= 0.3;
      });
      
      // Načti market cap pro každý trade z TradeFeature (fdvUsd) nebo z Trade.meta
      const buyResults = await Promise.all(
        validBuys.map(async (buy) => {
          let marketCapUsd: number | undefined = undefined;
          
          // 1. Zkus načíst z TradeFeature (nejpřesnější - market cap v době trade)
          try {
            const tradeFeature = await this.tradeFeatureRepo.findByTradeId(buy.id);
            if (tradeFeature?.fdvUsd !== null && tradeFeature?.fdvUsd !== undefined) {
              marketCapUsd = tradeFeature.fdvUsd;
            }
          } catch (error: any) {
            // TradeFeature neexistuje, zkus fallback
          }
          
          // 2. Fallback: zkus načíst z Trade.meta (pokud tam byl uložen při vytvoření trade)
          if (!marketCapUsd && buy.meta) {
            const meta = buy.meta as any;
            console.log(`[ACCUMULATION-SEND] Trade ${buy.id} meta:`, JSON.stringify({ marketCapUsd: meta.marketCapUsd, fdvUsd: meta.fdvUsd, marketCap: meta.marketCap }));
            if (meta.marketCapUsd !== null && meta.marketCapUsd !== undefined) {
              marketCapUsd = Number(meta.marketCapUsd);
              console.log(`[ACCUMULATION-SEND] Found marketCapUsd in meta: ${marketCapUsd} for trade ${buy.id}`);
            } else if (meta.fdvUsd !== null && meta.fdvUsd !== undefined) {
              marketCapUsd = Number(meta.fdvUsd);
              console.log(`[ACCUMULATION-SEND] Found fdvUsd in meta: ${marketCapUsd} for trade ${buy.id}`);
            } else if (meta.marketCap !== null && meta.marketCap !== undefined) {
              marketCapUsd = Number(meta.marketCap);
              console.log(`[ACCUMULATION-SEND] Found marketCap in meta: ${marketCapUsd} for trade ${buy.id}`);
            } else {
              console.warn(`[ACCUMULATION-SEND] No market cap found in meta for trade ${buy.id}`);
            }
          } else if (!buy.meta) {
            console.warn(`[ACCUMULATION-SEND] No meta object for trade ${buy.id}`);
          }
          
          return {
            amountBase: Number(buy.amountBase),
            timestamp: buy.timestamp.toISOString(),
            marketCapUsd,
          };
        })
      );
      
      const notificationData: SignalNotificationData = {
        tokenSymbol: pending.tokenSymbol,
        tokenMint: pending.tokenMint,
        signalType: 'accumulation',
        strength: signal.strength,
        walletCount: 1,
        avgWalletScore: wallet?.score || 0,
        entryPriceUsd: signal.entryPriceUsd || 0,
        marketCapUsd: marketData.marketCap || undefined,
        liquidityUsd: marketData.liquidity || undefined,
        volume24hUsd: marketData.volume24h || undefined,
        tokenAgeMinutes: marketData.tokenAgeMinutes || undefined,
        baseToken,
        aiDecision: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.decision : undefined,
        aiConfidence: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.confidence : undefined,
        aiReasoning: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.reasoning : undefined,
        aiPositionPercent: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.suggestedPositionPercent : undefined,
        stopLossPercent: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.stopLossPercent : undefined,
        takeProfitPercent: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.takeProfitPercent : undefined,
        stopLossPriceUsd: signal.aiDecision && !signal.aiDecision.isFallback ? signal.stopLossPriceUsd : undefined,
        takeProfitPriceUsd: signal.aiDecision && !signal.aiDecision.isFallback ? signal.takeProfitPriceUsd : undefined,
        aiRiskScore: signal.aiDecision && !signal.aiDecision.isFallback ? signal.aiDecision.riskScore : undefined,
        wallets: [{
          label: wallet?.label,
          address: wallet?.address || '',
          walletId: wallet?.id,
          score: wallet?.score || 0,
          tradeAmountUsd: Number(validBuys[validBuys.length - 1]?.amountBase || 0), // Poslední trade
          tradePrice: signal.entryPriceUsd || 0,
          tradeTime: pending.lastTradeTime.toISOString(),
          accumulationBuys: buyResults,
        }],
      };
      
      await this.discordNotification.sendSignalNotification(notificationData);
    } catch (error: any) {
      console.error(`❌ Error sending accumulation notification: ${error.message}`);
    }
  }

  /**
   * Uloží rozšířený signál s market data a AI rozhodnutím
   */
  private async saveEnhancedSignal(
    trade: any,
    signal: AdvancedSignal,
    marketData: { marketCap: number | null; liquidity: number | null; volume24h: number | null; tokenAgeMinutes: number | null }
  ): Promise<SignalRecord | null> {
    try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      const insertData: any = {
        type: signal.suggestedAction === 'sell' ? 'sell' : 'buy',
        walletId: trade.walletId,
        tokenId: trade.tokenId,
        originalTradeId: trade.id,
        priceBasePerToken: Number(trade.priceBasePerToken || 0),
        amountBase: Number(trade.amountBase || 0),
        amountToken: Number(trade.amountToken || 0),
        timestamp: new Date(trade.timestamp),
        status: 'active',
        expiresAt,
        qualityScore: signal.confidence,
        riskLevel: signal.riskLevel,
        // Map advanced signal types to allowed model values (database constraint)
        // Allowed: 'smart-copy' | 'consensus' | 'ai' | ...
        // Advanced types (accumulation, exit-warning, etc.) are stored in meta.signalType
        model: signal.type === 'consensus' || signal.type === 'consensus-update' ? 'consensus' : 
               'smart-copy', // Fallback for all advanced signal types (whale-entry, accumulation, etc.)
        reasoning: signal.reasoning,
        strength: signal.strength,
        // Entry/Exit prices
        entryPriceUsd: signal.entryPriceUsd,
        suggestedExitPriceUsd: signal.takeProfitPriceUsd,
        stopLossPriceUsd: signal.stopLossPriceUsd,
        takeProfitPriceUsd: signal.takeProfitPriceUsd,
        suggestedHoldTimeMinutes: signal.suggestedHoldTimeMinutes,
        // Token market data
        tokenMarketCapUsd: marketData.marketCap,
        tokenLiquidityUsd: marketData.liquidity,
        tokenVolume24hUsd: marketData.volume24h,
        tokenAgeMinutes: marketData.tokenAgeMinutes || Math.round(signal.context.tokenAge),
        // Meta
        meta: {
          signalType: signal.type,
          strength: signal.strength,
          context: signal.context,
          suggestedPositionPercent: signal.suggestedPositionPercent,
        },
      };

      // Add AI decision data if available
      if (signal.aiDecision) {
        insertData.aiDecision = signal.aiDecision.decision;
        insertData.aiConfidence = signal.aiDecision.confidence;
        insertData.aiReasoning = signal.aiDecision.reasoning;
        insertData.aiSuggestedPositionPercent = signal.aiDecision.suggestedPositionPercent;
        insertData.aiStopLossPercent = signal.aiDecision.stopLossPercent;
        insertData.aiTakeProfitPercent = signal.aiDecision.takeProfitPercent;
        insertData.aiRiskScore = signal.aiDecision.riskScore;
      }

      // Use SignalRepository with AI fields in meta
      return await this.signalRepo.create({
        type: signal.suggestedAction === 'sell' ? 'sell' : 'buy',
        walletId: trade.walletId,
        tokenId: trade.tokenId,
        originalTradeId: trade.id,
        priceBasePerToken: Number(trade.priceBasePerToken),
        amountBase: Number(trade.amountBase),
        amountToken: Number(trade.amountToken),
        timestamp: new Date(trade.timestamp),
        status: 'active',
        expiresAt,
        qualityScore: signal.confidence,
        riskLevel: signal.riskLevel,
        model: signal.type === 'consensus' || signal.type === 'consensus-update' ? 'consensus' : 'smart-copy',
        reasoning: signal.reasoning,
        meta: {
          signalType: signal.type,
          strength: signal.strength,
          context: signal.context,
          suggestedPositionPercent: signal.suggestedPositionPercent,
          // Enhanced fields for trading bot
          entryPriceUsd: signal.entryPriceUsd,
          suggestedExitPriceUsd: signal.takeProfitPriceUsd,
          stopLossPriceUsd: signal.stopLossPriceUsd,
          takeProfitPriceUsd: signal.takeProfitPriceUsd,
          suggestedHoldTimeMinutes: signal.suggestedHoldTimeMinutes,
          // Token market data
          tokenMarketCapUsd: marketData.marketCap,
          tokenLiquidityUsd: marketData.liquidity,
          tokenVolume24hUsd: marketData.volume24h,
          tokenAgeMinutes: marketData.tokenAgeMinutes || Math.round(signal.context.tokenAge),
          // AI decision data if available
          ...(signal.aiDecision ? {
            aiDecision: signal.aiDecision.decision,
            aiConfidence: signal.aiDecision.confidence,
            aiReasoning: signal.aiDecision.reasoning,
            aiSuggestedPositionPercent: signal.aiDecision.suggestedPositionPercent,
            aiStopLossPercent: signal.aiDecision.stopLossPercent,
            aiTakeProfitPercent: signal.aiDecision.takeProfitPercent,
            aiRiskScore: signal.aiDecision.riskScore,
          } : {}),
        },
      });
    } catch (error) {
      console.error(`Failed to save enhanced signal: ${error}`);
      return null;
    }
  }

  /**
   * Helper: Získá stáří tokenu v minutách
   */
  private async getTokenAgeMinutes(tokenId: string): Promise<number> {
    const firstTrade = await prisma.trade.findFirst({
      where: { tokenId },
      select: { timestamp: true },
      orderBy: { timestamp: 'asc' },
    });

    if (!firstTrade) {
      return 0;
    }

    const firstTradeTime = new Date(firstTrade.timestamp);
    const now = new Date();
    return (now.getTime() - firstTradeTime.getTime()) / (1000 * 60);
  }

  /**
   * Získá shrnutí všech aktivních signálů
   */
  async getActiveSignalsSummary(): Promise<{
    byType: Record<string, number>;
    byStrength: Record<string, number>;
    total: number;
  }> {
    const signals = await this.signalRepo.findActive({ limit: 100 });
    
    const byType: Record<string, number> = {};
    const byStrength: Record<string, number> = { weak: 0, medium: 0, strong: 0 };

    for (const signal of signals) {
      const type = (signal.meta as any)?.signalType || signal.model || 'unknown';
      const strength = (signal.meta as any)?.strength || 'unknown';
      
      byType[type] = (byType[type] || 0) + 1;
      if (strength in byStrength) {
        byStrength[strength]++;
      }
    }

    return {
      byType,
      byStrength,
      total: signals.length,
    };
  }
}

