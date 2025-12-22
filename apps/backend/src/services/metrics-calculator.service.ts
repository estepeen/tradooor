import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { ClosedLotRepository, ClosedLotRecord } from '../repositories/closed-lot.repository.js';
import { TradeFeatureRepository, TradeFeatureRecord } from '../repositories/trade-feature.repository.js';
import { BinancePriceService } from './binance-price.service.js';
import { supabase, TABLES } from '../lib/supabase.js';

interface Position {
  tokenId: string;
  buyAmount: number;
  buyPrice: number;
  buyTimestamp: Date;
  sellAmount?: number;
  sellPrice?: number;
  sellTimestamp?: Date;
}

type RollingWindowLabel = '7d' | '30d' | '90d';

const WINDOW_CONFIG: Record<RollingWindowLabel, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

const MAX_WINDOW_DAYS = Math.max(...Object.values(WINDOW_CONFIG));
const LOW_LIQUIDITY_THRESHOLD_USD = 10_000;
const NEW_TOKEN_AGE_SECONDS = 30 * 60; // 30 minutes

type RollingWindowStats = {
  realizedPnl: number; // PnL v USD (amountBase a priceBasePerToken jsou nyní v USD)
  realizedRoiPercent: number;
  winRate: number;
  medianTradeRoiPercent: number;
  percentile5TradeRoiPercent: number;
  percentile95TradeRoiPercent: number;
  maxDrawdownPercent: number;
  volatilityPercent: number;
  medianHoldMinutesWinners: number;
  medianHoldMinutesLosers: number;
  numClosedTrades: number;
  totalVolumeUsd: number;
  avgTradeSizeUsd: number;
};

type BehaviourStats = {
  shareLowLiquidity: number;
  shareNewTokens: number;
  avgLiquidityUsd: number;
  sampleTrades: number;
};

type ScoreBreakdown = {
  profitabilityScore: number;
  consistencyScore: number;
  riskScore: number;
  behaviourScore: number;
  sampleFactor: number;
  walletScoreRaw: number;
  smartScore: number;
  // Enhanced scoring (optional, experimental)
  enhancedScore?: number;
  enhancedBreakdown?: any;
  enhancedAdjustments?: any;
};

// ============================================================================
// ENHANCED SCORING TYPES (experimental, builds on existing implementation)
// ============================================================================

export interface EnhancedScoreWeights {
  performance: number;
  consistency: number;
  risk_management: number;
  speed_intelligence: number;
  recent_form: number;
  position_discipline: number;
  market_adaptation: number;
  category_specialization: number;
}

export const ENHANCED_WEIGHTS: EnhancedScoreWeights = {
  performance: 0.30,
  consistency: 0.20,
  risk_management: 0.20,
  speed_intelligence: 0.12,
  recent_form: 0.08,
  position_discipline: 0.05,
  market_adaptation: 0.03,
  // Category specialization temporarily disabled (weights kept for future use)
  category_specialization: 0,
};

export interface MarketRegime {
  regime: 'bull' | 'bear' | 'sideways';
  solPriceChange30d: number;
  volatility: number;
}

export interface WalletPercentileRanks {
  walletId: string;
  winRatePercentile: number;
  roiPercentile: number;
  profitFactorPercentile: number;
  volumePercentile: number;
  updatedAt: Date;
}

export interface PositionDisciplineMetrics {
  positionSizeConsistency: number;
  avgPositionSizePercent: number;
  oversizedTradesCount: number;
  portfolioConcentration: number;
}

export interface TimingIntelligenceMetrics {
  avgEntryCohort: 'early' | 'middle' | 'late';
  avgExitEfficiency: number;
  lossCutSpeed: number;
  profitTakeSpeed: number;
  lossCutDiscipline: number;
}

export interface CategorySpecialization {
  primaryCategory: string;
  categoryConcentration: number;
  categoryWinRate: Record<string, number>;
  specialistBonus: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const median = (values: number[]): number => {
  const filtered = values.filter(v => Number.isFinite(v));
  if (!filtered.length) return 0;
  const sorted = [...filtered].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
};

const percentile = (values: number[], p: number): number => {
  const filtered = values.filter(v => Number.isFinite(v));
  if (!filtered.length) return 0;
  const sorted = [...filtered].sort((a, b) => a - b);
  const index = clamp(Math.ceil(p * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[index];
};

const stdDeviation = (values: number[]): number => {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
};

// ============================================================================
// ENHANCED METRICS CALCULATOR (experimental)
// ============================================================================

export class EnhancedMetricsCalculator {
  /**
   * 1. TIME-WEIGHTED WIN RATE (exponential decay)
   * Recent trades get higher weight.
   */
  calculateTimeWeightedWinRate(lots: ClosedLotRecord[], decayFactor = 0.95): number {
    if (!lots.length) return 0;

    const now = Date.now();
    const sortedLots = [...lots].sort(
      (a, b) => b.exitTime.getTime() - a.exitTime.getTime()
    );

    let weightedWins = 0;
    let totalWeight = 0;

    for (const lot of sortedLots) {
      const daysAgo =
        (now - lot.exitTime.getTime()) / (1000 * 60 * 60 * 24);
      const weight = Math.pow(decayFactor, daysAgo);

      totalWeight += weight;
      if (lot.realizedPnl > 0) {
        weightedWins += weight;
      }
    }

    return totalWeight > 0 ? weightedWins / totalWeight : 0;
  }

  /**
   * 4. POSITION SIZING DISCIPLINE SCORE
   * Penalize erratic position sizing (gambling behavior)
   */
  calculatePositionDiscipline(lots: ClosedLotRecord[]): PositionDisciplineMetrics {
    if (!lots.length) {
      return {
        positionSizeConsistency: 50,
        avgPositionSizePercent: 0,
        oversizedTradesCount: 0,
        portfolioConcentration: 0,
      };
    }

    const positionSizes = lots.map(lot => Math.max(lot.costBasis, 0));
    const avgSize =
      positionSizes.reduce((sum, size) => sum + size, 0) /
      positionSizes.length;
    const variance = this.variance(positionSizes);
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation =
      avgSize > 0 ? stdDev / avgSize : 0;

    // Lower CV = higher consistency (0.3 = good, 1.0 = erratic)
    const positionSizeConsistency = Math.max(
      0,
      100 - coefficientOfVariation * 100
    );

    // Oversized trades (>3x average size)
    const oversizedTradesCount = positionSizes.filter(
      size => size > avgSize * 3
    ).length;

    // Portfolio concentration (Herfindahl index by token)
    const tokenExposure = new Map<string, number>();
    let totalValue = 0;
    for (const lot of lots) {
      const existing = tokenExposure.get(lot.tokenId) || 0;
      const value = Math.max(lot.costBasis, 0);
      tokenExposure.set(lot.tokenId, existing + value);
      totalValue += value;
    }

    let herfindahl = 0;
    for (const exposure of tokenExposure.values()) {
      const share = totalValue > 0 ? exposure / totalValue : 0;
      herfindahl += share * share;
    }

    return {
      positionSizeConsistency,
      avgPositionSizePercent: avgSize,
      oversizedTradesCount,
      portfolioConcentration: herfindahl,
    };
  }

  /**
   * 5. ENHANCED TIMING INTELLIGENCE
   * Measure not just entry/exit efficiency, but SPEED of loss cutting.
   * Uses per-trade features when available, falls back to closed lots.
   */
  calculateTimingIntelligence(
    lots: ClosedLotRecord[],
    features: TradeFeatureRecord[]
  ): TimingIntelligenceMetrics {
    if (!lots.length && !features.length) {
      return {
        avgEntryCohort: 'middle',
        avgExitEfficiency: 0,
        lossCutSpeed: 0,
        profitTakeSpeed: 0,
        lossCutDiscipline: 50,
      };
    }

    // Entry timing: use entryRankPercentile from features (0 = earliest)
    const entryRanks: number[] = [];
    for (const feature of features) {
      if (feature.entryRankPercentile !== null && feature.entryRankPercentile !== undefined) {
        entryRanks.push(feature.entryRankPercentile);
      }
    }
    const avgEntryRank =
      entryRanks.length > 0
        ? entryRanks.reduce((sum, r) => sum + r, 0) / entryRanks.length
        : 0.5;

    const avgEntryCohort =
      avgEntryRank < 0.2 ? 'early' : avgEntryRank < 0.6 ? 'middle' : 'late';

    // Exit efficiency
    const exitEfficiencies = features
      .map(f => f.exitEfficiency)
      .filter((e): e is number => e !== null && e !== undefined);
    const avgExitEfficiency =
      exitEfficiencies.length > 0
        ? exitEfficiencies.reduce((sum, e) => sum + e, 0) / exitEfficiencies.length
        : 0;

    // Loss cutting / profit taking speed from lots
    const losingTrades = lots.filter(lot => lot.realizedPnl <= 0);
    const winningTrades = lots.filter(lot => lot.realizedPnl > 0);

    const lossCutSpeed =
      losingTrades.length > 0
        ? this.median(losingTrades.map(lot => lot.holdTimeMinutes))
        : 0;

    const profitTakeSpeed =
      winningTrades.length > 0
        ? this.median(winningTrades.map(lot => lot.holdTimeMinutes))
        : 0;

    const idealLossCutMinutes = 60; // 1 hour
    const lossCutDiscipline =
      lossCutSpeed > 0 && lossCutSpeed < 240
        ? Math.max(0, 100 - Math.abs(lossCutSpeed - idealLossCutMinutes))
        : 50;

    return {
      avgEntryCohort,
      avgExitEfficiency,
      lossCutSpeed,
      profitTakeSpeed,
      lossCutDiscipline,
    };
  }

  /**
   * 6. CATEGORY SPECIALIZATION BONUS
   * Currently a neutral implementation – requires token categories in features.
   */
  calculateCategorySpecialization(
    lots: ClosedLotRecord[],
    features: TradeFeatureRecord[]
  ): CategorySpecialization {
    if (!features.length || !lots.length) {
      return {
        primaryCategory: 'unknown',
        categoryConcentration: 0,
        categoryWinRate: {},
        specialistBonus: 0,
      };
    }

    const categoryMap = new Map<string, { wins: number; total: number }>();

    for (const feature of features) {
      if (!feature.tokenCategory) continue;
      const category = feature.tokenCategory;

      if (!categoryMap.has(category)) {
        categoryMap.set(category, { wins: 0, total: 0 });
      }

      // Find corresponding lot: same tokenId and close in time
      const lot = lots.find(
        l =>
          l.tokenId === feature.tokenId &&
          Math.abs(l.entryTime.getTime() - (feature.txTimestamp?.getTime() ?? l.entryTime.getTime())) <
            10_000
      );

      const stats = categoryMap.get(category)!;
      stats.total++;
      if (lot && lot.realizedPnl > 0) {
        stats.wins++;
      }
    }

    let primaryCategory = 'unknown';
    let maxCount = 0;
    const categoryWinRate: Record<string, number> = {};

    for (const [category, stats] of categoryMap.entries()) {
      categoryWinRate[category] =
        stats.total > 0 ? stats.wins / stats.total : 0;
      if (stats.total > maxCount) {
        maxCount = stats.total;
        primaryCategory = category;
      }
    }

    const totalTrades = features.length;
    const categoryConcentration =
      totalTrades > 0 ? maxCount / totalTrades : 0;

    const primaryWinRate = categoryWinRate[primaryCategory] || 0;
    let specialistBonus = 0;
    if (categoryConcentration > 0.7 && primaryWinRate > 0.6) {
      specialistBonus = 15;
    } else if (categoryConcentration > 0.6 && primaryWinRate > 0.55) {
      specialistBonus = 10;
    } else if (categoryConcentration > 0.5 && primaryWinRate > 0.5) {
      specialistBonus = 5;
    }

    return {
      primaryCategory,
      categoryConcentration,
      categoryWinRate,
      specialistBonus,
    };
  }

  /**
   * 7. MARKET REGIME ADAPTATION
   * Reward wallets that are consistent across different periods.
   */
  calculateMarketAdaptationScore(
    lots: ClosedLotRecord[],
    _currentRegime: MarketRegime
  ): number {
    const lotsByPeriod = this.groupLotsByTimeWindow(lots, 30); // 30-day windows

    if (lotsByPeriod.length < 2) {
      return 50; // Not enough data
    }

    const winRates = lotsByPeriod.map(period => {
      const wins = period.filter(lot => lot.realizedPnl > 0).length;
      return period.length > 0 ? wins / period.length : 0;
    });

    const variance = this.variance(winRates);
    const stdDev = Math.sqrt(variance);

    // Lower variance = more consistent across regimes = higher score
    const consistencyScore = Math.max(0, 100 - stdDev * 200);

    return consistencyScore;
  }

  /**
   * 8. ENHANCED FINAL SCORE CALCULATION
   * Combines all metrics with weights and sample factor.
   *
   * NOTE: Cross-wallet percentiles are approximated here using
   * wallet-local stats until a global percentile cron is implemented.
   */
  calculateEnhancedScore(params: {
    lots: ClosedLotRecord[];
    features: TradeFeatureRecord[];
    rolling30d: RollingWindowStats | undefined;
    rolling90d: RollingWindowStats | undefined;
    percentileRanks: WalletPercentileRanks;
    marketRegime: MarketRegime;
  }): {
    score: number;
    breakdown: any;
    adjustments: any;
  } {
    const { lots, features, rolling30d, rolling90d, percentileRanks, marketRegime } = params;

    const timeWeightedWinRate = this.calculateTimeWeightedWinRate(lots);
    const positionDiscipline = this.calculatePositionDiscipline(lots);
    const timingIntelligence = this.calculateTimingIntelligence(lots, features);
    const categorySpec = this.calculateCategorySpecialization(lots, features);
    const marketAdaptation = this.calculateMarketAdaptationScore(
      lots,
      marketRegime
    );

    // Performance (30%) - use percentile ranking
    const performanceScore =
      (percentileRanks.roiPercentile * 0.5 +
        percentileRanks.profitFactorPercentile * 0.3 +
        timeWeightedWinRate * 0.2) *
      100;

    // Consistency (20%)
    const consistencyScore =
      (timeWeightedWinRate * 0.6 +
        percentileRanks.winRatePercentile * 0.4) *
      100;

    // Risk Management (20%)
    const drawdownPenalty = Math.min(
      Math.abs(rolling90d?.maxDrawdownPercent ?? 0),
      50
    );
    const riskScore =
      (100 - drawdownPenalty) * 0.6 +
      positionDiscipline.positionSizeConsistency * 0.4;

    // Speed Intelligence (12%)
    const speedScore =
      timingIntelligence.avgExitEfficiency * 100 * 0.5 +
      timingIntelligence.lossCutDiscipline * 0.5;

    // Recent Form (8%)
    const recentFormScore = Math.max(
      0,
      Math.min(
        100,
        (rolling30d?.realizedRoiPercent ?? 0) / 2 + 50
      )
    );

    // Position Discipline (5%)
    const disciplineScore =
      positionDiscipline.positionSizeConsistency * 0.7 +
      Math.max(
        0,
        100 - positionDiscipline.portfolioConcentration * 100
      ) *
        0.3;

    // Market Adaptation (3%)
    const adaptationScore = marketAdaptation;

    // Category Specialization (2%)
    const specializationScore = 50 + categorySpec.specialistBonus * 3.33;

    const rawScore =
      performanceScore * ENHANCED_WEIGHTS.performance +
      consistencyScore * ENHANCED_WEIGHTS.consistency +
      riskScore * ENHANCED_WEIGHTS.risk_management +
      speedScore * ENHANCED_WEIGHTS.speed_intelligence +
      recentFormScore * ENHANCED_WEIGHTS.recent_form +
      disciplineScore * ENHANCED_WEIGHTS.position_discipline +
      adaptationScore * ENHANCED_WEIGHTS.market_adaptation +
      specializationScore * ENHANCED_WEIGHTS.category_specialization;

    // Sample factor – reuse 90d window stats
    const trades = rolling90d?.numClosedTrades ?? 0;
    const volume = rolling90d?.totalVolumeUsd ?? 0;
    const tradeFactor = trades > 0 ? Math.log10(trades + 1) : 0;
    const volumeFactor =
      volume > 0 ? Math.log10(volume / 100 + 1) : 0;
    const sampleFactor = Math.min(
      1,
      0.5 * tradeFactor + 0.5 * volumeFactor
    );

    // Market regime adjustment
    let regimeMultiplier = 1.0;
    if (marketRegime.regime === 'bear' && percentileRanks.roiPercentile > 0.7) {
      regimeMultiplier = 1.1;
    } else if (
      marketRegime.regime === 'bull' &&
      percentileRanks.roiPercentile < 0.3
    ) {
      regimeMultiplier = 0.9;
    }

    const finalScore = clamp(rawScore * sampleFactor * regimeMultiplier, 0, 100);

    return {
      score: finalScore,
      breakdown: {
        performanceScore,
        consistencyScore,
        riskScore,
        speedScore,
        recentFormScore,
        disciplineScore,
        adaptationScore,
        specializationScore,
      },
      adjustments: {
        sampleFactor,
        regimeMultiplier,
        timeWeightedWinRate,
        percentileRanks,
        positionDiscipline,
        timingIntelligence,
        categorySpec,
      },
    };
  }

  // Helper methods
  private median(values: number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  private variance(values: number[]): number {
    if (values.length <= 1) return 0;
    const mean =
      values.reduce((sum, v) => sum + v, 0) / values.length;
    return (
      values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) /
      values.length
    );
  }

  private groupLotsByTimeWindow(
    lots: ClosedLotRecord[],
    windowDays: number
  ): ClosedLotRecord[][] {
    if (!lots.length) return [];

    const sorted = [...lots].sort(
      (a, b) => a.exitTime.getTime() - b.exitTime.getTime()
    );
    const windows: ClosedLotRecord[][] = [];

    let currentWindow: ClosedLotRecord[] = [];
    let windowStart = sorted[0].exitTime;

    for (const lot of sorted) {
      const daysSinceStart =
        (lot.exitTime.getTime() - windowStart.getTime()) /
        (1000 * 60 * 60 * 24);

      if (daysSinceStart > windowDays) {
        if (currentWindow.length > 0) {
          windows.push(currentWindow);
        }
        currentWindow = [lot];
        windowStart = lot.exitTime;
      } else {
        currentWindow.push(lot);
      }
    }

    if (currentWindow.length > 0) {
      windows.push(currentWindow);
    }

    return windows;
  }
}

export class MetricsCalculatorService {
  private binancePriceService: BinancePriceService;
  private enhancedCalculator: EnhancedMetricsCalculator;

  constructor(
    private smartWalletRepo: SmartWalletRepository,
    private tradeRepo: TradeRepository,
    private metricsHistoryRepo: MetricsHistoryRepository,
    private closedLotRepo: ClosedLotRepository = new ClosedLotRepository(),
    private tradeFeatureRepo: TradeFeatureRepository = new TradeFeatureRepository()
  ) {
    this.binancePriceService = new BinancePriceService();
    this.enhancedCalculator = new EnhancedMetricsCalculator();
  }

  /**
   * Calculate all metrics for a wallet and update the database
   */
  async calculateMetricsForWallet(walletId: string) {
    const trades = await this.tradeRepo.findAllForMetrics(walletId);

    if (trades.length === 0) {
      // No trades, reset metrics
      await this.smartWalletRepo.update(walletId, {
        score: 0,
        totalTrades: 0,
        winRate: 0,
        avgRr: 0,
        avgPnlPercent: 0,
        pnlTotalBase: 0,
        avgHoldingTimeMin: 0,
        maxDrawdownPercent: 0,
        recentPnl30dPercent: 0,
        recentPnl30dUsd: 0, // Reset SOL PnL (nyní v SOL, ne v USD)
      });
      return;
    }

    // Build positions from trades (pair buy/sell)
    const positions = this.buildPositions(trades);

    // Calculate metrics
    const totalTrades = positions.length;
    const winRate = this.calculateWinRate(positions);
    const avgRr = this.calculateAvgRiskReward(positions);
    const avgPnlPercent = this.calculateAvgPnlPercent(positions);
    const pnlTotalBase = this.calculateTotalPnl(positions);
    const avgHoldingTimeMin = this.calculateAvgHoldingTime(positions);
    const maxDrawdownPercent = this.calculateMaxDrawdown(positions);

    const legacyAdvancedStats = await this.calculateAdvancedStats(walletId);
    const rollingInsights = await this.computeRollingStatsAndScores(walletId);
    
    // OPTIMALIZACE: PnL se počítá POUZE ze sloupce realizedPnl v ClosedLot
    // NEPŘEPOČÍTÁVÁME vše znovu - jen sčítáme realizedPnl z ClosedLot za posledních 30 dní
    // Toto zajišťuje konzistenci a optimalizaci - PnL se aktualizuje inkrementálně při nových closed trades
    // DŮLEŽITÉ: PnL je nyní v SOL (všechny hodnoty jsou v SOL)
    const rolling30d = rollingInsights.rolling['30d'];
    const recentPnl30dSol = rolling30d?.realizedPnl ?? 0; // PnL v SOL - součet realizedPnl z ClosedLot za 30d
    const recentPnl30dPercent = rolling30d?.realizedRoiPercent ?? 0;
    
    // DEBUG: Log PnL values before saving to database
    const wallet = await this.smartWalletRepo.findById(walletId);
    if (wallet) {
      console.log(`   💰 [Metrics] Wallet ${wallet.address.substring(0, 8)}...: recentPnl30dSol=${recentPnl30dSol.toFixed(4)} SOL, recentPnl30dPercent=${recentPnl30dPercent.toFixed(2)}%`);
      console.log(`   💰 [Metrics] Wallet ${wallet.address.substring(0, 8)}...: rolling30d.numClosedTrades=${rolling30d?.numClosedTrades ?? 0}, rolling30d.realizedPnl=${rolling30d?.realizedPnl?.toFixed(4) ?? 'N/A'}`);
      console.log(`   🔍 [Metrics] Wallet ${wallet.address.substring(0, 8)}...: rollingInsights.rolling['30d']=${JSON.stringify(rollingInsights.rolling['30d'])}`);
    }

    const legacyScore = this.calculateScore({
      totalTrades,
      winRate,
      avgPnlPercent,
      recentPnl30dPercent,
      avgRr,
    });
    const shouldFallbackToLegacy =
      rollingInsights.scores.sampleFactor === 0 &&
      rollingInsights.rolling['90d']?.numClosedTrades === 0;
    const score = shouldFallbackToLegacy
      ? legacyScore
      : rollingInsights.scores.smartScore ?? legacyScore;
    const enhancedScore = rollingInsights.scores.enhancedScore ?? score;

    // Extract component scores (safe fallbacks)
    const enhancedBreakdown = rollingInsights.scores.enhancedBreakdown as
      | {
          disciplineScore?: number;
          speedScore?: number;
        }
      | undefined;
    const enhancedAdjustments = rollingInsights.scores.enhancedAdjustments as
      | {
          categorySpec?: { specialistBonus?: number };
        }
      | undefined;

    const positionDisciplineScore =
      enhancedBreakdown?.disciplineScore ?? 0;
    const timingIntelligenceScore = enhancedBreakdown?.speedScore ?? 0;
    const categorySpecializationBonus =
      enhancedAdjustments?.categorySpec?.specialistBonus ?? 0;

    const advancedStatsPayload = legacyAdvancedStats ? { ...legacyAdvancedStats } : {};
    const advancedStatsRaw = {
      ...advancedStatsPayload,
      rolling: rollingInsights.rolling,
      behaviour: rollingInsights.behaviour,
      scoreBreakdown: {
        ...rollingInsights.scores,
        legacyScore,
      },
    };

    // DŮLEŽITÉ: Sanitizuj advancedStats před uložením - odstraní undefined, NaN, atd.
    // Supabase nemůže serializovat undefined nebo NaN do JSON
    const advancedStats = this.sanitizeJsonForDatabase(advancedStatsRaw);
    
    // Debug: Zkus serializovat, abychom viděli, jestli je to validní JSON
    try {
      JSON.stringify(advancedStats);
    } catch (error: any) {
      console.error('⚠️  advancedStats is not valid JSON after sanitization:', error.message);
      console.error('Raw advancedStats:', JSON.stringify(advancedStatsRaw, null, 2));
      console.error('Sanitized advancedStats:', JSON.stringify(advancedStats, null, 2));
      throw new Error(`advancedStats is not valid JSON: ${error.message}`);
    }

    // Update wallet metrics
    await this.smartWalletRepo.update(walletId, {
      score,
      enhancedScore,
      positionDisciplineScore,
      timingIntelligenceScore,
      categorySpecializationBonus,
      totalTrades,
      winRate,
      avgRr,
      avgPnlPercent,
      pnlTotalBase,
      avgHoldingTimeMin,
      maxDrawdownPercent,
      recentPnl30dPercent,
      recentPnl30dUsd: recentPnl30dSol, // PnL v SOL (všechny hodnoty jsou v SOL, sloupec se jmenuje Usd ale obsahuje SOL)
      advancedStats,
    });

    // Save to history
    await this.metricsHistoryRepo.create({
      walletId,
      timestamp: new Date(),
      score,
      totalTrades,
      winRate,
      avgRr,
      avgPnlPercent,
      pnlTotalBase,
      avgHoldingTimeMin,
      maxDrawdownPercent,
      recentPnl30dPercent,
    });

    return {
      score,
      totalTrades,
      winRate,
      avgRr,
      avgPnlPercent,
      pnlTotalBase,
      avgHoldingTimeMin,
      maxDrawdownPercent,
      recentPnl30dPercent,
      recentPnl30dUsd: recentPnl30dSol, // PnL v SOL (všechny hodnoty jsou v SOL, sloupec se jmenuje Usd ale obsahuje SOL)
      advancedStats,
    };
  }

  /**
   * Build positions from trades (public method for external use)
   */
  async buildPositionsFromTrades(walletId: string): Promise<Position[]> {
    const trades = await this.tradeRepo.findAllForMetrics(walletId);
    return this.buildPositions(trades);
  }

  private buildPositions(trades: any[]): Position[] {
    const positions: Position[] = [];
    const openPositions = new Map<string, Position>();

    // Minimální hodnota v USD pro považování za reálný trade (filtruj airdropy/transfery)
    // amountBase a priceBasePerToken jsou nyní v USD
    const MIN_BASE_VALUE = 0.0001; // $0.0001 USD minimum

    for (const trade of trades) {
      const tokenId = trade.tokenId;
      const side = (trade.side || '').toLowerCase();
      
      // DŮLEŽITÉ: Vyloučit void trades (token-to-token swapy, ADD/REMOVE LIQUIDITY) z positions
      if (side === 'void') {
        continue; // Přeskoč void trades - nepočítají se do positions
      }
      
      // CRITICAL FIX: Properly convert Prisma Decimal to JavaScript number
      const safeToNumber = (value: any): number => {
        if (value === null || value === undefined) return 0;
        if (typeof value === 'object' && typeof value.toNumber === 'function') {
          return value.toNumber();
        }
        if (typeof value === 'string') {
          const parsed = parseFloat(value);
          return isNaN(parsed) ? 0 : parsed;
        }
        const num = Number(value);
        return isNaN(num) ? 0 : num;
      };
      
      const amount = safeToNumber(trade.amountToken);
      const price = safeToNumber(trade.priceBasePerToken);
      const amountBase = safeToNumber(trade.amountBase || 0);
      const timestamp = trade.timestamp;

      // Filtruj airdropy/transfery - pokud buy trade má nulovou nebo velmi malou hodnotu v base měně,
      // je to pravděpodobně airdrop nebo transfer, ne reálný trade
      if (side === 'buy' && amountBase < MIN_BASE_VALUE) {
        continue; // Přeskoč tento trade
      }

      // Pokud je cena nulová nebo velmi malá, také přeskoč (je to pravděpodobně airdrop/transfer)
      if (price <= 0 || price < MIN_BASE_VALUE / amount) {
        continue;
      }

      if (side === 'buy') {
        // Check if there's an open position
        const existing = openPositions.get(tokenId);
        if (existing) {
          // Average the buy price
          const totalAmount = existing.buyAmount + amount;
          const totalValue = existing.buyAmount * existing.buyPrice + amount * price;
          existing.buyAmount = totalAmount;
          existing.buyPrice = totalValue / totalAmount;
        } else {
          openPositions.set(tokenId, {
            tokenId,
            buyAmount: amount,
            buyPrice: price,
            buyTimestamp: timestamp,
          });
        }
      } else if (side === 'sell') {
        const position = openPositions.get(tokenId);
        if (position) {
          // Close position (or partial)
          if (amount >= position.buyAmount) {
            // Full close
            position.sellAmount = position.buyAmount;
            position.sellPrice = price;
            position.sellTimestamp = timestamp;
            positions.push(position);
            openPositions.delete(tokenId);
          } else {
            // Partial close - create closed position and reduce open
            const closedPosition: Position = {
              tokenId,
              buyAmount: amount,
              buyPrice: position.buyPrice,
              buyTimestamp: position.buyTimestamp,
              sellAmount: amount,
              sellPrice: price,
              sellTimestamp: timestamp,
            };
            positions.push(closedPosition);
            position.buyAmount -= amount;
          }
        }
      }
    }

    // Add remaining open positions (not closed yet)
    // These won't count towards win rate but will affect other metrics

    return positions;
  }

  private calculateWinRate(positions: Position[]): number {
    // Filtruj pozice s platnou cenou (vynech airdropy/transfery)
    const closedPositions = positions.filter(p => 
      p.sellAmount && 
      p.sellPrice && 
      p.buyPrice && 
      p.buyPrice > 0
    );
    if (closedPositions.length === 0) return 0;

    const wins = closedPositions.filter(p => {
      const pnl = (p.sellPrice! - p.buyPrice) / p.buyPrice;
      return pnl > 0;
    }).length;

    return wins / closedPositions.length;
  }

  private calculateAvgRiskReward(positions: Position[]): number {
    const closedPositions = positions.filter(p => p.sellAmount && p.sellPrice);
    if (closedPositions.length === 0) return 0;

    const rrs = closedPositions.map(p => {
      const pnl = (p.sellPrice! - p.buyPrice) / p.buyPrice;
      // Simple RR: profit / loss (if loss, negative)
      return pnl > 0 ? pnl : pnl;
    });

    return rrs.reduce((sum, rr) => sum + rr, 0) / rrs.length;
  }

  private calculateAvgPnlPercent(positions: Position[]): number {
    const closedPositions = positions.filter(p => p.sellAmount && p.sellPrice && p.buyPrice > 0);
    if (closedPositions.length === 0) return 0;

    // Průměr PnL procent z jednotlivých pozic (to je v pořádku, protože je to průměr)
    const pnls = closedPositions.map(p => {
      return ((p.sellPrice! - p.buyPrice) / p.buyPrice) * 100;
    });

    return pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length;
  }

  private calculateTotalPnl(positions: Position[]): number {
    // Filtruj pozice s platnou cenou (vynech airdropy/transfery)
    // buyPrice a sellPrice jsou nyní v USD (priceBasePerToken je v USD)
    const closedPositions = positions.filter(p => 
      p.sellAmount && 
      p.sellPrice && 
      p.buyPrice && 
      p.buyPrice > 0
    );
    
    return closedPositions.reduce((sum, p) => {
      const buyValue = p.buyAmount * p.buyPrice; // USD
      const sellValue = p.sellAmount! * p.sellPrice!; // USD
      return sum + (sellValue - buyValue); // PnL v USD
    }, 0);
  }

  private calculateAvgHoldingTime(positions: Position[]): number {
    const closedPositions = positions.filter(p => p.sellTimestamp);
    if (closedPositions.length === 0) return 0;

    const holdingTimes = closedPositions.map(p => {
      const diff = p.sellTimestamp!.getTime() - p.buyTimestamp.getTime();
      return diff / (1000 * 60); // Convert to minutes
    });

    return holdingTimes.reduce((sum, time) => sum + time, 0) / holdingTimes.length;
  }

  private calculateMaxDrawdown(positions: Position[]): number {
    const closedPositions = positions.filter(p => p.sellAmount && p.sellPrice);
    if (closedPositions.length === 0) return 0;

    let peak = 0;
    let maxDrawdown = 0;
    let cumulativePnl = 0;

    for (const p of closedPositions) {
      const pnl = (p.sellPrice! - p.buyPrice) / p.buyPrice;
      cumulativePnl += pnl;
      
      if (cumulativePnl > peak) {
        peak = cumulativePnl;
      }
      
      const drawdown = peak - cumulativePnl;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown * 100; // Convert to percentage
  }

  /**
   * Sanitizuje objekt pro uložení do databáze - odstraní undefined, převede NaN na null
   */
  private sanitizeJsonForDatabase(obj: any): any {
    if (obj === null || obj === undefined) {
      return null;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeJsonForDatabase(item));
    }
    
    if (typeof obj === 'object') {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(obj)) {
        // Přeskoč undefined hodnoty
        if (value === undefined) {
          continue;
        }
        // Převeď NaN na null
        if (typeof value === 'number' && isNaN(value)) {
          sanitized[key] = null;
        } else {
          sanitized[key] = this.sanitizeJsonForDatabase(value);
        }
      }
      return sanitized;
    }
    
    // Pro čísla: převeď NaN na null
    if (typeof obj === 'number' && isNaN(obj)) {
      return null;
    }
    
    return obj;
  }

  private calculateScore(params: {
    totalTrades: number;
    winRate: number;
    avgPnlPercent: number;
    recentPnl30dPercent: number;
    avgRr: number;
  }): number {
    // Simple scoring formula (0-100)
    // Can be improved with more sophisticated logic
    
    const { totalTrades, winRate, avgPnlPercent, recentPnl30dPercent, avgRr } = params;

    // Normalize values
    const winRateScore = winRate * 30; // Max 30 points
    const avgPnlScore = Math.min(Math.max(avgPnlPercent / 2, 0), 30); // Max 30 points (2% avg = 30 points)
    const recentPnlScore = Math.min(Math.max(recentPnl30dPercent / 2, 0), 30); // Max 30 points
    const volumeScore = Math.min(totalTrades / 10, 10); // Max 10 points (100 trades = 10 points)

    const score = winRateScore + avgPnlScore + recentPnlScore + volumeScore;
    return Math.min(Math.max(score, 0), 100); // Clamp to 0-100
  }

  private async computeRollingStatsAndScores(walletId: string) {
    const now = new Date();
    const earliest = new Date(now);
    earliest.setDate(earliest.getDate() - MAX_WINDOW_DAYS);

    // Načti aktuální wallet z DB kvůli percentilům a market regime
    const walletRow = await this.smartWalletRepo.findById(walletId);

    // DŮLEŽITÉ: PnL se počítá POUZE z ClosedLot (jednotný princip)
    // ClosedLot se vytváří v worker queue a metrics cron před výpočtem metrik
    // Pokud ClosedLot neexistují, PnL = 0 (žádný fallback!)
    // DŮLEŽITÉ: Načteme VŠECHNY ClosedLots (bez filtru fromDate), stejně jako portfolio endpoint
    // Pro 30d filtrování podle lastSellTimestamp potřebujeme všechny ClosedLots pro token,
    // ne jen ty z posledních MAX_WINDOW_DAYS dní
    const [closedLots, tradeFeatures] = await Promise.all([
      this.closedLotRepo.findByWallet(walletId), // Bez fromDate - načteme všechny ClosedLots
      this.fetchTradeFeaturesSafe(walletId, earliest),
    ]);

    // DŮLEŽITÉ: Pro 30d použijeme PŘESNĚ STEJNOU logiku jako portfolio endpoint
    // Portfolio endpoint: vytvoří closed positions (seskupené podle tokenId), pak filtruje podle lastSellTimestamp, pak sečte PnL
    // NEPOUŽÍVÁME buildRollingWindowStats pro 30d - použijeme přímo stejný výpočet jako portfolio endpoint
    
    // KROK 1: Seskup ClosedLots podle tokenId (stejně jako portfolio endpoint)
    const lotsByToken = new Map<string, ClosedLotRecord[]>();
    const seenLotIds = new Set<string>(); // Kontrola duplicit podle ID (stejně jako portfolio endpoint)
    const seenLotKeys = new Set<string>(); // Kontrola duplicit podle klíče (stejně jako portfolio endpoint)
    
    for (const lot of closedLots) {
      // Kontrola duplicit podle ID - každý ClosedLot by měl být jen jednou
      if (seenLotIds.has(lot.id)) {
        continue; // Přeskoč duplicitní ClosedLot
      }
      seenLotIds.add(lot.id);
      
      // Kontrola duplicit podle klíče (tokenId + entryTime + exitTime + size)
      const lotKey = `${lot.tokenId}-${lot.entryTime}-${lot.exitTime}-${lot.size || lot.realizedPnl}`;
      if (seenLotKeys.has(lotKey)) {
        continue; // Přeskoč duplicitní ClosedLot
      }
      seenLotKeys.add(lotKey);
      
      // Seskupíme podle tokenId (všechny ClosedLots pro stejný token do jedné skupiny)
      if (!lotsByToken.has(lot.tokenId)) {
        lotsByToken.set(lot.tokenId, []);
      }
      lotsByToken.get(lot.tokenId)!.push(lot);
    }
    
    // KROK 2: Pro každý token vytvoříme closed position (stejně jako portfolio endpoint)
    const closedPositions: Array<{ tokenId: string; realizedPnlBase: number; lastSellTimestamp: Date; totalCostBase: number }> = [];
    
    for (const [tokenId, lotsForToken] of lotsByToken.entries()) {
      if (lotsForToken.length === 0) continue;
      
      // Seřadíme ClosedLots podle entryTime a exitTime (stejně jako portfolio endpoint)
      const sortedLots = lotsForToken.sort((a, b) => {
        const aEntry = new Date(a.entryTime).getTime();
        const bEntry = new Date(b.entryTime).getTime();
        if (aEntry !== bEntry) return aEntry - bEntry;
        return new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime();
      });
      
      const lastLot = sortedLots[sortedLots.length - 1];
      
      // Sečteme všechny ClosedLots pro tento token do jedné closed position (stejně jako portfolio endpoint)
      const totalRealizedPnl = lotsForToken.reduce((sum: number, lot: any) => {
        const pnl = lot.realizedPnl !== null && lot.realizedPnl !== undefined ? Number(lot.realizedPnl) : 0;
        return sum + pnl;
      }, 0);
      
      const totalCostBase = lotsForToken.reduce((sum: number, lot: any) => {
        return sum + (Number(lot.costBasis) || 0);
      }, 0);
      
      // lastSellTimestamp = exitTime z posledního ClosedLot pro token (stejně jako portfolio endpoint)
      const lastSellTimestamp = new Date(lastLot.exitTime);
      
      closedPositions.push({
        tokenId,
        realizedPnlBase: totalRealizedPnl,
        lastSellTimestamp,
        totalCostBase,
      });
    }
    
    // KROK 3: Pro každé období filtruj closed positions a vypočti PnL
    const rolling = {} as Record<RollingWindowLabel, RollingWindowStats>;
    for (const [label, days] of Object.entries(WINDOW_CONFIG) as Array<[RollingWindowLabel, number]>) {
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - days);
      
      if (label === '30d') {
        // Pro 30d: filtruj closed positions podle lastSellTimestamp (stejně jako portfolio endpoint)
        const recentClosedPositions30d = closedPositions.filter((p) => {
          return p.lastSellTimestamp >= cutoff && p.lastSellTimestamp <= now;
        });
        
        // Sečti PnL z filtrovaných closed positions (stejně jako portfolio endpoint)
        const totalPnl30d = recentClosedPositions30d.reduce((sum, p) => {
          return sum + (p.realizedPnlBase || 0);
        }, 0);
        
        // Sečti costBasis z filtrovaných closed positions (stejně jako portfolio endpoint)
        const totalCost30d = recentClosedPositions30d.reduce((sum, p) => {
          return sum + (p.totalCostBase || 0);
        }, 0);
        
        const pnlPercent30d = totalCost30d > 0 ? (totalPnl30d / totalCost30d) * 100 : 0;
        
        // Pro ostatní statistiky potřebujeme ClosedLots, takže vezmeme všechny ClosedLots z filtrovaných closed positions
        const tokenIdsIn30d = new Set(recentClosedPositions30d.map(p => p.tokenId));
        const filteredLots = closedLots.filter(lot => tokenIdsIn30d.has(lot.tokenId));
        
        // Použij buildRollingWindowStats jen pro ostatní statistiky (winRate, median, atd.), ale PnL použijeme z closed positions
        const otherStats = await this.buildRollingWindowStats(filteredLots);
        
        // Vytvoř rolling stats s PnL z closed positions (stejně jako portfolio endpoint)
        rolling[label] = {
          ...otherStats,
          realizedPnl: totalPnl30d, // PnL z closed positions (stejně jako portfolio endpoint)
          realizedRoiPercent: pnlPercent30d, // ROI z closed positions (stejně jako portfolio endpoint)
        };
        
        // DEBUG: Log pro 30d období
        console.log(`   📊 [Rolling Stats] Wallet ${walletId}: Found ${recentClosedPositions30d.length} closed positions in last 30d`);
        console.log(`   ✅ [Rolling Stats] Wallet ${walletId}: totalPnl30d=${totalPnl30d.toFixed(4)} SOL (from closed positions, same as portfolio endpoint), totalCost30d=${totalCost30d.toFixed(4)} SOL, pnlPercent30d=${pnlPercent30d.toFixed(2)}%`);
      } else {
        // Pro ostatní období: filtruj podle exitTime jednotlivých ClosedLots
        const filteredLots = closedLots.filter(lot => {
          if (!lot.exitTime) return false;
          const exitTime = new Date(lot.exitTime);
          return exitTime >= cutoff && exitTime <= now;
        });
        
        rolling[label] = await this.buildRollingWindowStats(filteredLots);
      }
    }

    const behaviour = this.buildBehaviourStats(tradeFeatures);
    const scores = this.buildScoreBreakdown(
      rolling,
      behaviour,
      {
        walletId,
        closedLots,
        tradeFeatures,
        wallet: walletRow as any,
      }
    );

    return { rolling, behaviour, scores };
  }

  private async fetchTradeFeaturesSafe(walletId: string, fromDate: Date) {
    try {
      return await this.tradeFeatureRepo.findForWallet(walletId, { fromDate });
    } catch (error: any) {
      console.warn(
        `⚠️  Failed to fetch trade features for wallet ${walletId}:`,
        error?.message || error
      );
      return [];
    }
  }

  // Keep old method for backward compatibility (used by closed lots)
  private async buildRollingWindowStats(lots: ClosedLotRecord[]): Promise<RollingWindowStats> {
    if (lots.length === 0) {
      return {
        realizedPnl: 0, // PnL v SOL (změněno z realizedPnlUsd)
        realizedRoiPercent: 0,
        winRate: 0,
        medianTradeRoiPercent: 0,
        percentile5TradeRoiPercent: 0,
        percentile95TradeRoiPercent: 0,
        maxDrawdownPercent: 0,
        volatilityPercent: 0,
        medianHoldMinutesWinners: 0,
        medianHoldMinutesLosers: 0,
        numClosedTrades: 0,
        totalVolumeUsd: 0,
        avgTradeSizeUsd: 0,
      };
    }

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/d9d466c4-864c-48e8-9710-84e03ea195a8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'metrics-calculator.service.ts:541',message:'buildRollingWindowStats ENTRY',data:{numLots:lots.length,firstExitTime:lots[0]?.exitTime?.toISOString(),lastExitTime:lots[lots.length-1]?.exitTime?.toISOString()},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
    // #endregion

    // Get current SOL price for conversion (approximation - ideally we'd use historical prices)
    let solPriceUsd = 150; // Default fallback
    try {
      solPriceUsd = await this.binancePriceService.getCurrentSolPrice();
    } catch (error) {
      console.warn(`⚠️  Failed to fetch SOL price, using fallback: ${solPriceUsd}`);
    }

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/d9d466c4-864c-48e8-9710-84e03ea195a8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'metrics-calculator.service.ts:567',message:'currentSolPrice for volume calc only',data:{solPriceUsd},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion

    // DŮLEŽITÉ: Seskup ClosedLots podle tokenId (stejně jako portfolio endpoint)
    // Portfolio endpoint seskupuje ClosedLots podle tokenu, aby se PnL nepočítalo dvakrát
    // Pokud má token více ClosedLots (např. různé sequenceNumber), seskupíme je a sečteme PnL
    // POZNÁMKA: Filtrování podle lastSellTimestamp pro 30d období je už provedeno výše v computeRollingStatsAndScores
    const lotsByToken = new Map<string, ClosedLotRecord[]>();
    for (const lot of lots) {
      if (!lotsByToken.has(lot.tokenId)) {
        lotsByToken.set(lot.tokenId, []);
      }
      lotsByToken.get(lot.tokenId)!.push(lot);
    }
    
    // Pro každý token sečti PnL a costBasis z jeho ClosedLots (stejně jako portfolio endpoint)
    // Toto zajišťuje konzistenci s detail stránkou
    let realizedPnl = 0;
    let investedCapital = 0;
    let totalVolumeSol = 0;
    
    for (const tokenLots of lotsByToken.values()) {
      // Sečti PnL pro všechny ClosedLots tohoto tokenu
      const tokenPnl = tokenLots.reduce((sum, lot) => {
      if (lot.realizedPnl !== null && lot.realizedPnl !== undefined) {
        return sum + lot.realizedPnl;
      }
      return sum;
    }, 0);

      // Sečti costBasis pro všechny ClosedLots tohoto tokenu
      const tokenCostBasis = tokenLots.reduce((sum, lot) => {
        return sum + Math.max(lot.costBasis || 0, 0);
      }, 0);
      
      // Sečti proceeds pro všechny ClosedLots tohoto tokenu
      const tokenProceeds = tokenLots.reduce((sum, lot) => {
        return sum + (lot.proceeds || 0);
      }, 0);
      
      realizedPnl += tokenPnl;
      investedCapital += tokenCostBasis;
      totalVolumeSol += tokenProceeds;
    }
    
    const realizedRoiPercent =
      investedCapital > 0 ? (realizedPnl / investedCapital) * 100 : 0;
    
    // #region agent log
    const sample3Lots=lots.slice(0,3).map(l=>({realizedPnl:l.realizedPnl,costBasis:l.costBasis,exitTime:l.exitTime?.toISOString()}));
    fetch('http://127.0.0.1:7242/ingest/d9d466c4-864c-48e8-9710-84e03ea195a8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'metrics-calculator.service.ts:600',message:'PnL aggregation - using realizedPnl in SOL',data:{realizedPnl,investedCapital,numLots:lots.length,sample3Lots},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H4'})}).catch(()=>{});
    // #endregion
    
    // #region agent log - Debug ROI percentage calculation
    if (Math.abs(realizedPnl) > 10 || Math.abs(realizedRoiPercent) > 100) {
      const sampleLots = lots.slice(0, 3).map(l => ({
        costBasis: l.costBasis,
        realizedPnl: l.realizedPnl,
        realizedPnlPercent: l.realizedPnlPercent,
      }));
      fetch('http://127.0.0.1:7242/ingest/d9d466c4-864c-48e8-9710-84e03ea195a8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'metrics-calculator.service.ts:610',message:'ROI percentage calculation',data:{realizedPnl,investedCapital,realizedRoiPercent,numLots:lots.length,sampleLots},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H6'})}).catch(()=>{});
    }
    // #endregion
    const wins = lots.filter(lot => lot.realizedPnl > 0).length;
    const roiValues = lots.map(lot =>
      lot.costBasis > 0 ? (lot.realizedPnl / lot.costBasis) * 100 : lot.realizedPnlPercent
    );

    const winnersHold = lots
      .filter(lot => lot.realizedPnl > 0)
      .map(lot => lot.holdTimeMinutes);
    const losersHold = lots
      .filter(lot => lot.realizedPnl <= 0)
      .map(lot => lot.holdTimeMinutes);

    return {
      realizedPnl: realizedPnl, // Vždy v SOL (všechny hodnoty jsou v SOL)
      realizedRoiPercent,
      winRate: lots.length ? wins / lots.length : 0,
      medianTradeRoiPercent: median(roiValues),
      percentile5TradeRoiPercent: percentile(roiValues, 0.05),
      percentile95TradeRoiPercent: percentile(roiValues, 0.95),
      maxDrawdownPercent: this.calculateDrawdownPercent(lots),
      volatilityPercent: this.calculateDailyVolatilityPercent(lots),
      medianHoldMinutesWinners: median(winnersHold),
      medianHoldMinutesLosers: median(losersHold),
      numClosedTrades: lots.length,
      totalVolumeUsd: totalVolumeSol, // Sloupec se jmenuje Usd ale obsahuje SOL hodnoty
      avgTradeSizeUsd: totalVolumeSol / lots.length, // Sloupec se jmenuje Usd ale obsahuje SOL hodnoty
    };
  }

  private calculateDailyVolatilityPercent(lots: ClosedLotRecord[]) {
    if (!lots.length) {
      return 0;
    }
    const dayMap = new Map<string, { pnl: number; cost: number }>();
    for (const lot of lots) {
      const key = lot.exitTime.toISOString().slice(0, 10);
      const entry = dayMap.get(key) ?? { pnl: 0, cost: 0 };
      entry.pnl += lot.realizedPnl;
      entry.cost += Math.max(lot.costBasis, 0);
      dayMap.set(key, entry);
    }

    const dailyReturns: number[] = [];
    for (const entry of dayMap.values()) {
      if (entry.cost > 0) {
        dailyReturns.push((entry.pnl / entry.cost) * 100);
      }
    }

    return stdDeviation(dailyReturns);
  }

  private calculateDrawdownPercent(lots: ClosedLotRecord[]) {
    if (!lots.length) {
      return 0;
    }
    const sorted = [...lots].sort(
      (a, b) => a.exitTime.getTime() - b.exitTime.getTime()
    );
    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;

    for (const lot of sorted) {
      const roi = lot.costBasis > 0 ? (lot.realizedPnl / lot.costBasis) * 100 : 0;
      cumulative += roi;
      peak = Math.max(peak, cumulative);
      const drawdown = peak - cumulative;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown;
  }

  private buildBehaviourStats(features: TradeFeatureRecord[]): BehaviourStats {
    if (!features.length) {
      return {
        shareLowLiquidity: 0,
        shareNewTokens: 0,
        avgLiquidityUsd: 0,
        sampleTrades: 0,
      };
    }

    const lowLiquidityCount = features.filter(
      feature =>
        feature.liquidityUsd !== null &&
        feature.liquidityUsd !== undefined &&
        feature.liquidityUsd < LOW_LIQUIDITY_THRESHOLD_USD
    ).length;

    const newTokenCount = features.filter(
      feature =>
        feature.tokenAgeSeconds !== null &&
        feature.tokenAgeSeconds !== undefined &&
        feature.tokenAgeSeconds < NEW_TOKEN_AGE_SECONDS
    ).length;

    const liquidityValues = features
      .map(feature => feature.liquidityUsd)
      .filter((value): value is number => value !== null && value !== undefined);

    const avgLiquidityUsd = liquidityValues.length
      ? liquidityValues.reduce((sum, value) => sum + value, 0) / liquidityValues.length
      : 0;

    return {
      shareLowLiquidity: lowLiquidityCount / features.length,
      shareNewTokens: newTokenCount / features.length,
      avgLiquidityUsd,
      sampleTrades: features.length,
    };
  }

  private buildScoreBreakdown(
    rolling: Record<RollingWindowLabel, RollingWindowStats>,
    behaviour: BehaviourStats,
    context: {
      walletId: string;
      closedLots: ClosedLotRecord[];
      tradeFeatures: TradeFeatureRecord[];
      wallet: any | null;
    }
  ): ScoreBreakdown {
    const stats30 = rolling['30d'];
    const stats90 = rolling['90d'];

    const profitabilityScore = this.computeProfitabilityScore(stats30, stats90);
    const consistencyScore = this.computeConsistencyScore(stats30);
    const riskScore = this.computeRiskScore(stats90);
    const behaviourScore = this.computeBehaviourScore(stats90, behaviour);
    const sampleFactor = this.computeSampleFactor(stats90);
    const walletScoreRaw =
      0.4 * profitabilityScore +
      0.25 * consistencyScore +
      0.2 * riskScore +
      0.15 * behaviourScore;

    const baseSmartScore = clamp(walletScoreRaw * sampleFactor, 0, 100);

    // ----------------------------------------------------------------------
    // Enhanced score (experimental) – builds on top of rolling stats
    // ----------------------------------------------------------------------
    let enhancedScore: number | undefined;
    let enhancedBreakdown: any | undefined;
    let enhancedAdjustments: any | undefined;

    try {
      const wallet = context.wallet;

      // Prefer true cross-wallet percentiles from DB (wallet-percentiles cron),
      // fallback to local approximations if not available.
      const dbWinRatePct =
        typeof wallet?.percentileRankWinRate === 'number'
          ? wallet.percentileRankWinRate
          : undefined;
      const dbRoiPct =
        typeof wallet?.percentileRankRoi === 'number'
          ? wallet.percentileRankRoi
          : undefined;

      const percentileRanks: WalletPercentileRanks = {
        walletId: context.walletId,
        winRatePercentile:
          dbWinRatePct !== undefined
            ? clamp(dbWinRatePct, 0, 1)
            : clamp(stats30?.winRate ?? 0, 0, 1),
        roiPercentile:
          dbRoiPct !== undefined
            ? clamp(dbRoiPct, 0, 1)
            : clamp(
                ((stats90?.realizedRoiPercent ?? 0) + 100) / 200,
                0,
                1
              ),
        profitFactorPercentile: 0.5,
        volumePercentile: clamp(
          Math.log10((stats90?.totalVolumeUsd ?? 0) / 100 + 1) / 3,
          0,
          1
        ),
        updatedAt: new Date(),
      };

      const regimeStr = wallet?.marketRegime as
        | 'bull'
        | 'bear'
        | 'sideways'
        | undefined;
      const marketRegime: MarketRegime = {
        regime: regimeStr ?? 'sideways',
        solPriceChange30d: 0,
        volatility: Math.abs(stats90?.volatilityPercent ?? 0),
      };

      const enhanced = this.enhancedCalculator.calculateEnhancedScore({
        lots: context.closedLots,
        features: context.tradeFeatures,
        rolling30d: stats30,
        rolling90d: stats90,
        percentileRanks,
        marketRegime,
      });

      enhancedScore = enhanced.score;
      enhancedBreakdown = enhanced.breakdown;
      enhancedAdjustments = enhanced.adjustments;
    } catch (error) {
      console.warn(
        `⚠️  Failed to calculate enhanced score for wallet ${context.walletId}:`,
        (error as any)?.message || error
      );
    }

    const smartScore = clamp(
      enhancedScore !== undefined ? enhancedScore : baseSmartScore,
      0,
      100
    );

    return {
      profitabilityScore,
      consistencyScore,
      riskScore,
      behaviourScore,
      sampleFactor,
      walletScoreRaw,
      smartScore,
      enhancedScore,
      enhancedBreakdown,
      enhancedAdjustments,
    };
  }

  private computeProfitabilityScore(
    stats30: RollingWindowStats,
    stats90: RollingWindowStats
  ) {
    const roi30 = stats30?.realizedRoiPercent ?? 0;
    const roi90 = stats90?.realizedRoiPercent ?? 0;
    const blended = 0.5 * roi30 + 0.5 * roi90;
    const roiNorm = clamp((blended / 300) * 100, -100, 100);
    if (roiNorm <= 0) {
      return clamp(20 + 0.2 * roiNorm, 0, 100);
    }
    return clamp(20 + 0.8 * roiNorm, 0, 100);
  }

  private computeConsistencyScore(stats30: RollingWindowStats) {
    const winComponent = clamp((stats30?.winRate ?? 0) * 100, 0, 100);
    const medianComponent = clamp(
      ((stats30?.medianTradeRoiPercent ?? 0) / 30) * 100,
      0,
      100
    );
    return 0.7 * winComponent + 0.3 * medianComponent;
  }

  private computeRiskScore(stats90: RollingWindowStats) {
    const dd = Math.abs(stats90?.maxDrawdownPercent ?? 0);
    const vol = Math.abs(stats90?.volatilityPercent ?? 0);
    const ddScore = clamp((50 - dd) * 2, 0, 100);
    const volScore = clamp((50 - vol) * 2, 0, 100);
    return 0.6 * ddScore + 0.4 * volScore;
  }

  private computeBehaviourScore(
    stats90: RollingWindowStats,
    behaviour: BehaviourStats
  ) {
    const winHold = stats90?.medianHoldMinutesWinners ?? 0;
    const lossHold = stats90?.medianHoldMinutesLosers ?? 0;
    const ratio =
      lossHold > 0 ? winHold / lossHold : winHold > 0 ? 2 : 0;

    let holdScore = 50;
    if (ratio >= 2) {
      holdScore = 100;
    } else if (ratio >= 1) {
      holdScore = 60 + (ratio - 1) * 40;
    } else if (ratio > 0) {
      holdScore = Math.max(20 * ratio, 0);
    } else if (winHold === 0 && lossHold === 0) {
      holdScore = 50;
    } else {
      holdScore = 10;
    }

    const liquidityPenalty =
      behaviour.shareLowLiquidity * 120 + behaviour.shareNewTokens * 80;
    const liquidityScore = clamp(100 - liquidityPenalty, 0, 100);

    return 0.6 * holdScore + 0.4 * liquidityScore;
  }

  private computeSampleFactor(stats90: RollingWindowStats) {
    const trades = stats90?.numClosedTrades ?? 0;
    const volume = stats90?.totalVolumeUsd ?? 0;
    const tradeFactor = trades > 0 ? Math.log10(trades + 1) : 0;
    const volumeFactor = volume > 0 ? Math.log10(volume / 100 + 1) : 0;
    return clamp(0.5 * tradeFactor + 0.5 * volumeFactor, 0, 1);
  }

  /**
   * Calculate advanced statistics for a wallet
   */
  async calculateAdvancedStats(walletId: string) {
    const trades = await this.tradeRepo.findAllForMetrics(walletId);
    if (trades.length === 0) {
      return null;
    }

    const positions = this.buildPositions(trades);
    const closedPositions = positions.filter(p => p.sellAmount && p.sellPrice);

    if (closedPositions.length === 0) {
      return null;
    }

    // Calculate PnL for each position
    const pnls = closedPositions.map(p => {
      const pnlPercent = ((p.sellPrice! - p.buyPrice) / p.buyPrice) * 100;
      const pnlBase = (p.sellPrice! - p.buyPrice) * p.buyAmount;
      return { pnlPercent, pnlBase, position: p };
    });

    // Profit Factor = Total Profit / Total Loss
    const totalProfit = pnls.filter(p => p.pnlBase > 0).reduce((sum, p) => sum + p.pnlBase, 0);
    const totalLoss = Math.abs(pnls.filter(p => p.pnlBase < 0).reduce((sum, p) => sum + p.pnlBase, 0));
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    // Best and worst trades
    const bestTrade = pnls.reduce((best, current) => 
      current.pnlPercent > best.pnlPercent ? current : best
    );
    const worstTrade = pnls.reduce((worst, current) => 
      current.pnlPercent < worst.pnlPercent ? current : worst
    );

    // Largest win/loss
    const largestWin = pnls.filter(p => p.pnlBase > 0).reduce((max, p) => 
      p.pnlBase > max.pnlBase ? p : max, { pnlBase: 0, pnlPercent: 0, position: null as any }
    );
    const largestLoss = pnls.filter(p => p.pnlBase < 0).reduce((min, p) => 
      p.pnlBase < min.pnlBase ? p : min, { pnlBase: 0, pnlPercent: 0, position: null as any }
    );

    // Average win/loss
    const wins = pnls.filter(p => p.pnlBase > 0);
    const losses = pnls.filter(p => p.pnlBase < 0);
    const avgWin = wins.length > 0 
      ? wins.reduce((sum, p) => sum + p.pnlPercent, 0) / wins.length 
      : 0;
    const avgLoss = losses.length > 0 
      ? losses.reduce((sum, p) => sum + p.pnlPercent, 0) / losses.length 
      : 0;

    // Win streak / Loss streak
    let currentWinStreak = 0;
    let maxWinStreak = 0;
    let currentLossStreak = 0;
    let maxLossStreak = 0;

    for (const pnl of pnls) {
      if (pnl.pnlBase > 0) {
        currentWinStreak++;
        currentLossStreak = 0;
        maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
      } else {
        currentLossStreak++;
        currentWinStreak = 0;
        maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
      }
    }

    // Token analysis
    const tokenStats = new Map<string, { count: number; totalPnl: number; wins: number; losses: number }>();
    for (const pnl of pnls) {
      const tokenId = pnl.position.tokenId;
      if (!tokenStats.has(tokenId)) {
        tokenStats.set(tokenId, { count: 0, totalPnl: 0, wins: 0, losses: 0 });
      }
      const stats = tokenStats.get(tokenId)!;
      stats.count++;
      stats.totalPnl += pnl.pnlBase;
      if (pnl.pnlBase > 0) stats.wins++;
      else stats.losses++;
    }

    // DEX analysis
    const dexStats = new Map<string, { count: number; totalPnl: number }>();
    for (const trade of trades) {
      if (trade.side === 'sell') {
        const dex = trade.dex;
        if (!dexStats.has(dex)) {
          dexStats.set(dex, { count: 0, totalPnl: 0 });
        }
        dexStats.get(dex)!.count++;
        // Find corresponding position PnL
        const position = closedPositions.find(p => p.tokenId === trade.tokenId);
        if (position && position.sellPrice) {
          const pnl = (position.sellPrice - position.buyPrice) * position.buyAmount;
          dexStats.get(dex)!.totalPnl += pnl;
        }
      }
    }

    return {
      profitFactor,
      bestTrade: {
        pnlPercent: bestTrade.pnlPercent,
        pnlBase: bestTrade.pnlBase,
        tokenId: bestTrade.position.tokenId,
      },
      worstTrade: {
        pnlPercent: worstTrade.pnlPercent,
        pnlBase: worstTrade.pnlBase,
        tokenId: worstTrade.position.tokenId,
      },
      largestWin: largestWin.position ? {
        pnlPercent: largestWin.pnlPercent,
        pnlBase: largestWin.pnlBase,
        tokenId: largestWin.position.tokenId,
      } : null,
      largestLoss: largestLoss.position ? {
        pnlPercent: largestLoss.pnlPercent,
        pnlBase: largestLoss.pnlBase,
        tokenId: largestLoss.position.tokenId,
      } : null,
      avgWin,
      avgLoss,
      maxWinStreak,
      maxLossStreak,
      tokenStats: Array.from(tokenStats.entries()).map(([tokenId, stats]) => ({
        tokenId,
        ...stats,
        winRate: stats.count > 0 ? stats.wins / stats.count : 0,
      })),
      dexStats: Array.from(dexStats.entries()).map(([dex, stats]) => ({
        dex,
        ...stats,
      })),
    };
  }
}
