/**
 * Advanced Signals Service
 * 
 * Generuje různé typy signálů nad rámec základního consensus:
 * - Whale Entry: Top trader nakoupí velkou pozici
 * - Early Sniper: Smart wallet jako první koupí nový token
 * - Momentum: Price/volume spike + smart wallet entry
 * - Re-entry: Wallet znovu kupuje token kde předtím profitovala
 * - Exit Warning: Více wallets začne prodávat
 * - Hot Token: 3+ wallets s avg score >70 koupí stejný token
 * - Accumulation: Wallet postupně akumuluje pozici
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
import { prisma } from '../lib/prisma.js';

// Signal type definitions
export type AdvancedSignalType = 
  | 'whale-entry'
  | 'early-sniper'
  | 'momentum'
  | 're-entry'
  | 'exit-warning'
  | 'hot-token'
  | 'accumulation'
  | 'consensus'
  | 'conviction-buy'    // Trader buys >2x their average trade size
  | 'large-position'    // Trader has significant % of supply
  | 'volume-spike'      // Token has unusual high volume
  | 'consensus-update'; // New wallet joined existing consensus

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

// Thresholds for signal generation (relaxed for more signals)
const THRESHOLDS = {
  WHALE_MIN_SCORE: 70,                    // Was 80
  WHALE_MIN_POSITION_MULTIPLIER: 1.5,     // Was 2 - 1.5x their average position
  EARLY_SNIPER_MAX_TOKEN_AGE_MINUTES: 60, // Was 30 - up to 1 hour old
  EARLY_SNIPER_MIN_WALLET_SCORE: 55,      // Was 65
  MOMENTUM_MIN_PRICE_CHANGE_5M: 5,        // Was 10% - 5% price change
  MOMENTUM_MIN_VOLUME_SPIKE: 2,           // Was 3 - 2x normal volume
  REENTRY_MIN_PREVIOUS_PNL: 10,           // Was 20% - 10% profit on previous trade
  EXIT_WARNING_MIN_SELLERS: 2,
  HOT_TOKEN_MIN_WALLETS: 3,
  HOT_TOKEN_MIN_AVG_SCORE: 60,            // Was 70
  ACCUMULATION_MIN_BUYS: 2,               // Was 3
  ACCUMULATION_TIME_WINDOW_HOURS: 12,     // Was 6
  // New thresholds
  CONVICTION_BUY_MULTIPLIER: 2,           // Trade size >2x average = conviction
  CONVICTION_MIN_WALLET_SCORE: 60,        // Wallet must have decent score
  VOLUME_SPIKE_MULTIPLIER: 5,             // 5x normal volume = spike
  VOLUME_SPIKE_MIN_USD: 50000,            // Minimum $50k volume to trigger
  LARGE_POSITION_MIN_USD: 1000,           // $1000+ position
};

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
        positionSizeUsd: Number(trade.amountBase || 0) * 150, // Rough SOL->USD conversion
      };

      // Spusť všechny detektory paralelně
      if (trade.side === 'buy') {
        const [
          whaleSignal,
          sniperSignal,
          momentumSignal,
          reentrySignal,
          hotTokenSignal,
          accumulationSignal,
          convictionSignal,
          volumeSpikeSignal,
        ] = await Promise.all([
          this.detectWhaleEntry(trade, wallet, context),
          this.detectEarlySniper(trade, wallet, token, context),
          this.detectMomentum(trade, wallet, token, context),
          this.detectReentry(trade, wallet, token, context),
          this.detectHotToken(trade, token, context),
          this.detectAccumulation(trade, wallet, token, context),
          this.detectConvictionBuy(trade, wallet, token, context),
          this.detectVolumeSpike(trade, wallet, token, context),
        ]);

        if (whaleSignal) signals.push(whaleSignal);
        if (sniperSignal) signals.push(sniperSignal);
        if (momentumSignal) signals.push(momentumSignal);
        if (reentrySignal) signals.push(reentrySignal);
        if (hotTokenSignal) signals.push(hotTokenSignal);
        if (accumulationSignal) signals.push(accumulationSignal);
        if (convictionSignal) signals.push(convictionSignal);
        if (volumeSpikeSignal) signals.push(volumeSpikeSignal);
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

    context.walletAvgPositionUsd = avgPosition * 150;

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
   * 📉 Exit Warning Detection
   * Více smart wallets začne prodávat stejný token
   */
  private async detectExitWarning(
    trade: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    // Najdi všechny SELL trades na tento token v posledních 2h
    const recentSells = await prisma.trade.findMany({
      where: {
        tokenId: token.id,
        side: 'sell',
        timestamp: { gte: twoHoursAgo },
      },
      select: { walletId: true },
    });

    if (!recentSells) {
      return null;
    }

    const uniqueSellers = new Set(recentSells.map(t => t.walletId));
    const sellerCount = uniqueSellers.size;

    if (sellerCount < THRESHOLDS.EXIT_WARNING_MIN_SELLERS) {
      return null;
    }

    const strength = sellerCount >= 4 ? 'strong' : sellerCount >= 3 ? 'medium' : 'weak';
    const confidence = Math.min(85, 40 + sellerCount * 15);

    return {
      type: 'exit-warning',
      strength,
      confidence,
      reasoning: `📉 Exit Warning: ${sellerCount} smart wallets prodává ${token.symbol || 'token'} v posledních 2h`,
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
      },
      orderBy: { timestamp: 'asc' },
    });

    if (!recentBuys || recentBuys.length < THRESHOLDS.ACCUMULATION_MIN_BUYS) {
      return null;
    }

    const totalAmount = recentBuys.reduce((sum, t) => sum + Number(t.amountBase), 0);
    const buyCount = recentBuys.length;

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
   * 💪 Conviction Buy Detection
   * Trader nakupuje >2x více než je jeho průměr = vysoká conviction
   */
  private async detectConvictionBuy(
    trade: any,
    wallet: any,
    token: any,
    context: SignalContext
  ): Promise<AdvancedSignal | null> {
    if (wallet.score < THRESHOLDS.CONVICTION_MIN_WALLET_SCORE) {
      return null;
    }

    // Získej průměrnou velikost trade této wallet
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

    if (multiplier < THRESHOLDS.CONVICTION_BUY_MULTIPLIER) {
      return null;
    }

    // Přidej do context
    context.walletAvgPositionUsd = avgTradeSize * 150; // Rough SOL->USD
    context.positionSizeUsd = currentTradeSize * 150;

    const strength = multiplier >= 5 ? 'strong' : multiplier >= 3 ? 'medium' : 'weak';
    const confidence = Math.min(95, 55 + multiplier * 8 + wallet.score / 5);

    return {
      type: 'conviction-buy',
      strength,
      confidence,
      reasoning: `💪 Conviction Buy: ${wallet.label || 'Trader'} (score ${wallet.score.toFixed(0)}) nakoupil ${multiplier.toFixed(1)}x více než obvykle (${currentTradeSize.toFixed(2)} SOL vs avg ${avgTradeSize.toFixed(2)} SOL)`,
      context,
      suggestedAction: 'buy',
      suggestedPositionPercent: Math.min(20, strength === 'strong' ? 15 : strength === 'medium' ? 10 : 7),
      riskLevel: multiplier >= 4 ? 'low' : 'medium', // Vysoká conviction = nižší risk
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
        model: signal.type as any, // Extended model type
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

    // Calculate entry price
    const entryPriceUsd = Number(trade.priceBasePerToken || 0);

    let savedCount = 0;
    let aiEvaluated = 0;

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

      // AI Evaluation (if GROQ_API_KEY is set)
      if (process.env.GROQ_API_KEY && signal.suggestedAction === 'buy') {
        try {
          const aiContext: AIContext = {
            signal,
            signalType: signal.type,
            walletScore: signal.context.walletScore,
            walletWinRate: signal.context.walletWinRate,
            walletRecentPnl30d: signal.context.walletRecentPnl30d,
            walletTotalTrades: signal.context.walletTotalTrades || 0,
            walletAvgHoldTimeMin: signal.context.walletAvgHoldTimeMin || 60,
            tokenSymbol: signal.context.tokenSymbol,
            tokenAge: signal.context.tokenAge,
            tokenLiquidity: signal.context.tokenLiquidity,
            tokenVolume24h: signal.context.tokenVolume24h,
            tokenMarketCap: signal.context.tokenMarketCap,
            otherWalletsCount: signal.context.consensusWalletCount,
            consensusStrength: signal.strength,
          };

          const aiResult = await this.aiDecision.evaluateSignal(signal, aiContext);
          signal.aiDecision = aiResult;
          aiEvaluated++;

          // Update SL/TP based on AI recommendation
          if (aiResult.decision === 'buy' && entryPriceUsd > 0) {
            signal.stopLossPriceUsd = entryPriceUsd * (1 - (aiResult.stopLossPercent || 25) / 100);
            signal.takeProfitPriceUsd = entryPriceUsd * (1 + (aiResult.takeProfitPercent || 50) / 100);
            signal.suggestedHoldTimeMinutes = aiResult.expectedHoldTimeMinutes;
            signal.suggestedPositionPercent = aiResult.suggestedPositionPercent;
          }

          console.log(`🤖 AI evaluated ${signal.type}: ${aiResult.decision} (${aiResult.confidence}% confidence)`);
        } catch (aiError: any) {
          console.warn(`⚠️  AI evaluation failed: ${aiError.message}`);
        }
      }

      // Save enhanced signal
      const saved = await this.saveEnhancedSignal(trade, signal, marketData);
      if (saved) {
        savedCount++;
        
        // Send Discord notification for BUY signals
        if (signal.suggestedAction === 'buy') {
          try {
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
              aiDecision: signal.aiDecision?.decision,
              aiConfidence: signal.aiDecision?.confidence,
              aiReasoning: signal.aiDecision?.reasoning,
              aiPositionPercent: signal.aiDecision?.suggestedPositionPercent,
              stopLossPercent: signal.aiDecision?.stopLossPercent,
              takeProfitPercent: signal.aiDecision?.takeProfitPercent,
              stopLossPriceUsd: signal.stopLossPriceUsd,
              takeProfitPriceUsd: signal.takeProfitPriceUsd,
              aiRiskScore: signal.aiDecision?.riskScore,
              wallets: [{
                label: wallet?.label,
                address: wallet?.address || '',
                score: wallet?.score || 0,
                tradeAmountUsd: Number(trade.amountBase || 0),
                tradePrice: Number(trade.priceBasePerToken || 0),
                tradeTime: trade.timestamp.toISOString(),
              }],
            };
            
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
        model: signal.type,
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
        model: signal.type as any,
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

