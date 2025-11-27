import { TradeRepository } from '../repositories/trade.repository.js';
import { TradeFeatureRepository } from '../repositories/trade-feature.repository.js';
import { TradeOutcomeRepository } from '../repositories/trade-outcome.repository.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';
import { generateId } from '../lib/supabase.js';

/**
 * Service pro automatické charakterizování traderů a correlation tracking
 * SEPAROVÁNO od současných fungujících věcí
 */
export class TraderCharacterizationService {
  constructor(
    private tradeRepo: TradeRepository,
    private tradeFeatureRepo: TradeFeatureRepository,
    private tradeOutcomeRepo: TradeOutcomeRepository,
    private smartWalletRepo: SmartWalletRepository
  ) {}

  /**
   * Vypočítá correlation mezi tradery pro daný token
   */
  async calculateTraderCorrelation(walletId1: string, walletId2: string, tokenId: string): Promise<void> {
    // Načti všechny trades pro oba tradery se stejným tokenem
    const trades1 = await this.tradeRepo.findAllForMetrics(walletId1);
    const trades2 = await this.tradeRepo.findAllForMetrics(walletId2);

    const tokenTrades1 = trades1.filter(t => t.tokenId === tokenId);
    const tokenTrades2 = trades2.filter(t => t.tokenId === tokenId);

    if (tokenTrades1.length === 0 || tokenTrades2.length === 0) {
      return; // Žádné trades se stejným tokenem
    }

    // Najdi všechny případy, kdy tradeovali stejný token
    const tradesTogether: Array<{ trade1: any; trade2: any; timeDiff: number }> = [];

    for (const trade1 of tokenTrades1) {
      for (const trade2 of tokenTrades2) {
        const time1 = new Date(trade1.timestamp).getTime();
        const time2 = new Date(trade2.timestamp).getTime();
        const timeDiff = Math.abs(time1 - time2);

        // Považuj za "together" pokud tradeovali do 24 hodin od sebe
        if (timeDiff <= 24 * 60 * 60 * 1000) {
          tradesTogether.push({ trade1, trade2, timeDiff });
        }
      }
    }

    if (tradesTogether.length === 0) {
      return;
    }

    // Vypočti metriky
    const tradesTogetherCount = tradesTogether.length;
    const firstTradeTogetherAt = tradesTogether
      .map(t => new Date(Math.min(new Date(t.trade1.timestamp).getTime(), new Date(t.trade2.timestamp).getTime())))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const lastTradeTogetherAt = tradesTogether
      .map(t => new Date(Math.max(new Date(t.trade1.timestamp).getTime(), new Date(t.trade2.timestamp).getTime())))
      .sort((a, b) => b.getTime() - a.getTime())[0];

    const avgTimeBetweenTradesSeconds = Math.floor(
      tradesTogether.reduce((sum, t) => sum + t.timeDiff, 0) / tradesTogether.length / 1000
    );

    let sameDirectionCount = 0;
    let oppositeDirectionCount = 0;
    let bothWinCount = 0;
    let bothLossCount = 0;
    let oneWinOneLossCount = 0;

    for (const { trade1, trade2 } of tradesTogether) {
      // Direction
      if (trade1.side === trade2.side) {
        sameDirectionCount++;
      } else {
        oppositeDirectionCount++;
      }

      // Outcomes (pokud máme outcome data)
      const outcome1 = await this.tradeOutcomeRepo.findByTradeId(trade1.id);
      const outcome2 = await this.tradeOutcomeRepo.findByTradeId(trade2.id);

      if (outcome1 && outcome2) {
        const win1 = outcome1.outcomeType === 'win';
        const win2 = outcome2.outcomeType === 'win';

        if (win1 && win2) {
          bothWinCount++;
        } else if (!win1 && !win2 && outcome1.outcomeType !== 'breakeven' && outcome2.outcomeType !== 'breakeven') {
          bothLossCount++;
        } else if ((win1 && !win2) || (!win1 && win2)) {
          oneWinOneLossCount++;
        }
      }
    }

    // Vypočti correlation score (0-1)
    // Vzorec: (sameDirectionCount + bothWinCount) / tradesTogetherCount
    const correlationScore = tradesTogetherCount > 0
      ? (sameDirectionCount + bothWinCount) / (tradesTogetherCount * 2)
      : 0;

    // Ulož nebo aktualizuj correlation
    const { data: existing } = await supabase
      .from(TABLES.TRADER_CORRELATION)
      .select('id')
      .eq('walletId1', walletId1)
      .eq('walletId2', walletId2)
      .eq('tokenId', tokenId)
      .single();

    const payload = {
      id: existing?.id || generateId(),
      walletId1,
      walletId2,
      tokenId,
      tradesTogetherCount,
      firstTradeTogetherAt: firstTradeTogetherAt.toISOString(),
      lastTradeTogetherAt: lastTradeTogetherAt.toISOString(),
      avgTimeBetweenTradesSeconds,
      sameDirectionCount,
      oppositeDirectionCount,
      bothWinCount,
      bothLossCount,
      oneWinOneLossCount,
      correlationScore: correlationScore.toString(),
      updatedAt: new Date().toISOString(),
    };

    if (existing) {
      await supabase
        .from(TABLES.TRADER_CORRELATION)
        .update(payload)
        .eq('id', existing.id);
    } else {
      await supabase
        .from(TABLES.TRADER_CORRELATION)
        .insert({ ...payload, createdAt: new Date().toISOString() });
    }
  }

  /**
   * Vylepšený výpočet correlation pro trade (kolik dalších tradery tradeuje stejný token)
   */
  async calculateTradeCorrelation(tradeId: string, walletId: string, tokenId: string): Promise<void> {
    const trade = await this.tradeRepo.findBySignature(tradeId);
    if (!trade) {
      return;
    }

    const tradeTimestamp = new Date(trade.timestamp);
    const oneHourAgo = new Date(tradeTimestamp.getTime() - 60 * 60 * 1000);
    const oneDayAgo = new Date(tradeTimestamp.getTime() - 24 * 60 * 60 * 1000);

    // Najdi všechny ostatní tradery, kteří tradeovali stejný token
    const { data: otherTrades } = await supabase
      .from(TABLES.TRADE)
      .select('walletId, timestamp')
      .eq('tokenId', tokenId)
      .neq('walletId', walletId)
      .lte('timestamp', tradeTimestamp.toISOString());

    if (!otherTrades || otherTrades.length === 0) {
      // Žádní jiní tradery
      await this.tradeFeatureRepo.update(tradeId, {
        otherSmartWalletsTradingSameTokenCount: 0,
        otherSmartWalletsTradingSameTokenWithin1h: 0,
        otherSmartWalletsTradingSameTokenWithin24h: 0,
        avgTimeSinceOtherTradersTradeSeconds: null,
        copyTraderScore: null,
      });
      return;
    }

    const uniqueWallets = new Set(otherTrades.map(t => t.walletId));
    const otherSmartWalletsTradingSameTokenCount = uniqueWallets.size;

    // Trades within 1h
    const tradesWithin1h = otherTrades.filter(t => {
      const tTime = new Date(t.timestamp);
      return tTime >= oneHourAgo && tTime < tradeTimestamp;
    });
    const otherSmartWalletsTradingSameTokenWithin1h = new Set(tradesWithin1h.map(t => t.walletId)).size;

    // Trades within 24h
    const tradesWithin24h = otherTrades.filter(t => {
      const tTime = new Date(t.timestamp);
      return tTime >= oneDayAgo && tTime < tradeTimestamp;
    });
    const otherSmartWalletsTradingSameTokenWithin24h = new Set(tradesWithin24h.map(t => t.walletId)).size;

    // Average time since other traders traded
    const timeDiffs = otherTrades
      .map(t => Math.floor((tradeTimestamp.getTime() - new Date(t.timestamp).getTime()) / 1000))
      .filter(diff => diff >= 0);
    const avgTimeSinceOtherTradersTradeSeconds = timeDiffs.length > 0
      ? Math.floor(timeDiffs.reduce((sum, diff) => sum + diff, 0) / timeDiffs.length)
      : null;

    // Copy trader score (0-1)
    // Vzorec: pokud tradeuje brzy po jiných traderech (do 1h), má vysoký score
    let copyTraderScore: number | null = null;
    if (tradesWithin1h.length > 0 && avgTimeSinceOtherTradersTradeSeconds !== null) {
      // Score = 1 - (avgTime / 3600), kde 3600 = 1 hodina v sekundách
      // Čím kratší čas, tím vyšší score
      copyTraderScore = Math.max(0, Math.min(1, 1 - (avgTimeSinceOtherTradersTradeSeconds / 3600)));
    }

    await this.tradeFeatureRepo.update(tradeId, {
      otherSmartWalletsTradingSameTokenCount,
      otherSmartWalletsTradingSameTokenWithin1h,
      otherSmartWalletsTradingSameTokenWithin24h,
      avgTimeSinceOtherTradersTradeSeconds: avgTimeSinceOtherTradersTradeSeconds || null,
      copyTraderScore: copyTraderScore !== null ? copyTraderScore.toString() : null,
    });
  }

  /**
   * Vypočítá behavior profile pro tradera a automaticky přidá tagy
   */
  async calculateBehaviorProfile(walletId: string): Promise<void> {
    const wallet = await this.smartWalletRepo.findById(walletId);
    if (!wallet) {
      return;
    }

    // Načti všechny trades a features
    const allTrades = await this.tradeRepo.findAllForMetrics(walletId);
    const features = await this.tradeFeatureRepo.findForWallet(walletId);

    if (allTrades.length === 0) {
      return;
    }

    // Trading style characteristics
    const avgHoldingTime = wallet.avgHoldingTimeMin || 0;
    const isScalper = avgHoldingTime < 30; // Méně než 30 minut
    const isSwingTrader = avgHoldingTime > 1440; // Více než 24 hodin

    // Early adopter - tradeuje nové tokeny
    const newTokenTrades = features.filter(f => (f.tokenAgeSeconds || 0) < 30 * 60).length;
    const isEarlyAdopter = newTokenTrades / features.length > 0.3; // 30%+ nových tokenů

    // Degen - tradeuje low liquidity tokeny
    const lowLiquidityTrades = features.filter(f => (f.liquidityUsd || 0) < 10000).length;
    const isDegen = lowLiquidityTrades / features.length > 0.4; // 40%+ low liquidity

    // Sniper - tradeuje velmi brzy po launch
    const sniperTrades = features.filter(f => (f.tokenAgeSeconds || 0) < 5 * 60).length;
    const isSniper = sniperTrades / features.length > 0.2; // 20%+ velmi nových tokenů

    // Copy trader - vysoký copyTraderScore
    const copyScores = features
      .map(f => f.meta?.copyTraderScore)
      .filter(s => s !== null && s !== undefined) as number[];
    const avgCopyScore = copyScores.length > 0
      ? copyScores.reduce((sum, s) => sum + s, 0) / copyScores.length
      : 0;
    const isCopyTrader = avgCopyScore > 0.5; // Průměrný score > 0.5

    // Momentum trader - tradeuje při momentum
    const momentumTrades = features.filter(f => {
      const trend5m = f.trend5mPercent || 0;
      return Math.abs(trend5m) > 10; // 10%+ změna za 5 min
    }).length;
    const isMomentumTrader = momentumTrades / features.length > 0.3;

    // Risk characteristics
    const avgWinSize = features
      .filter(f => (f.realizedPnlUsd || 0) > 0)
      .map(f => f.realizedPnlUsd || 0)
      .reduce((sum, v) => sum + v, 0) / features.filter(f => (f.realizedPnlUsd || 0) > 0).length || 0;

    const avgLossSize = Math.abs(features
      .filter(f => (f.realizedPnlUsd || 0) < 0)
      .map(f => f.realizedPnlUsd || 0)
      .reduce((sum, v) => sum + v, 0) / features.filter(f => (f.realizedPnlUsd || 0) < 0).length || 0);

    const riskRewardRatio = avgLossSize > 0 ? avgWinSize / avgLossSize : 0;

    let riskTolerance: 'low' | 'medium' | 'high' | 'extreme' = 'medium';
    if (wallet.maxDrawdownPercent > 50) {
      riskTolerance = 'extreme';
    } else if (wallet.maxDrawdownPercent > 30) {
      riskTolerance = 'high';
    } else if (wallet.maxDrawdownPercent < 10) {
      riskTolerance = 'low';
    }

    // Trading frequency
    const daysSinceFirstTrade = (new Date().getTime() - new Date(wallet.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const tradesPerDay = daysSinceFirstTrade > 0 ? wallet.totalTrades / daysSinceFirstTrade : 0;
    let tradingFrequency: 'low' | 'medium' | 'high' | 'very_high' = 'medium';
    if (tradesPerDay > 10) {
      tradingFrequency = 'very_high';
    } else if (tradesPerDay > 5) {
      tradingFrequency = 'high';
    } else if (tradesPerDay < 1) {
      tradingFrequency = 'low';
    }

    // Preferred trading hours
    const hourCounts = new Map<number, number>();
    features.forEach(f => {
      if (f.hourOfDay !== null && f.hourOfDay !== undefined) {
        hourCounts.set(f.hourOfDay, (hourCounts.get(f.hourOfDay) || 0) + 1);
      }
    });
    const sortedHours = Array.from(hourCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([hour]) => hour);

    // Auto-generated tags
    const autoTags: string[] = [];
    if (isSniper) autoTags.push('sniper');
    if (isDegen) autoTags.push('degen');
    if (isScalper) autoTags.push('scalper');
    if (isSwingTrader) autoTags.push('swing-trader');
    if (isCopyTrader) autoTags.push('copy-trader');
    if (isEarlyAdopter) autoTags.push('early-adopter');
    if (isMomentumTrader) autoTags.push('momentum-trader');
    if (riskTolerance === 'extreme') autoTags.push('extreme-risk');
    if (riskTolerance === 'high') autoTags.push('high-risk');
    if (tradingFrequency === 'very_high') autoTags.push('high-frequency');

    // Ulož behavior profile
    const { data: existing } = await supabase
      .from(TABLES.TRADER_BEHAVIOR_PROFILE)
      .select('id')
      .eq('walletId', walletId)
      .single();

    const payload = {
      id: existing?.id || generateId(),
      walletId,
      isSniper,
      isDegen,
      isScalper,
      isSwingTrader,
      isCopyTrader,
      isEarlyAdopter,
      isMomentumTrader,
      isContrarian: false, // TODO: Implementovat
      riskTolerance,
      positionSizingStyle: null, // TODO: Implementovat
      diversificationLevel: null, // TODO: Implementovat
      preferredTradingHours: sortedHours,
      tradingFrequency,
      prefersLowLiquidity: isDegen,
      prefersNewTokens: isEarlyAdopter,
      prefersHighVolume: false, // TODO: Implementovat
      avgWinSize: avgWinSize > 0 ? avgWinSize.toString() : null,
      avgLossSize: avgLossSize > 0 ? avgLossSize.toString() : null,
      riskRewardRatio: riskRewardRatio > 0 ? riskRewardRatio.toString() : null,
      autoTags,
      updatedAt: new Date().toISOString(),
    };

    if (existing) {
      await supabase
        .from(TABLES.TRADER_BEHAVIOR_PROFILE)
        .update(payload)
        .eq('id', existing.id);
    } else {
      await supabase
        .from(TABLES.TRADER_BEHAVIOR_PROFILE)
        .insert({ ...payload, calculatedAt: new Date().toISOString() });
    }

    // Aktualizuj tagy v SmartWallet (sloučit s existujícími)
    const existingTags = wallet.tags || [];
    const mergedTags = Array.from(new Set([...existingTags, ...autoTags]));
    
    await supabase
      .from(TABLES.SMART_WALLET)
      .update({ tags: mergedTags })
      .eq('id', walletId);
  }
}

