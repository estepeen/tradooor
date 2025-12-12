/**
 * Service for analyzing ClosedLot data for copytrading insights
 * Provides metrics and patterns that can be used for copytrading bot conditions
 */

import { supabase, TABLES } from '../lib/supabase.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';

export interface EntryTimingStats {
  hourOfDay: number;
  dayOfWeek: number;
  totalTrades: number;
  winRate: number;
  avgPnlPercent: number;
  avgHoldTimeMinutes: number;
}

export interface MarketConditionStats {
  tokenAgeRange: string;
  liquidityRange: string;
  marketCapRange: string;
  totalTrades: number;
  winRate: number;
  avgPnlPercent: number;
}

export interface PatternStats {
  patternType: 'dca' | 'single_entry' | 'reentry' | 'scalp' | 'swing';
  totalTrades: number;
  winRate: number;
  avgPnlPercent: number;
  avgHoldTimeMinutes: number;
}

export interface ExitReasonStats {
  exitReason: 'take_profit' | 'stop_loss' | 'manual' | 'unknown';
  totalTrades: number;
  winRate: number;
  avgPnlPercent: number;
  avgHoldTimeMinutes: number;
}

export interface CopytradingAnalytics {
  entryTiming: EntryTimingStats[];
  marketConditions: MarketConditionStats[];
  patterns: PatternStats[];
  exitReasons: ExitReasonStats[];
  bestEntryHour: number | null;
  bestEntryDay: number | null;
  preferredTokenAge: string | null;
  preferredLiquidity: string | null;
  dcaSuccessRate: number | null;
  reentrySuccessRate: number | null;
  scalpSuccessRate: number | null;
  swingSuccessRate: number | null;
}

export class CopytradingAnalyticsService {
  private closedLotRepo: ClosedLotRepository;

  constructor() {
    this.closedLotRepo = new ClosedLotRepository();
  }

  /**
   * Get comprehensive analytics for a wallet
   * Used for determining copytrading conditions
   */
  async getAnalyticsForWallet(walletId: string): Promise<CopytradingAnalytics> {
    const closedLots = await this.closedLotRepo.findByWallet(walletId);

    if (closedLots.length === 0) {
      return this.getEmptyAnalytics();
    }

    // Calculate different analytics
    const entryTiming = this.calculateEntryTimingStats(closedLots);
    const marketConditions = this.calculateMarketConditionStats(closedLots);
    const patterns = this.calculatePatternStats(closedLots);
    const exitReasons = this.calculateExitReasonStats(closedLots);

    // Find best entry timing
    const bestEntryHour = this.findBestEntryHour(entryTiming);
    const bestEntryDay = this.findBestEntryDay(entryTiming);

    // Find preferred market conditions
    const preferredTokenAge = this.findPreferredTokenAge(marketConditions);
    const preferredLiquidity = this.findPreferredLiquidity(marketConditions);

    // Calculate pattern success rates
    const dcaSuccessRate = this.calculatePatternSuccessRate(patterns, 'dca');
    const reentrySuccessRate = this.calculatePatternSuccessRate(patterns, 'reentry');
    const scalpSuccessRate = this.calculatePatternSuccessRate(patterns, 'scalp');
    const swingSuccessRate = this.calculatePatternSuccessRate(patterns, 'swing');

    return {
      entryTiming,
      marketConditions,
      patterns,
      exitReasons,
      bestEntryHour,
      bestEntryDay,
      preferredTokenAge,
      preferredLiquidity,
      dcaSuccessRate,
      reentrySuccessRate,
      scalpSuccessRate,
      swingSuccessRate,
    };
  }

  /**
   * Calculate entry timing statistics
   */
  private calculateEntryTimingStats(closedLots: any[]): EntryTimingStats[] {
    const statsByHour = new Map<number, { total: number; wins: number; totalPnl: number; totalHoldTime: number }>();
    const statsByDay = new Map<number, { total: number; wins: number; totalPnl: number; totalHoldTime: number }>();

    for (const lot of closedLots) {
      if (lot.entryHourOfDay !== null && lot.entryHourOfDay !== undefined) {
        const hour = lot.entryHourOfDay;
        const stats = statsByHour.get(hour) || { total: 0, wins: 0, totalPnl: 0, totalHoldTime: 0 };
        stats.total++;
        if (lot.realizedPnl > 0) stats.wins++;
        stats.totalPnl += lot.realizedPnlPercent || 0;
        stats.totalHoldTime += lot.holdTimeMinutes || 0;
        statsByHour.set(hour, stats);
      }

      if (lot.entryDayOfWeek !== null && lot.entryDayOfWeek !== undefined) {
        const day = lot.entryDayOfWeek;
        const stats = statsByDay.get(day) || { total: 0, wins: 0, totalPnl: 0, totalHoldTime: 0 };
        stats.total++;
        if (lot.realizedPnl > 0) stats.wins++;
        stats.totalPnl += lot.realizedPnlPercent || 0;
        stats.totalHoldTime += lot.holdTimeMinutes || 0;
        statsByDay.set(day, stats);
      }
    }

    const result: EntryTimingStats[] = [];

    // Add hour stats
    for (const [hour, stats] of statsByHour.entries()) {
      result.push({
        hourOfDay: hour,
        dayOfWeek: -1, // Not applicable
        totalTrades: stats.total,
        winRate: stats.total > 0 ? stats.wins / stats.total : 0,
        avgPnlPercent: stats.total > 0 ? stats.totalPnl / stats.total : 0,
        avgHoldTimeMinutes: stats.total > 0 ? stats.totalHoldTime / stats.total : 0,
      });
    }

    // Add day stats
    for (const [day, stats] of statsByDay.entries()) {
      result.push({
        hourOfDay: -1, // Not applicable
        dayOfWeek: day,
        totalTrades: stats.total,
        winRate: stats.total > 0 ? stats.wins / stats.total : 0,
        avgPnlPercent: stats.total > 0 ? stats.totalPnl / stats.total : 0,
        avgHoldTimeMinutes: stats.total > 0 ? stats.totalHoldTime / stats.total : 0,
      });
    }

    return result;
  }

  /**
   * Calculate market condition statistics
   */
  private calculateMarketConditionStats(closedLots: any[]): MarketConditionStats[] {
    const stats = new Map<string, { total: number; wins: number; totalPnl: number }>();

    for (const lot of closedLots) {
      // Token age ranges
      if (lot.tokenAgeAtEntryMinutes !== null && lot.tokenAgeAtEntryMinutes !== undefined) {
        const ageMinutes = lot.tokenAgeAtEntryMinutes;
        let ageRange = 'unknown';
        if (ageMinutes < 60) ageRange = '< 1 hour';
        else if (ageMinutes < 1440) ageRange = '1-24 hours';
        else if (ageMinutes < 10080) ageRange = '1-7 days';
        else ageRange = '> 7 days';

        const key = `age_${ageRange}`;
        const stat = stats.get(key) || { total: 0, wins: 0, totalPnl: 0 };
        stat.total++;
        if (lot.realizedPnl > 0) stat.wins++;
        stat.totalPnl += lot.realizedPnlPercent || 0;
        stats.set(key, stat);
      }

      // Liquidity ranges
      if (lot.entryLiquidity !== null && lot.entryLiquidity !== undefined) {
        const liquidity = lot.entryLiquidity;
        let liquidityRange = 'unknown';
        if (liquidity < 10000) liquidityRange = '< 10k';
        else if (liquidity < 50000) liquidityRange = '10k-50k';
        else if (liquidity < 200000) liquidityRange = '50k-200k';
        else liquidityRange = '> 200k';

        const key = `liquidity_${liquidityRange}`;
        const stat = stats.get(key) || { total: 0, wins: 0, totalPnl: 0 };
        stat.total++;
        if (lot.realizedPnl > 0) stat.wins++;
        stat.totalPnl += lot.realizedPnlPercent || 0;
        stats.set(key, stat);
      }

      // Market cap ranges
      if (lot.entryMarketCap !== null && lot.entryMarketCap !== undefined) {
        const marketCap = lot.entryMarketCap;
        let marketCapRange = 'unknown';
        if (marketCap < 100000) marketCapRange = '< 100k';
        else if (marketCap < 1000000) marketCapRange = '100k-1M';
        else if (marketCap < 10000000) marketCapRange = '1M-10M';
        else marketCapRange = '> 10M';

        const key = `marketcap_${marketCapRange}`;
        const stat = stats.get(key) || { total: 0, wins: 0, totalPnl: 0 };
        stat.total++;
        if (lot.realizedPnl > 0) stat.wins++;
        stat.totalPnl += lot.realizedPnlPercent || 0;
        stats.set(key, stat);
      }
    }

    const result: MarketConditionStats[] = [];

    for (const [key, stat] of stats.entries()) {
      const [type, range] = key.split('_');
      result.push({
        tokenAgeRange: type === 'age' ? range : 'unknown',
        liquidityRange: type === 'liquidity' ? range : 'unknown',
        marketCapRange: type === 'marketcap' ? range : 'unknown',
        totalTrades: stat.total,
        winRate: stat.total > 0 ? stat.wins / stat.total : 0,
        avgPnlPercent: stat.total > 0 ? stat.totalPnl / stat.total : 0,
      });
    }

    return result;
  }

  /**
   * Calculate pattern statistics
   */
  private calculatePatternStats(closedLots: any[]): PatternStats[] {
    const patterns: PatternStats[] = [];
    
    // DCA pattern
    const dcaLots = closedLots.filter(lot => lot.dcaEntryCount && lot.dcaEntryCount > 1);
    if (dcaLots.length > 0) {
      const wins = dcaLots.filter(lot => lot.realizedPnl > 0).length;
      const totalPnl = dcaLots.reduce((sum, lot) => sum + (lot.realizedPnlPercent || 0), 0);
      const totalHoldTime = dcaLots.reduce((sum, lot) => sum + (lot.holdTimeMinutes || 0), 0);
      patterns.push({
        patternType: 'dca',
        totalTrades: dcaLots.length,
        winRate: wins / dcaLots.length,
        avgPnlPercent: totalPnl / dcaLots.length,
        avgHoldTimeMinutes: totalHoldTime / dcaLots.length,
      });
    }

    // Single entry pattern
    const singleEntryLots = closedLots.filter(lot => !lot.dcaEntryCount || lot.dcaEntryCount === 1);
    if (singleEntryLots.length > 0) {
      const wins = singleEntryLots.filter(lot => lot.realizedPnl > 0).length;
      const totalPnl = singleEntryLots.reduce((sum, lot) => sum + (lot.realizedPnlPercent || 0), 0);
      const totalHoldTime = singleEntryLots.reduce((sum, lot) => sum + (lot.holdTimeMinutes || 0), 0);
      patterns.push({
        patternType: 'single_entry',
        totalTrades: singleEntryLots.length,
        winRate: wins / singleEntryLots.length,
        avgPnlPercent: totalPnl / singleEntryLots.length,
        avgHoldTimeMinutes: totalHoldTime / singleEntryLots.length,
      });
    }

    // Re-entry pattern
    const reentryLots = closedLots.filter(lot => lot.reentryTimeMinutes !== null && lot.reentryTimeMinutes !== undefined);
    if (reentryLots.length > 0) {
      const wins = reentryLots.filter(lot => lot.realizedPnl > 0).length;
      const totalPnl = reentryLots.reduce((sum, lot) => sum + (lot.realizedPnlPercent || 0), 0);
      const totalHoldTime = reentryLots.reduce((sum, lot) => sum + (lot.holdTimeMinutes || 0), 0);
      patterns.push({
        patternType: 'reentry',
        totalTrades: reentryLots.length,
        winRate: wins / reentryLots.length,
        avgPnlPercent: totalPnl / reentryLots.length,
        avgHoldTimeMinutes: totalHoldTime / reentryLots.length,
      });
    }

    // Scalp pattern (hold time < 5 minutes)
    const scalpLots = closedLots.filter(lot => lot.holdTimeMinutes < 5);
    if (scalpLots.length > 0) {
      const wins = scalpLots.filter(lot => lot.realizedPnl > 0).length;
      const totalPnl = scalpLots.reduce((sum, lot) => sum + (lot.realizedPnlPercent || 0), 0);
      const totalHoldTime = scalpLots.reduce((sum, lot) => sum + (lot.holdTimeMinutes || 0), 0);
      patterns.push({
        patternType: 'scalp',
        totalTrades: scalpLots.length,
        winRate: wins / scalpLots.length,
        avgPnlPercent: totalPnl / scalpLots.length,
        avgHoldTimeMinutes: totalHoldTime / scalpLots.length,
      });
    }

    // Swing pattern (hold time > 24 hours)
    const swingLots = closedLots.filter(lot => lot.holdTimeMinutes > 1440);
    if (swingLots.length > 0) {
      const wins = swingLots.filter(lot => lot.realizedPnl > 0).length;
      const totalPnl = swingLots.reduce((sum, lot) => sum + (lot.realizedPnlPercent || 0), 0);
      const totalHoldTime = swingLots.reduce((sum, lot) => sum + (lot.holdTimeMinutes || 0), 0);
      patterns.push({
        patternType: 'swing',
        totalTrades: swingLots.length,
        winRate: wins / swingLots.length,
        avgPnlPercent: totalPnl / swingLots.length,
        avgHoldTimeMinutes: totalHoldTime / swingLots.length,
      });
    }

    return patterns;
  }

  /**
   * Calculate exit reason statistics
   */
  private calculateExitReasonStats(closedLots: any[]): ExitReasonStats[] {
    const stats = new Map<string, { total: number; wins: number; totalPnl: number; totalHoldTime: number }>();

    for (const lot of closedLots) {
      const reason = lot.exitReason || 'unknown';
      const stat = stats.get(reason) || { total: 0, wins: 0, totalPnl: 0, totalHoldTime: 0 };
      stat.total++;
      if (lot.realizedPnl > 0) stat.wins++;
      stat.totalPnl += lot.realizedPnlPercent || 0;
      stat.totalHoldTime += lot.holdTimeMinutes || 0;
      stats.set(reason, stat);
    }

    const result: ExitReasonStats[] = [];

    for (const [reason, stat] of stats.entries()) {
      result.push({
        exitReason: reason as any,
        totalTrades: stat.total,
        winRate: stat.total > 0 ? stat.wins / stat.total : 0,
        avgPnlPercent: stat.total > 0 ? stat.totalPnl / stat.total : 0,
        avgHoldTimeMinutes: stat.total > 0 ? stat.totalHoldTime / stat.total : 0,
      });
    }

    return result;
  }

  /**
   * Find best entry hour (highest win rate)
   */
  private findBestEntryHour(entryTiming: EntryTimingStats[]): number | null {
    const hourStats = entryTiming.filter(s => s.hourOfDay >= 0 && s.dayOfWeek < 0);
    if (hourStats.length === 0) return null;

    const best = hourStats.reduce((best, current) => {
      return current.winRate > best.winRate ? current : best;
    });

    return best.hourOfDay;
  }

  /**
   * Find best entry day (highest win rate)
   */
  private findBestEntryDay(entryTiming: EntryTimingStats[]): number | null {
    const dayStats = entryTiming.filter(s => s.dayOfWeek >= 0 && s.hourOfDay < 0);
    if (dayStats.length === 0) return null;

    const best = dayStats.reduce((best, current) => {
      return current.winRate > best.winRate ? current : best;
    });

    return best.dayOfWeek;
  }

  /**
   * Find preferred token age range
   */
  private findPreferredTokenAge(marketConditions: MarketConditionStats[]): string | null {
    const ageStats = marketConditions.filter(s => s.tokenAgeRange !== 'unknown');
    if (ageStats.length === 0) return null;

    const best = ageStats.reduce((best, current) => {
      return current.winRate > best.winRate ? current : best;
    });

    return best.tokenAgeRange;
  }

  /**
   * Find preferred liquidity range
   */
  private findPreferredLiquidity(marketConditions: MarketConditionStats[]): string | null {
    const liquidityStats = marketConditions.filter(s => s.liquidityRange !== 'unknown');
    if (liquidityStats.length === 0) return null;

    const best = liquidityStats.reduce((best, current) => {
      return current.winRate > best.winRate ? current : best;
    });

    return best.liquidityRange;
  }

  /**
   * Calculate success rate for a pattern
   */
  private calculatePatternSuccessRate(patterns: PatternStats[], patternType: string): number | null {
    const pattern = patterns.find(p => p.patternType === patternType);
    return pattern ? pattern.winRate : null;
  }

  /**
   * Get empty analytics (when no data available)
   */
  private getEmptyAnalytics(): CopytradingAnalytics {
    return {
      entryTiming: [],
      marketConditions: [],
      patterns: [],
      exitReasons: [],
      bestEntryHour: null,
      bestEntryDay: null,
      preferredTokenAge: null,
      preferredLiquidity: null,
      dcaSuccessRate: null,
      reentrySuccessRate: null,
      scalpSuccessRate: null,
      swingSuccessRate: null,
    };
  }
}
