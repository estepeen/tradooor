/**
 * Signal Learning Service
 *
 * Historical Performance Feedback Loop
 *
 * Analyzes past signal outcomes to learn:
 * 1. Which wallet combinations have the best win rates
 * 2. Which MCap ranges produce the best results
 * 3. What time windows are optimal for each tier
 * 4. Which parameters correlate with winning trades
 *
 * Results are cached and used to improve signal quality scores.
 */

import { prisma } from '../lib/prisma.js';

// ============================================================================
// TYPES
// ============================================================================

export interface WalletComboPerformance {
  walletIds: string[];
  walletLabels: string[];
  totalSignals: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPercent: number;
  avgMaxPnlPercent: number;
  avgMissedPnlPercent: number;
  avgTimeToPeakMinutes: number;
  lastSignalAt: Date | null;
}

export interface McapRangePerformance {
  rangeLabel: string;
  minMcap: number;
  maxMcap: number;
  totalSignals: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPercent: number;
  avgMaxPnlPercent: number;
  avgTimeToPeakMinutes: number;
  optimalExitMinutes: number | null;
}

export interface TierTimeWindowAnalysis {
  tier: string;
  timeWindowMinutes: number;
  sampleSize: number;
  winRate: number;
  avgPnlPercent: number;
  recommendation: 'keep' | 'increase' | 'decrease';
  suggestedWindowMinutes: number | null;
}

export interface LearningInsights {
  // Summary stats
  totalAnalyzedSignals: number;
  analyzedTimeframe: { start: Date; end: Date };

  // Top performers
  topWalletCombos: WalletComboPerformance[];
  worstWalletCombos: WalletComboPerformance[];

  // MCap analysis
  mcapRanges: McapRangePerformance[];
  bestMcapRange: McapRangePerformance | null;
  worstMcapRange: McapRangePerformance | null;

  // Time window analysis
  tierTimeWindows: TierTimeWindowAnalysis[];

  // Key learnings (human-readable)
  keyFindings: string[];

  // Computed at
  computedAt: Date;
}

export interface SignalQualityBonus {
  walletComboBonus: number;     // -20 to +20 based on wallet combo history
  mcapRangeBonus: number;       // -10 to +10 based on MCap range performance
  timeWindowBonus: number;      // -5 to +5 based on time window optimality
  totalBonus: number;           // Sum of all bonuses
  reasoning: string[];          // Explanation for each bonus
}

// ============================================================================
// CONSTANTS
// ============================================================================

// MCap ranges for analysis (in USD)
const MCAP_RANGES = [
  { label: '$50K-80K', min: 50000, max: 80000 },
  { label: '$80K-120K', min: 80000, max: 120000 },
  { label: '$120K-200K', min: 120000, max: 200000 },
  { label: '$200K-350K', min: 200000, max: 350000 },
  { label: '$350K-500K', min: 350000, max: 500000 },
  { label: '$500K-1M', min: 500000, max: 1000000 },
  { label: '$1M+', min: 1000000, max: 100000000 },
];

// Minimum signals needed for statistical significance
const MIN_SIGNALS_FOR_ANALYSIS = 5;

// Cache TTL (1 hour)
const CACHE_TTL_MS = 60 * 60 * 1000;

// ============================================================================
// SERVICE
// ============================================================================

// In-memory cache for insights
let cachedInsights: LearningInsights | null = null;
let cacheExpiresAt = 0;

export class SignalLearningService {
  /**
   * Get learning insights (cached)
   */
  async getInsights(forceRefresh = false): Promise<LearningInsights> {
    const now = Date.now();

    if (!forceRefresh && cachedInsights && now < cacheExpiresAt) {
      return cachedInsights;
    }

    console.log('🧠 [Learning] Computing signal learning insights...');
    const insights = await this.computeInsights();

    cachedInsights = insights;
    cacheExpiresAt = now + CACHE_TTL_MS;

    return insights;
  }

  /**
   * Get quality bonus for a specific signal configuration
   * Used by consensus-webhook.service.ts to adjust signal quality scores
   */
  async getQualityBonus(params: {
    walletIds: string[];
    marketCapUsd: number;
    tierName: string;
    timeWindowMinutes: number;
  }): Promise<SignalQualityBonus> {
    const insights = await this.getInsights();

    const reasoning: string[] = [];
    let walletComboBonus = 0;
    let mcapRangeBonus = 0;
    let timeWindowBonus = 0;

    // 1. Wallet combo analysis
    // Check if this exact combination (or subset) has historical performance data
    const sortedWalletIds = [...params.walletIds].sort();
    const comboKey = sortedWalletIds.join(',');

    for (const combo of insights.topWalletCombos) {
      const comboWalletKey = [...combo.walletIds].sort().join(',');
      // Check for exact match or subset match
      if (comboWalletKey === comboKey || this.isSubset(combo.walletIds, params.walletIds)) {
        if (combo.winRate >= 70 && combo.totalSignals >= MIN_SIGNALS_FOR_ANALYSIS) {
          walletComboBonus = Math.min(20, Math.round((combo.winRate - 50) / 2.5));
          reasoning.push(`🏆 Wallet combo has ${combo.winRate.toFixed(0)}% win rate (${combo.totalSignals} signals) → +${walletComboBonus} bonus`);
          break;
        } else if (combo.winRate >= 50) {
          walletComboBonus = Math.round((combo.winRate - 50) / 5);
          reasoning.push(`📊 Wallet combo has ${combo.winRate.toFixed(0)}% win rate → +${walletComboBonus} bonus`);
          break;
        }
      }
    }

    for (const combo of insights.worstWalletCombos) {
      const comboWalletKey = [...combo.walletIds].sort().join(',');
      if (comboWalletKey === comboKey || this.isSubset(combo.walletIds, params.walletIds)) {
        if (combo.winRate < 30 && combo.totalSignals >= MIN_SIGNALS_FOR_ANALYSIS) {
          walletComboBonus = Math.max(-20, Math.round((combo.winRate - 50) / 2.5));
          reasoning.push(`⚠️ Wallet combo has poor ${combo.winRate.toFixed(0)}% win rate → ${walletComboBonus} penalty`);
          break;
        }
      }
    }

    // 2. MCap range analysis
    const mcapRange = insights.mcapRanges.find(r =>
      params.marketCapUsd >= r.minMcap && params.marketCapUsd < r.maxMcap
    );

    if (mcapRange && mcapRange.totalSignals >= MIN_SIGNALS_FOR_ANALYSIS) {
      if (mcapRange.winRate >= 60) {
        mcapRangeBonus = Math.min(10, Math.round((mcapRange.winRate - 50) / 2));
        reasoning.push(`💰 MCap range ${mcapRange.rangeLabel} has ${mcapRange.winRate.toFixed(0)}% win rate → +${mcapRangeBonus} bonus`);
      } else if (mcapRange.winRate < 40) {
        mcapRangeBonus = Math.max(-10, Math.round((mcapRange.winRate - 50) / 2));
        reasoning.push(`📉 MCap range ${mcapRange.rangeLabel} has poor ${mcapRange.winRate.toFixed(0)}% win rate → ${mcapRangeBonus} penalty`);
      }
    }

    // Best/worst MCap comparison
    if (insights.bestMcapRange && mcapRange) {
      if (mcapRange.rangeLabel === insights.bestMcapRange.rangeLabel) {
        mcapRangeBonus += 5;
        reasoning.push(`🎯 Best performing MCap range → +5 bonus`);
      }
    }
    if (insights.worstMcapRange && mcapRange) {
      if (mcapRange.rangeLabel === insights.worstMcapRange.rangeLabel) {
        mcapRangeBonus -= 5;
        reasoning.push(`⛔ Worst performing MCap range → -5 penalty`);
      }
    }

    // 3. Time window analysis
    const tierAnalysis = insights.tierTimeWindows.find(t => t.tier === params.tierName);
    if (tierAnalysis && tierAnalysis.sampleSize >= MIN_SIGNALS_FOR_ANALYSIS) {
      if (tierAnalysis.recommendation === 'keep') {
        timeWindowBonus = 2;
        reasoning.push(`⏱️ Time window ${params.timeWindowMinutes}min is optimal for ${params.tierName} → +2 bonus`);
      } else if (tierAnalysis.recommendation === 'decrease' && tierAnalysis.suggestedWindowMinutes) {
        // Current window is too long - slight penalty
        timeWindowBonus = -2;
        reasoning.push(`⏱️ Consider shorter window (${tierAnalysis.suggestedWindowMinutes}min) for ${params.tierName} → -2 penalty`);
      } else if (tierAnalysis.recommendation === 'increase' && tierAnalysis.suggestedWindowMinutes) {
        // Current window is too short - slight penalty
        timeWindowBonus = -2;
        reasoning.push(`⏱️ Consider longer window (${tierAnalysis.suggestedWindowMinutes}min) for ${params.tierName} → -2 penalty`);
      }
    }

    const totalBonus = walletComboBonus + mcapRangeBonus + timeWindowBonus;

    return {
      walletComboBonus,
      mcapRangeBonus,
      timeWindowBonus,
      totalBonus,
      reasoning,
    };
  }

  /**
   * Compute all insights from historical data
   */
  private async computeInsights(): Promise<LearningInsights> {
    const startTime = Date.now();

    // Get closed signals with performance data from last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const signalsWithPerformance = await prisma.signal.findMany({
      where: {
        model: 'consensus',
        performance: {
          status: 'closed',
        },
        timestamp: {
          gte: thirtyDaysAgo,
        },
      },
      include: {
        performance: true,
        token: {
          select: { id: true, symbol: true, mintAddress: true },
        },
      },
      orderBy: { timestamp: 'desc' },
    });

    console.log(`   📊 Found ${signalsWithPerformance.length} closed consensus signals in last 30 days`);

    // Extract wallet IDs from signal meta
    const signalsWithWallets = signalsWithPerformance.map(s => {
      const meta = s.meta as any;
      const walletIds: string[] = meta?.walletIds || [];
      const entryMcap = s.performance?.entryMarketCapUsd
        ? Number(s.performance.entryMarketCapUsd)
        : null;
      const realizedPnl = s.performance?.realizedPnlPercent
        ? Number(s.performance.realizedPnlPercent)
        : null;
      const maxPnl = s.performance?.maxPnlPercent
        ? Number(s.performance.maxPnlPercent)
        : null;
      const missedPnl = s.performance?.missedPnlPercent
        ? Number(s.performance.missedPnlPercent)
        : null;
      const timeToPeak = s.performance?.timeToPeakMinutes ?? null;
      const tier = meta?.tier || null;
      const timeWindow = meta?.timeWindowMinutes || null;

      return {
        signalId: s.id,
        walletIds,
        entryMcap,
        realizedPnl,
        maxPnl,
        missedPnl,
        timeToPeak,
        tier,
        timeWindow,
        timestamp: s.timestamp,
        isWin: realizedPnl !== null && realizedPnl > 0,
      };
    });

    // 1. Analyze wallet combinations
    const walletComboMap = new Map<string, {
      walletIds: string[];
      signals: typeof signalsWithWallets;
    }>();

    for (const s of signalsWithWallets) {
      if (s.walletIds.length < 2) continue;

      // Create a sorted key for the combo
      const comboKey = [...s.walletIds].sort().join(',');

      if (!walletComboMap.has(comboKey)) {
        walletComboMap.set(comboKey, { walletIds: s.walletIds, signals: [] });
      }
      walletComboMap.get(comboKey)!.signals.push(s);
    }

    // Get wallet labels for display
    const allWalletIds = [...new Set(signalsWithWallets.flatMap(s => s.walletIds))];
    const wallets = await prisma.smartWallet.findMany({
      where: { id: { in: allWalletIds } },
      select: { id: true, label: true, address: true },
    });
    const walletLabelMap = new Map(wallets.map(w => [w.id, w.label || w.address.substring(0, 8)]));

    // Calculate combo performance
    const walletComboPerformances: WalletComboPerformance[] = [];

    for (const [_key, data] of walletComboMap) {
      if (data.signals.length < MIN_SIGNALS_FOR_ANALYSIS) continue;

      const wins = data.signals.filter(s => s.isWin).length;
      const losses = data.signals.length - wins;
      const winRate = (wins / data.signals.length) * 100;

      const avgPnl = this.avg(data.signals.map(s => s.realizedPnl).filter((x): x is number => x !== null));
      const avgMaxPnl = this.avg(data.signals.map(s => s.maxPnl).filter((x): x is number => x !== null));
      const avgMissedPnl = this.avg(data.signals.map(s => s.missedPnl).filter((x): x is number => x !== null));
      const avgTimeToPeak = this.avg(data.signals.map(s => s.timeToPeak).filter((x): x is number => x !== null));

      walletComboPerformances.push({
        walletIds: data.walletIds,
        walletLabels: data.walletIds.map(id => walletLabelMap.get(id) || id.substring(0, 8)),
        totalSignals: data.signals.length,
        wins,
        losses,
        winRate,
        avgPnlPercent: avgPnl ?? 0,
        avgMaxPnlPercent: avgMaxPnl ?? 0,
        avgMissedPnlPercent: avgMissedPnl ?? 0,
        avgTimeToPeakMinutes: avgTimeToPeak ?? 0,
        lastSignalAt: data.signals[0]?.timestamp || null,
      });
    }

    // Sort by win rate (desc) then by sample size (desc)
    walletComboPerformances.sort((a, b) => {
      if (Math.abs(a.winRate - b.winRate) > 5) {
        return b.winRate - a.winRate;
      }
      return b.totalSignals - a.totalSignals;
    });

    const topWalletCombos = walletComboPerformances.slice(0, 10);
    const worstWalletCombos = [...walletComboPerformances]
      .sort((a, b) => a.winRate - b.winRate)
      .slice(0, 5);

    // 2. Analyze MCap ranges
    const mcapRanges: McapRangePerformance[] = [];

    for (const range of MCAP_RANGES) {
      const inRange = signalsWithWallets.filter(s =>
        s.entryMcap !== null && s.entryMcap >= range.min && s.entryMcap < range.max
      );

      if (inRange.length < MIN_SIGNALS_FOR_ANALYSIS) {
        mcapRanges.push({
          rangeLabel: range.label,
          minMcap: range.min,
          maxMcap: range.max,
          totalSignals: inRange.length,
          wins: 0,
          losses: 0,
          winRate: 0,
          avgPnlPercent: 0,
          avgMaxPnlPercent: 0,
          avgTimeToPeakMinutes: 0,
          optimalExitMinutes: null,
        });
        continue;
      }

      const wins = inRange.filter(s => s.isWin).length;
      const losses = inRange.length - wins;
      const winRate = (wins / inRange.length) * 100;

      const avgPnl = this.avg(inRange.map(s => s.realizedPnl).filter((x): x is number => x !== null));
      const avgMaxPnl = this.avg(inRange.map(s => s.maxPnl).filter((x): x is number => x !== null));
      const avgTimeToPeak = this.avg(inRange.map(s => s.timeToPeak).filter((x): x is number => x !== null));

      // Optimal exit = time to peak for winning trades
      const winningTimesToPeak = inRange
        .filter(s => s.isWin && s.timeToPeak !== null)
        .map(s => s.timeToPeak!);
      const optimalExit = winningTimesToPeak.length > 0
        ? Math.round(this.median(winningTimesToPeak))
        : null;

      mcapRanges.push({
        rangeLabel: range.label,
        minMcap: range.min,
        maxMcap: range.max,
        totalSignals: inRange.length,
        wins,
        losses,
        winRate,
        avgPnlPercent: avgPnl ?? 0,
        avgMaxPnlPercent: avgMaxPnl ?? 0,
        avgTimeToPeakMinutes: avgTimeToPeak ?? 0,
        optimalExitMinutes: optimalExit,
      });
    }

    // Find best and worst MCap ranges (with sufficient data)
    const mcapWithData = mcapRanges.filter(r => r.totalSignals >= MIN_SIGNALS_FOR_ANALYSIS);
    const bestMcapRange = mcapWithData.length > 0
      ? mcapWithData.reduce((a, b) => a.winRate > b.winRate ? a : b)
      : null;
    const worstMcapRange = mcapWithData.length > 0
      ? mcapWithData.reduce((a, b) => a.winRate < b.winRate ? a : b)
      : null;

    // 3. Analyze time windows per tier
    const tierTimeWindows: TierTimeWindowAnalysis[] = [];
    const tiers = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4'];
    const defaultTimeWindows: Record<string, number> = {
      'Tier 1': 5,
      'Tier 2': 8,
      'Tier 3': 12,
      'Tier 4': 15,
    };

    for (const tier of tiers) {
      const tierSignals = signalsWithWallets.filter(s => s.tier === tier);

      if (tierSignals.length < MIN_SIGNALS_FOR_ANALYSIS) {
        tierTimeWindows.push({
          tier,
          timeWindowMinutes: defaultTimeWindows[tier],
          sampleSize: tierSignals.length,
          winRate: 0,
          avgPnlPercent: 0,
          recommendation: 'keep',
          suggestedWindowMinutes: null,
        });
        continue;
      }

      const wins = tierSignals.filter(s => s.isWin).length;
      const winRate = (wins / tierSignals.length) * 100;
      const avgPnl = this.avg(tierSignals.map(s => s.realizedPnl).filter((x): x is number => x !== null));

      // Analyze if window should be adjusted
      // Look at time to peak for winning vs losing trades
      const winningPeakTimes = tierSignals
        .filter(s => s.isWin && s.timeToPeak !== null)
        .map(s => s.timeToPeak!);
      const losingPeakTimes = tierSignals
        .filter(s => !s.isWin && s.timeToPeak !== null)
        .map(s => s.timeToPeak!);

      let recommendation: 'keep' | 'increase' | 'decrease' = 'keep';
      let suggestedWindow: number | null = null;
      const currentWindow = defaultTimeWindows[tier];

      if (winningPeakTimes.length >= 3) {
        const medianWinPeak = this.median(winningPeakTimes);

        // If winning trades peak much faster than window, suggest shorter window
        if (medianWinPeak < currentWindow * 0.5) {
          recommendation = 'decrease';
          suggestedWindow = Math.max(3, Math.round(medianWinPeak * 1.2));
        }
        // If winning trades peak much slower than window, suggest longer window
        else if (medianWinPeak > currentWindow * 1.5) {
          recommendation = 'increase';
          suggestedWindow = Math.min(30, Math.round(medianWinPeak * 0.8));
        }
      }

      tierTimeWindows.push({
        tier,
        timeWindowMinutes: currentWindow,
        sampleSize: tierSignals.length,
        winRate,
        avgPnlPercent: avgPnl ?? 0,
        recommendation,
        suggestedWindowMinutes: suggestedWindow,
      });
    }

    // 4. Generate key findings
    const keyFindings: string[] = [];

    if (bestMcapRange) {
      keyFindings.push(`🏆 Best MCap range: ${bestMcapRange.rangeLabel} with ${bestMcapRange.winRate.toFixed(0)}% win rate (${bestMcapRange.totalSignals} signals)`);
    }

    if (worstMcapRange && worstMcapRange.winRate < 40) {
      keyFindings.push(`⚠️ Avoid MCap range: ${worstMcapRange.rangeLabel} with only ${worstMcapRange.winRate.toFixed(0)}% win rate`);
    }

    if (topWalletCombos.length > 0 && topWalletCombos[0].winRate >= 70) {
      const top = topWalletCombos[0];
      keyFindings.push(`💎 Best wallet combo: [${top.walletLabels.join(', ')}] with ${top.winRate.toFixed(0)}% win rate`);
    }

    const adjustTiers = tierTimeWindows.filter(t => t.recommendation !== 'keep' && t.sampleSize >= MIN_SIGNALS_FOR_ANALYSIS);
    for (const tier of adjustTiers) {
      keyFindings.push(`⏱️ ${tier.tier}: Consider ${tier.recommendation === 'increase' ? 'longer' : 'shorter'} time window (${tier.suggestedWindowMinutes}min vs current ${tier.timeWindowMinutes}min)`);
    }

    // Overall stats
    const overallWins = signalsWithWallets.filter(s => s.isWin).length;
    const overallWinRate = signalsWithWallets.length > 0
      ? (overallWins / signalsWithWallets.length) * 100
      : 0;
    keyFindings.push(`📊 Overall win rate: ${overallWinRate.toFixed(1)}% (${signalsWithWallets.length} signals)`);

    const avgMissed = this.avg(signalsWithWallets.map(s => s.missedPnl).filter((x): x is number => x !== null));
    if (avgMissed !== null && avgMissed > 10) {
      keyFindings.push(`📉 Avg missed PnL: ${avgMissed.toFixed(1)}% - exit timing could be improved`);
    }

    const computeTime = Date.now() - startTime;
    console.log(`   ✅ Learning insights computed in ${computeTime}ms`);

    return {
      totalAnalyzedSignals: signalsWithWallets.length,
      analyzedTimeframe: {
        start: thirtyDaysAgo,
        end: new Date(),
      },
      topWalletCombos,
      worstWalletCombos,
      mcapRanges,
      bestMcapRange,
      worstMcapRange,
      tierTimeWindows,
      keyFindings,
      computedAt: new Date(),
    };
  }

  /**
   * Clear cache (useful after manual adjustments)
   */
  clearCache(): void {
    cachedInsights = null;
    cacheExpiresAt = 0;
    console.log('🧹 [Learning] Cache cleared');
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  private avg(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private isSubset(subset: string[], superset: string[]): boolean {
    const superSet = new Set(superset);
    return subset.every(item => superSet.has(item));
  }
}

// Export singleton
export const signalLearningService = new SignalLearningService();
