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
import { SignalPerformanceService } from './signal-performance.service.js';
import { signalFilter } from './signal-filter.service.js';
import { RugCheckService } from './rugcheck.service.js';
import { signalQualityFilter } from './signal-quality-filter.service.js';
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
  // Exit-warning specific fields
  exitSellerCount?: number;
  exitSellerNames?: string;
  exitTotalBuyers?: number;
  exitSellers?: Array<{
    walletId: string;
    address: string;
    label: string | null;
    score: number;
    totalSoldUsd: number;
    totalSoldTokens: number;
    totalBoughtTokens: number;   // Celkový bag (kolik nakoupil)
    remainingTokens: number;     // Kolik mu zbývá po prodeji
    lastSellTime: Date;
    sellCount: number;
  }>;
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
      minAvgScore: 55,      // 70 → 55 (adjusted for new scoring system)
      minMarketCap: 20000,  // Minimum $20K market cap
      timeWindowHours: 1,
      positionSizePercent: [15, 20],
    },
    MEDIUM: {
      minWallets: 2,
      minAvgScore: 50,      // 65 → 50 (adjusted for new scoring system)
      minMarketCap: 20000,  // Minimum $20K market cap
      timeWindowHours: 2,
      positionSizePercent: [10, 15],
    },
    WEAK: {
      minWallets: 2,
      minAvgScore: 45,      // 55 → 45 (adjusted for new scoring system)
      minMarketCap: 20000,  // Minimum $20K market cap
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
      minWalletScore: 50,      // 70 → 50 (adjusted for new scoring system)
      minMarketCap: 20000,     // Minimum $20K market cap
      positionSizePercent: [10, 15],
    },
    MEDIUM: {
      minBuys: 3,
      timeWindowHours: 18,
      minSizePerBuy: 0.5,      // 0.3 → 0.5 SOL (vyšší jednotlivé nákupy)
      minTotalSize: 2.0,       // 1.5 → 2.0 SOL (celkově větší akumulace)
      minWalletScore: 45,      // 65 → 45 (adjusted for new scoring system)
      minMarketCap: 20000,     // Minimum $20K market cap
      positionSizePercent: [7, 12],
    },
    WEAK: {
      minBuys: 3,              // 2 → 3 (více důkazů o akumulaci)
      timeWindowHours: 24,     // 12 → 24 (delší sledování)
      minSizePerBuy: 0.5,      // 0.3 → 0.5 SOL (vyšší jednotlivé nákupy)
      minTotalSize: 2.0,       // 0.8 → 2.0 SOL (celkově minimálně ~$250)
      minWalletScore: 40,      // 65 → 40 (adjusted for new scoring system)
      minMarketCap: 20000,     // Minimum $20K market cap (filtr proti rugs)
      positionSizePercent: [5, 8],
    },
  },
  CONVICTION: {
    EXTREME: {
      multiplier: 5,           // 5x+ average
      minWalletScore: 55,      // 75 → 55 (adjusted for new scoring system)
      minAbsoluteSize: 8,      // SOL minimum absolute size (5 → 8)
      minMarketCap: 20000,     // Minimum $20K market cap
      positionSizePercent: [20, 25],
    },
    STRONG: {
      multiplier: 3,
      minWalletScore: 50,      // 70 → 50 (adjusted for new scoring system)
      minAbsoluteSize: 5,      // 2 → 5 SOL
      minMarketCap: 20000,     // Minimum $20K market cap
      positionSizePercent: [15, 20],
    },
    MEDIUM: {
      multiplier: 2,
      minWalletScore: 45,      // 65 → 45 (adjusted for new scoring system)
      minAbsoluteSize: 3,      // 1 → 3 SOL (minimum for conviction-buy)
      minMarketCap: 20000,     // Minimum $20K market cap
      positionSizePercent: [10, 15],
    },
  },
  EXIT_WARNING: {
    CRITICAL: {
      minWallets: 3,
      timeWindowHours: 2,
      minAvgScore: 50,      // 70 → 50 (adjusted for new scoring system)
      action: 'SELL_IMMEDIATELY',
    },
    WARNING: {
      minWallets: 2,
      timeWindowHours: 4,
      minAvgScore: 45,      // 65 → 45 (adjusted for new scoring system)
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
  securityData?: SignalNotificationData['security'];
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
  private signalPerformance: SignalPerformanceService;
  private rugCheck: RugCheckService;

  // Cache pro seskupování accumulation signálů (key: tokenId-walletId)
  private pendingAccumulationSignals: Map<string, PendingAccumulationSignal> = new Map();
  private readonly ACCUMULATION_GROUP_WINDOW_MS = 60 * 1000; // 1 minuta

  // Cache pro accumulation signály - ukládá timestamp posledního zpracovaného nákupu per token
  // Nový signál se odešle pouze pokud jsou nákupy NOVĚJŠÍ než tento timestamp
  private lastProcessedAccumulationTrade: Map<string, Date> = new Map(); // tokenId -> last trade timestamp

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
    this.signalPerformance = new SignalPerformanceService();
    this.rugCheck = new RugCheckService();
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
   * Detekuje když wallety, které NAKOUPILY token, ho začnou PRODÁVAT
   * To je silnější signál než obecné prodeje - tito tradeři věděli co kupují
   */
  /**
   * 🚨 Instant Sell Notification
   * CHANGED: Each individual sell from a smart wallet generates its own instant notification
   * No waiting for multiple sellers, no aggregation - immediate notification per sell
   */
  private async detectExitWarning(
    trade: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    console.log(`🔍 [ExitWarning] Checking sell for ${token.symbol || token.id.substring(0, 8)}...`);

    // 0. Fetch market data and filter by market cap
    // PRIMÁRNĚ: použij MCap z trade.meta (bonding curve), pak Birdeye API
    const MIN_MARKET_CAP_FOR_EXIT_WARNING = 20000; // $20K minimum

    let marketData = { marketCap: null as number | null };
    if (token?.mintAddress) {
      try {
        const tradeMeta = trade.meta as any;
        marketData = await this.tokenMarketData.getMarketDataWithTradeMeta(token.mintAddress, tradeMeta);
      } catch (e) {
        console.warn(`   ⚠️  [ExitWarning] Failed to fetch market data for ${token.symbol}`);
      }
    }

    // If market cap is unknown, skip
    if (marketData.marketCap === null || marketData.marketCap === undefined) {
      console.log(`   ⏭️  [ExitWarning] Token ${token.symbol} market cap UNKNOWN - skipping`);
      return null;
    }

    // Only care about tokens ABOVE minimum market cap ($20K+)
    if (marketData.marketCap < MIN_MARKET_CAP_FOR_EXIT_WARNING) {
      console.log(`   ⏭️  [ExitWarning] Token ${token.symbol} market cap $${(marketData.marketCap / 1000).toFixed(1)}K < $${(MIN_MARKET_CAP_FOR_EXIT_WARNING / 1000).toFixed(0)}K minimum - skipping (too small)`);
      return null;
    }

    // Get the wallet that made this sell
    const wallet = await prisma.smartWallet.findUnique({
      where: { id: trade.walletId },
      select: {
        id: true,
        address: true,
        score: true,
        label: true,
      },
    });

    if (!wallet) {
      console.log(`   ⏭️  [ExitWarning] Wallet not found for trade ${trade.id}`);
      return null;
    }

    // Check if this wallet bought this token before (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const previousBuy = await prisma.trade.findFirst({
      where: {
        walletId: wallet.id,
        tokenId: token.id,
        side: 'buy',
        timestamp: { gte: sevenDaysAgo },
      },
      select: { id: true },
    });

    if (!previousBuy) {
      console.log(`   ⏭️  [ExitWarning] Wallet ${wallet.label || wallet.address.substring(0, 8)} didn't buy ${token.symbol} recently - skipping`);
      return null;
    }

    // Get total bought and sold for this wallet/token
    const [buyTotal, sellTotal] = await Promise.all([
      prisma.trade.aggregate({
        where: { walletId: wallet.id, tokenId: token.id, side: 'buy' },
        _sum: { amountToken: true },
      }),
      prisma.trade.aggregate({
        where: { walletId: wallet.id, tokenId: token.id, side: 'sell' },
        _sum: { amountToken: true },
      }),
    ]);

    const totalBoughtTokens = Number(buyTotal._sum.amountToken || 0);
    const totalSoldTokens = Number(sellTotal._sum.amountToken || 0);
    const remainingTokens = Math.max(0, totalBoughtTokens - totalSoldTokens);

    // Get MCap from trade meta if available, otherwise use current
    let sellMcap = marketData.marketCap;
    if (trade.meta && typeof trade.meta === 'object') {
      const meta = trade.meta as any;
      if (meta.marketCapUsd) sellMcap = meta.marketCapUsd;
      else if (meta.marketCap) sellMcap = meta.marketCap;
    }

    const sellAmountUsd = Number(trade.valueUsd || 0);
    const sellAmountTokens = Number(trade.amountToken || 0);
    const walletScore = wallet.score || 0;

    console.log(`   🚨 [ExitWarning] INSTANT SELL: ${wallet.label || wallet.address.substring(0, 8)} sold ${token.symbol} for $${sellAmountUsd.toFixed(0)} @ $${(sellMcap / 1000).toFixed(1)}K MCap (score: ${walletScore})`);

    // Determine strength based on wallet score and sell size
    const isHighScoreWallet = walletScore >= 70;
    const isSignificantSell = sellAmountUsd >= 100 || (totalBoughtTokens > 0 && sellAmountTokens / totalBoughtTokens >= 0.25);

    const strength = isHighScoreWallet && isSignificantSell ? 'strong' : 'medium';
    const confidence = Math.min(90, 50 + walletScore / 2 + (isSignificantSell ? 15 : 0));

    // Context for this single sell
    const exitContext = {
      ...context,
      exitSellerCount: 1,
      exitSellerNames: wallet.label || wallet.address.substring(0, 8),
      exitTotalBuyers: 1,
      currentMarketCapUsd: sellMcap,
      // Single seller data for Discord
      exitSellers: [{
        walletId: wallet.id,
        address: wallet.address,
        label: wallet.label,
        score: walletScore,
        totalSoldUsd: sellAmountUsd,
        totalSoldTokens: sellAmountTokens,
        totalBoughtTokens,
        remainingTokens,
        lastSellTime: trade.timestamp,
        sellCount: 1,
        // This single sell with its own MCap
        sells: [{
          amountUsd: sellAmountUsd,
          amountTokens: sellAmountTokens,
          timestamp: trade.timestamp,
          marketCapUsd: sellMcap, // MCap at time of THIS sell
        }],
      }],
    };

    return {
      type: 'exit-warning',
      strength,
      confidence,
      reasoning: `🔴 ${wallet.label || wallet.address.substring(0, 8)} [${walletScore}] sold ${token.symbol} - $${sellAmountUsd.toFixed(0)} @ $${(sellMcap / 1000).toFixed(1)}K MCap`,
      context: exitContext,
      suggestedAction: 'sell',
      riskLevel: isHighScoreWallet ? 'high' : 'medium',
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
   * 📦 Accumulation Detection (Enhanced with tier system and market cap filter)
   * Wallet postupně akumuluje pozici - používá tier prahy (WEAK/MEDIUM/STRONG)
   */
  private async detectAccumulation(
    trade: any,
    wallet: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    // Fetch token market data first for market cap filtering
    let marketData = {
      marketCap: null as number | null,
      liquidity: null as number | null,
      volume24h: null as number | null,
    };

    // PRIMÁRNĚ: použij MCap z trade.meta (bonding curve), pak Birdeye API
    if (token?.mintAddress) {
      try {
        const tradeMeta = trade.meta as any;
        marketData = await this.tokenMarketData.getMarketDataWithTradeMeta(token.mintAddress, tradeMeta);
      } catch (e) {
        console.warn(`   ⚠️  [Accumulation] Failed to fetch market data for ${token.symbol || token.mintAddress}`);
      }
    }

    // Get SOL price for USDC/USDT conversion
    let solPriceUsd = 125.0; // Fallback
    try {
      solPriceUsd = await this.solPriceCacheService.getCurrentSolPrice();
    } catch (error: any) {
      console.warn(`   ⚠️  [Accumulation] Failed to fetch SOL price, using fallback: $${solPriceUsd}`);
    }

    // FILTER: Unknown or empty token symbol - don't send signals for unidentified tokens
    const tokenSymbol = token?.symbol?.trim() || '';
    if (!tokenSymbol || tokenSymbol.toLowerCase() === 'unknown') {
      console.log(`   ⚠️  [Accumulation] Token symbol is "${tokenSymbol || 'empty'}" - FILTERED OUT`);
      return null;
    }

    // FILTER: Require valid market cap - don't send signals for tokens with unknown MCap
    if (marketData.marketCap === null || marketData.marketCap === undefined) {
      console.log(`   ⚠️  [Accumulation] Token ${tokenSymbol} market cap UNKNOWN - FILTERED OUT`);
      return null;
    }

    // FILTER: Minimum market cap threshold ($20K for all accumulation signals)
    const MIN_MARKET_CAP = 20000;
    if (marketData.marketCap < MIN_MARKET_CAP) {
      console.log(`   ⚠️  [Accumulation] Token ${tokenSymbol} market cap $${(marketData.marketCap / 1000).toFixed(1)}K < $${(MIN_MARKET_CAP / 1000).toFixed(0)}K minimum - FILTERED OUT`);
      return null;
    }

    // FILTER: Quality filters - RUGCHECK DISABLED FOR LATENCY OPTIMIZATION
    // To re-enable: remove the `false &&` condition below
    let rugCheckReport = null;
    if (false && token?.mintAddress) {
      try {
        const rugCheckService = new RugCheckService();
        rugCheckReport = await rugCheckService.getReport(token.mintAddress);
      } catch (e) {
        console.warn(`   ⚠️  [Accumulation] Failed to fetch RugCheck for ${tokenSymbol}`);
      }
    }

    // QUALITY FILTER DISABLED FOR LATENCY OPTIMIZATION
    // To re-enable: remove the `false &&` condition below
    if (false) {
      const qualityCheck = signalQualityFilter.checkSignalQuality(marketData, rugCheckReport);
      if (!qualityCheck.passed) {
        console.log(`   ⚠️  [Accumulation] Token ${tokenSymbol} QUALITY FILTER FAILED: ${qualityCheck.reason}`);
        return null;
      }
    }

    // Try each tier from strongest to weakest
    const tiers: Array<{ name: 'STRONG' | 'MEDIUM' | 'WEAK'; config: any }> = [
      { name: 'STRONG', config: SIGNAL_TIERS.ACCUMULATION.STRONG },
      { name: 'MEDIUM', config: SIGNAL_TIERS.ACCUMULATION.MEDIUM },
      { name: 'WEAK', config: SIGNAL_TIERS.ACCUMULATION.WEAK },
    ];

    for (const { name: tierName, config } of tiers) {
      // Check wallet score threshold
      if (wallet.score < config.minWalletScore) {
        continue; // Try next (weaker) tier
      }

      // Find all BUY trades for this wallet+token in time window
      const timeWindowMs = config.timeWindowHours * 60 * 60 * 1000;
      const cutoffTime = new Date(Date.now() - timeWindowMs);

      const recentBuys = await prisma.trade.findMany({
        where: {
          walletId: wallet.id,
          tokenId: token.id,
          side: 'buy',
          timestamp: { gte: cutoffTime },
        },
        select: {
          id: true,
          amountBase: true,
          timestamp: true,
          meta: true,
        },
        orderBy: { timestamp: 'asc' },
      });

      if (!recentBuys || recentBuys.length < config.minBuys) {
        continue; // Try next tier
      }

      // Filter buys by minimum size per buy (convert to SOL if needed)
      const validBuys = recentBuys.filter(t => {
        const amountBase = Number(t.amountBase) || 0;
        if (amountBase <= 0) return false;

        const meta = t.meta as any;
        const baseToken = (meta?.baseToken || 'SOL').toUpperCase();

        let amountInSol = amountBase;
        if (baseToken === 'USDC' || baseToken === 'USDT') {
          amountInSol = amountBase / solPriceUsd;
        }

        return amountInSol >= config.minSizePerBuy;
      });

      if (validBuys.length < config.minBuys) {
        continue; // Try next tier
      }

      // Calculate total amount in SOL
      const totalAmountSol = validBuys.reduce((sum, t) => {
        const amountBase = Number(t.amountBase) || 0;
        const meta = t.meta as any;
        const baseToken = (meta?.baseToken || 'SOL').toUpperCase();
        let amountInSol = amountBase;
        if (baseToken === 'USDC' || baseToken === 'USDT') {
          amountInSol = amountBase / solPriceUsd;
        }
        return sum + amountInSol;
      }, 0);

      if (totalAmountSol < config.minTotalSize) {
        continue; // Try next tier
      }

      // This tier matches! Generate signal
      const buyCount = validBuys.length;
      const strength = tierName === 'STRONG' ? 'strong' : tierName === 'MEDIUM' ? 'medium' : 'weak';
      const confidence = Math.min(90, 50 + buyCount * 8 + wallet.score / 5);
      const [minPos, maxPos] = config.positionSizePercent;

      return {
        type: 'accumulation',
        strength,
        confidence,
        reasoning: `📦 Accumulation (${tierName}): ${wallet.label || 'Wallet'} (score ${wallet.score.toFixed(0)}) akumuluje ${token.symbol || 'token'} - ${buyCount} nákupů (${totalAmountSol.toFixed(2)} SOL total) za ${config.timeWindowHours}h${marketData.marketCap ? `, MCap $${(marketData.marketCap / 1000).toFixed(0)}K` : ''}`,
        context,
        suggestedAction: 'buy',
        suggestedPositionPercent: Math.floor((minPos + maxPos) / 2),
        riskLevel: tierName === 'STRONG' ? 'low' : tierName === 'MEDIUM' ? 'medium' : 'medium',
      };
    }

    // No tier matched
    return null;
  }

  /**
   * 💪 Conviction Buy Detection (Enhanced with tier system and market cap filter)
   * Trader nakupuje významně více než obvykle = vysoká conviction
   */
  private async detectConvictionBuy(
    trade: any,
    wallet: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    // Fetch token market data for market cap filtering
    // PRIMÁRNĚ: použij MCap z trade.meta (bonding curve), pak Birdeye API
    let marketData = {
      marketCap: null as number | null,
    };

    if (token?.mintAddress) {
      try {
        const tradeMeta = trade.meta as any;
        marketData = await this.tokenMarketData.getMarketDataWithTradeMeta(token.mintAddress, tradeMeta);
      } catch (e) {
        console.warn(`   ⚠️  [ConvictionBuy] Failed to fetch market data for ${token.symbol || token.mintAddress}`);
      }
    }

    // FILTER: Unknown or empty token symbol - don't send signals for unidentified tokens
    const tokenSymbol = token?.symbol?.trim() || '';
    if (!tokenSymbol || tokenSymbol.toLowerCase() === 'unknown') {
      console.log(`   ⚠️  [ConvictionBuy] Token symbol is "${tokenSymbol || 'empty'}" - FILTERED OUT`);
      return null;
    }

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

    // Check market cap threshold (filter out low market cap tokens)
    // IMPORTANT: If market cap is unknown (null), don't create signal (safety first)
    if (marketData.marketCap === null || marketData.marketCap === undefined) {
      console.log(`   ⚠️  [ConvictionBuy] Token ${token.symbol} market cap UNKNOWN - FILTERED OUT (no signal without verified mcap)`);
      return null;
    }
    if (marketData.marketCap < tierConfig.minMarketCap) {
      console.log(`   ⚠️  [ConvictionBuy] Token ${token.symbol} market cap $${(marketData.marketCap / 1000).toFixed(1)}K < $${(tierConfig.minMarketCap / 1000).toFixed(0)}K minimum - FILTERED OUT`);
      return null;
    }

    // FILTER: Quality filters - RUGCHECK DISABLED FOR LATENCY OPTIMIZATION
    // To re-enable: remove the `false &&` condition below
    let rugCheckReport = null;
    if (false && token?.mintAddress) {
      try {
        const rugCheckService = new RugCheckService();
        rugCheckReport = await rugCheckService.getReport(token.mintAddress);
      } catch (e) {
        console.warn(`   ⚠️  [ConvictionBuy] Failed to fetch RugCheck for ${token.symbol}`);
      }
    }

    // QUALITY FILTER DISABLED FOR LATENCY OPTIMIZATION
    // To re-enable: remove the `if (false)` block below
    if (false) {
      const qualityCheck = signalQualityFilter.checkSignalQuality(marketData, rugCheckReport);
      if (!qualityCheck.passed) {
        console.log(`   ⚠️  [ConvictionBuy] Token ${token.symbol} QUALITY FILTER FAILED: ${qualityCheck.reason}`);
        return null;
      }
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
    // PRIMÁRNĚ: použij MCap z trade.meta (bonding curve), pak Birdeye API
    let marketData = {
      marketCap: null as number | null,
      liquidity: null as number | null,
      volume24h: null as number | null,
      tokenAgeMinutes: null as number | null,
    };

    if (token?.mintAddress) {
      try {
        const tradeMeta = trade.meta as any;
        marketData = await this.tokenMarketData.getMarketDataWithTradeMeta(token.mintAddress, tradeMeta);
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

      // AI Evaluation - DISABLED FOR LATENCY OPTIMIZATION
    // To re-enable: remove the `false &&` condition below
    let sharedAIDecision: any = null;
    if (false && process.env.GROQ_API_KEY && bestSignalForAI && bestSignalForAI.suggestedAction === 'buy' && bestSignalForAI.confidence >= 50) {
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
      } else if (false && !process.env.GROQ_API_KEY) {
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

        // Create signal performance tracking record for conviction-buy and accumulation
        if (['conviction-buy', 'accumulation'].includes(signal.type) && signal.suggestedAction === 'buy') {
          try {
            await this.signalPerformance.createPerformanceRecord(
              saved.id,
              trade.tokenId,
              signal.entryPriceUsd || 0
            );
            console.log(`   📊 [SignalPerformance] Created performance record for ${signal.type} signal: ${saved.id.substring(0, 16)}...`);
          } catch (perfError: any) {
            console.warn(`   ⚠️  Signal performance record creation failed: ${perfError.message}`);
          }
        }

        // Send Discord notification using centralized filter
        // Filter rules are defined in signal-filter.service.ts
        const filterResult = signalFilter.shouldProcessSignal(signal);

        if (filterResult.passed) {
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
              // Kontrola: pokud jsme pro tento token už zpracovali novější nebo stejné nákupy, přeskoč
              // Toto zabraňuje opakovanému posílání signálů pro stejné staré nákupy
              const lastProcessedTime = this.lastProcessedAccumulationTrade.get(token.id);
              const tradeTime = new Date(trade.timestamp);
              if (lastProcessedTime && tradeTime <= lastProcessedTime) {
                console.log(`⏳ [Accumulation] Skipping ${token.symbol} - trade already processed (trade: ${tradeTime.toISOString()}, last: ${lastProcessedTime.toISOString()})`);
                continue;
              }

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
                // RUGCHECK DISABLED FOR LATENCY OPTIMIZATION
                // To re-enable: remove the `false &&` condition below
                let securityData: SignalNotificationData['security'] | undefined;
                if (false) {
                  try {
                    const rugReport = await this.rugCheck.getReport(token?.mintAddress || '');
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
                      console.log(`   🛡️  [Accumulation] RugCheck: ${rugReport.riskLevel} (${rugReport.riskScore}/100)${rugReport.isHoneypot ? ' 🍯 HONEYPOT!' : ''}`);
                    }
                  } catch (rugError: any) {
                    console.warn(`   ⚠️  [Accumulation] RugCheck failed: ${rugError.message}`);
                  }
                }

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
                  securityData,
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

            // RUGCHECK DISABLED FOR LATENCY OPTIMIZATION
            // To re-enable: remove the `if (false)` block below
            let securityData: SignalNotificationData['security'] | undefined;
            if (false) {
              try {
                const rugReport = await this.rugCheck.getReport(token?.mintAddress || '');
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
                  console.log(`   🛡️  [${signal.type}] RugCheck: ${rugReport.riskLevel} (${rugReport.riskScore}/100)${rugReport.isHoneypot ? ' 🍯 HONEYPOT!' : ''}`);
                }
              } catch (rugError: any) {
                console.warn(`   ⚠️  [${signal.type}] RugCheck failed: ${rugError.message}`);
              }
            }

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
                // Pro conviction signál: průměrná velikost a multiplier
                avgTradeSize: signal.type === 'conviction-buy' ? signal.context.walletAvgPositionUsd : undefined,
                convictionMultiplier: signal.type === 'conviction-buy' ? (
                  signal.context.walletAvgPositionUsd && signal.context.walletAvgPositionUsd > 0
                    ? signal.context.positionSizeUsd! / signal.context.walletAvgPositionUsd
                    : undefined
                ) : undefined,
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
              security: securityData,
              // Pro exit-warning: přidej detaily o prodejcích
              exitSellers: signal.type === 'exit-warning' ? signal.context.exitSellers : undefined,
              exitTotalBuyers: signal.type === 'exit-warning' ? signal.context.exitTotalBuyers : undefined,
            };

            console.log(`📨 [AdvancedSignals] About to send Discord notification - baseToken: ${notificationData.baseToken || 'MISSING'}, walletIds: ${notificationData.wallets?.map(w => w.walletId ? 'yes' : 'no').join(',') || 'none'}, aiDecision: ${notificationData.aiDecision || 'undefined'}`);

            // Exit-warning signály jdou do separátního exit kanálu
            if (signal.type === 'exit-warning') {
              console.log(`   🔴 [ExitWarning] Sending to exit channel with ${notificationData.exitSellers?.length || 0} sellers`);
              await this.discordNotification.sendSignalToExitChannel(notificationData);
            } else {
              await this.discordNotification.sendSignalNotification(notificationData);
            }
          } catch (discordError: any) {
            console.warn(`⚠️  Discord notification failed: ${discordError.message}`);
          }
        } else {
          // Signal filtered out by centralized filter
          console.log(`🚫 [SignalFilter] Signal ${signal.type}/${signal.strength} filtered out: ${filterResult.reason}`);
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
        security: pending.securityData,
      };

      await this.discordNotification.sendSignalNotification(notificationData);

      // Ulož timestamp posledního zpracovaného nákupu - zabraň opakovanému odeslání pro stejné staré nákupy
      // Používáme lastTradeTime z pending signálu (nejnovější nákup v této skupině)
      this.lastProcessedAccumulationTrade.set(pending.tokenId, pending.lastTradeTime);
      console.log(`✅ [Accumulation] Signal sent for ${pending.tokenSymbol} - last trade: ${pending.lastTradeTime.toISOString()}`);

      // Cleanup starých záznamů (starší než 24 hodin) - držíme historii delší dobu
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      for (const [tokenId, timestamp] of this.lastProcessedAccumulationTrade.entries()) {
        if (timestamp < oneDayAgo) {
          this.lastProcessedAccumulationTrade.delete(tokenId);
        }
      }
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

