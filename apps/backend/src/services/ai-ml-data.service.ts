import { TradeRepository } from '../repositories/trade.repository.js';
import { TradeSequenceRepository, TradeSequenceData } from '../repositories/trade-sequence.repository.js';
import { TradeOutcomeRepository, TradeOutcomeData } from '../repositories/trade-outcome.repository.js';
import { TradeFeatureRepository } from '../repositories/trade-feature.repository.js';
import { TokenPriceService } from './token-price.service.js';
import { BinancePriceService } from './binance-price.service.js';
import { supabase, TABLES } from '../lib/supabase.js';
import type { TraderCharacterizationService } from './trader-characterization.service.js';

/**
 * Service pro výpočet AI/ML dat - sequence patterns, outcomes, market context
 * SEPAROVÁNO od současných fungujících věcí - pouze pro AI/ML trénink
 */
export class AiMlDataService {
  constructor(
    private tradeRepo: TradeRepository,
    private tradeSequenceRepo: TradeSequenceRepository,
    private tradeOutcomeRepo: TradeOutcomeRepository,
    private tradeFeatureRepo: TradeFeatureRepository,
    private tokenPriceService: TokenPriceService,
    private binancePriceService: BinancePriceService,
    private traderCharacterizationService?: TraderCharacterizationService
  ) {}

  /**
   * Vypočítá sequence data pro trade
   */
  async calculateSequenceData(tradeId: string, walletId: string): Promise<void> {
    // Načti trade podle ID
    const { data: tradeData, error } = await supabase
      .from(TABLES.TRADE)
      .select('*')
      .eq('id', tradeId)
      .single();

    if (error || !tradeData) {
      console.warn(`Trade not found: ${tradeId}`);
      return;
    }

    const trade = tradeData as any;
    if (!trade) {
      console.warn(`Trade not found: ${tradeId}`);
      return;
    }

    // Načti všechny trades pro walletku, seřazené podle času
    const allTrades = await this.tradeRepo.findAllForMetrics(walletId);
    const sortedTrades = allTrades.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const currentTradeIndex = sortedTrades.findIndex(t => t.id === trade.id);
    if (currentTradeIndex === -1) {
      console.warn(`Trade not found in wallet trades: ${tradeId}`);
      return;
    }

    const currentTrade = sortedTrades[currentTradeIndex];
    const currentTimestamp = new Date(currentTrade.timestamp);

    // Sequence context
    const sequenceIndex = currentTradeIndex + 1;
    const sequenceLength = sortedTrades.length;

    // Time since last trade
    let timeSinceLastTradeSeconds: number | null = null;
    if (currentTradeIndex > 0) {
      const previousTrade = sortedTrades[currentTradeIndex - 1];
      const previousTimestamp = new Date(previousTrade.timestamp);
      timeSinceLastTradeSeconds = Math.floor((currentTimestamp.getTime() - previousTimestamp.getTime()) / 1000);
    }

    // Time since last token trade
    let timeSinceLastTokenTradeSeconds: number | null = null;
    let previousTokenId: string | null = null;
    for (let i = currentTradeIndex - 1; i >= 0; i--) {
      if (sortedTrades[i].tokenId === currentTrade.tokenId) {
        const previousTokenTrade = sortedTrades[i];
        const previousTokenTimestamp = new Date(previousTokenTrade.timestamp);
        timeSinceLastTokenTradeSeconds = Math.floor((currentTimestamp.getTime() - previousTokenTimestamp.getTime()) / 1000);
        break;
      }
    }

    // Token switching patterns
    const isTokenSwitch = currentTradeIndex > 0 && sortedTrades[currentTradeIndex - 1].tokenId !== currentTrade.tokenId;
    if (isTokenSwitch && currentTradeIndex > 0) {
      previousTokenId = sortedTrades[currentTradeIndex - 1].tokenId;
    }

    // Tokens in sequence (unique tokens in last 10 trades)
    const recentTrades = sortedTrades.slice(Math.max(0, currentTradeIndex - 9), currentTradeIndex + 1);
    const uniqueTokens = new Set(recentTrades.map(t => t.tokenId));
    const tokensInSequence = uniqueTokens.size;

    // Position sizing patterns
    let positionSizeChangePercent: number | null = null;
    if (currentTradeIndex > 0) {
      const previousTrade = sortedTrades[currentTradeIndex - 1];
      const previousAmountUsd = Number(previousTrade.valueUsd || 0);
      const currentAmountUsd = Number(currentTrade.valueUsd || 0);
      if (previousAmountUsd > 0) {
        positionSizeChangePercent = ((currentAmountUsd - previousAmountUsd) / previousAmountUsd) * 100;
      }
    }

    // Average position size in sequence
    const recentAmountsUsd = recentTrades
      .map(t => Number(t.valueUsd || 0))
      .filter(v => v > 0);
    const avgPositionSizeUsd = recentAmountsUsd.length > 0
      ? recentAmountsUsd.reduce((sum, v) => sum + v, 0) / recentAmountsUsd.length
      : null;

    // Trading frequency
    const oneHourAgo = new Date(currentTimestamp.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(currentTimestamp.getTime() - 24 * 60 * 60 * 1000);
    
    const tradesInLastHour = sortedTrades.filter(t => {
      const tradeTime = new Date(t.timestamp);
      return tradeTime >= oneHourAgo && tradeTime < currentTimestamp;
    }).length;

    const tradesInLastDay = sortedTrades.filter(t => {
      const tradeTime = new Date(t.timestamp);
      return tradeTime >= oneDayAgo && tradeTime < currentTimestamp;
    }).length;

    // Ulož sequence data
    const sequenceData: TradeSequenceData = {
      tradeId: trade.id,
      walletId,
      tokenId: currentTrade.tokenId,
      sequenceIndex,
      sequenceLength,
      timeSinceLastTradeSeconds: timeSinceLastTradeSeconds ?? undefined,
      timeSinceLastTokenTradeSeconds: timeSinceLastTokenTradeSeconds ?? undefined,
      isTokenSwitch: isTokenSwitch || false,
      previousTokenId: previousTokenId || undefined,
      tokensInSequence,
      positionSizeChangePercent: positionSizeChangePercent || undefined,
      avgPositionSizeUsd: avgPositionSizeUsd || undefined,
      tradesInLastHour,
      tradesInLastDay,
    };

    await this.tradeSequenceRepo.upsert(sequenceData);
  }

  /**
   * Vypočítá outcome data pro trade (pro BUY trades - jak dopadl)
   */
  async calculateOutcomeData(tradeId: string, walletId: string): Promise<void> {
    // Načti trade podle ID
    const { data: tradeData, error } = await supabase
      .from(TABLES.TRADE)
      .select('*, token:Token(*)')
      .eq('id', tradeId)
      .single();

    if (error || !tradeData) {
      console.warn(`Trade not found: ${tradeId}`);
      return;
    }

    const trade = tradeData as any;
    if (!trade) {
      console.warn(`Trade not found: ${tradeId}`);
      return;
    }

    // Pro SELL trades - použij closed lot data
    if (trade.side === 'sell') {
      const { data: closedLots } = await supabase
        .from(TABLES.CLOSED_LOT)
        .select('*')
        .eq('walletId', walletId)
        .eq('tokenMint', (trade as any).token?.mintAddress || '')
        .order('closedAt', { ascending: false })
        .limit(1);

      if (closedLots && closedLots.length > 0) {
        const closedLot = closedLots[0];
        const realizedPnlUsd = Number(closedLot.realizedPnl || 0);
        const realizedPnlPercent = Number(closedLot.realizedRoiPercent || 0);

        // Kategorizuj outcome
        let outcomeType: 'win' | 'loss' | 'breakeven' | 'unknown' = 'unknown';
        let outcomeCategory: 'big_win' | 'small_win' | 'small_loss' | 'big_loss' | 'breakeven' = 'breakeven';

        if (realizedPnlPercent > 5) {
          outcomeType = 'win';
          outcomeCategory = 'big_win';
        } else if (realizedPnlPercent > 0) {
          outcomeType = 'win';
          outcomeCategory = 'small_win';
        } else if (realizedPnlPercent < -10) {
          outcomeType = 'loss';
          outcomeCategory = 'big_loss';
        } else if (realizedPnlPercent < 0) {
          outcomeType = 'loss';
          outcomeCategory = 'small_loss';
        } else {
          outcomeType = 'breakeven';
          outcomeCategory = 'breakeven';
        }

        const outcomeData: TradeOutcomeData = {
          tradeId: trade.id,
          walletId,
          tokenId: trade.tokenId,
          outcomeType,
          outcomeCategory,
          realizedPnlUsd,
          realizedPnlPercent,
          positionClosedAt: new Date(closedLot.closedAt),
          positionHoldTimeSeconds: closedLot.holdTimeMinutes ? closedLot.holdTimeMinutes * 60 : undefined,
          positionFinalPnlUsd: realizedPnlUsd,
          positionFinalPnlPercent: realizedPnlPercent,
        };

        await this.tradeOutcomeRepo.upsert(outcomeData);
      }
    }

    // Pro BUY trades - vypočti token outcome (jak dopadl token po trade)
    if (trade.side === 'buy') {
      try {
        const tradeTimestamp = new Date(trade.timestamp);
        const tokenMint = (trade as any).token?.mintAddress;
        
        if (!tokenMint) {
          return;
        }

        // Získej cenu tokenu v různých časových bodech
        const currentPrice = await this.tokenPriceService.getTokenPrice(tokenMint);
        const tradePrice = Number(trade.priceBasePerToken || 0);

        if (!currentPrice || !tradePrice || tradePrice === 0) {
          return;
        }

        // Vypočti změny ceny (pokud máme historická data)
        // Pro teď použijeme aktuální cenu jako aproximaci
        const priceChangePercent = ((currentPrice - tradePrice) / tradePrice) * 100;

        let tokenOutcome: 'pump' | 'dump' | 'sideways' | 'unknown' = 'unknown';
        if (priceChangePercent > 20) {
          tokenOutcome = 'pump';
        } else if (priceChangePercent < -20) {
          tokenOutcome = 'dump';
        } else if (Math.abs(priceChangePercent) < 5) {
          tokenOutcome = 'sideways';
        }

        const outcomeData: TradeOutcomeData = {
          tradeId: trade.id,
          walletId,
          tokenId: trade.tokenId,
          tokenPriceChange1hPercent: undefined, // TODO: Implementovat historická data
          tokenPriceChange24hPercent: undefined,
          tokenPriceChange7dPercent: undefined,
          tokenOutcome,
        };

        await this.tradeOutcomeRepo.upsert(outcomeData);
      } catch (error) {
        console.warn(`Failed to calculate token outcome for trade ${tradeId}:`, error);
      }
    }
  }

  /**
   * Vypočítá market context features (price momentum, volume spikes)
   */
  async calculateMarketContextFeatures(tradeId: string): Promise<void> {
    // Načti trade feature
    const tradeFeature = await this.tradeFeatureRepo.findByTradeId(tradeId);
    if (!tradeFeature) {
      console.warn(`Trade feature not found: ${tradeId}`);
      return;
    }

    // TODO: Implementovat price momentum a volume spikes
    // Pro teď jen přidáme market regime (bull/bear/sideways)
    try {
      const solPrice = await this.binancePriceService.getCurrentSolPrice();
      
      // Jednoduchá heuristika pro market regime
      // TODO: Vylepšit pomocí historických dat
      let marketRegime: 'bull' | 'bear' | 'sideways' | null = null;
      // Pro teď použijeme sideways jako default
      marketRegime = 'sideways';

      // Počet dalších smart wallets tradingujících stejný token
      const { data: otherTrades } = await supabase
        .from(TABLES.TRADE)
        .select('walletId')
        .eq('tokenId', tradeFeature.tokenId)
        .gte('timestamp', new Date(new Date(tradeFeature.txTimestamp || new Date()).getTime() - 60 * 60 * 1000).toISOString())
        .lte('timestamp', new Date(tradeFeature.txTimestamp || new Date()).toISOString());

      const uniqueWallets = new Set((otherTrades || []).map((t: any) => t.walletId));
      const otherSmartWalletsTradingCount = uniqueWallets.size - 1; // -1 pro aktuální wallet

      // Update trade feature
      await this.tradeFeatureRepo.update(tradeId, {
        marketRegime,
        otherSmartWalletsTradingCount: Math.max(0, otherSmartWalletsTradingCount),
      });
    } catch (error) {
      console.warn(`Failed to calculate market context for trade ${tradeId}:`, error);
    }
  }

  /**
   * Vypočítá všechna AI/ML data pro trade
   */
  async calculateAllAiMlData(tradeId: string, walletId: string): Promise<void> {
    try {
      // Načti trade pro tokenId
      const { data: tradeData } = await supabase
        .from(TABLES.TRADE)
        .select('tokenId')
        .eq('id', tradeId)
        .single();

      const tokenId = tradeData?.tokenId;

      await Promise.all([
        this.calculateSequenceData(tradeId, walletId),
        this.calculateOutcomeData(tradeId, walletId),
        this.calculateMarketContextFeatures(tradeId),
        // Přidej correlation tracking
        tokenId && this.traderCharacterizationService
          ? this.traderCharacterizationService.calculateTradeCorrelation(tradeId, walletId, tokenId)
          : Promise.resolve(),
      ]);
    } catch (error) {
      console.error(`Failed to calculate AI/ML data for trade ${tradeId}:`, error);
    }
  }
}

