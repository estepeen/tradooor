import { prisma } from '../lib/prisma.js';

export interface DailyStatsRecord {
  id: string;
  date: Date;

  // Signal statistics
  signalsReceived: number;
  signalsBlocked: number;
  signalsEmitted: number;

  // Gate failure breakdown
  blockedByLiquidity: number;
  blockedByMomentum: number;
  blockedByRisk: number;
  blockedByWallet: number;
  blockedByMcap: number;
  blockedByOther: number;

  // Trade statistics
  tradesExecuted: number;
  tradesSuccessful: number;
  tradesFailed: number;

  // PnL statistics
  totalPnlSol: number;
  totalPnlUsd: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWinPercent: number | null;
  avgLossPercent: number | null;
  largestWinPercent: number | null;
  largestLossPercent: number | null;

  // Position statistics
  positionsOpened: number;
  positionsClosed: number;
  avgHoldTimeMinutes: number | null;

  // Exit reason breakdown
  exitsBySl: number;
  exitsByTp1: number;
  exitsByTp2: number;
  exitsByTp3: number;
  exitsByTime: number;
  exitsByEmergency: number;
  exitsByWhaleDump: number;

  // Max drawdown
  maxDrawdownPercent: number | null;

  // SOL price
  solPriceOpen: number | null;
  solPriceClose: number | null;
  solPriceHigh: number | null;
  solPriceLow: number | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface DailyStatsUpdate {
  signalsReceived?: number;
  signalsBlocked?: number;
  signalsEmitted?: number;
  blockedByLiquidity?: number;
  blockedByMomentum?: number;
  blockedByRisk?: number;
  blockedByWallet?: number;
  blockedByMcap?: number;
  blockedByOther?: number;
  tradesExecuted?: number;
  tradesSuccessful?: number;
  tradesFailed?: number;
  totalPnlSol?: number;
  totalPnlUsd?: number;
  wins?: number;
  losses?: number;
  winRate?: number;
  avgWinPercent?: number;
  avgLossPercent?: number;
  largestWinPercent?: number;
  largestLossPercent?: number;
  positionsOpened?: number;
  positionsClosed?: number;
  avgHoldTimeMinutes?: number;
  exitsBySl?: number;
  exitsByTp1?: number;
  exitsByTp2?: number;
  exitsByTp3?: number;
  exitsByTime?: number;
  exitsByEmergency?: number;
  exitsByWhaleDump?: number;
  maxDrawdownPercent?: number;
  solPriceOpen?: number;
  solPriceClose?: number;
  solPriceHigh?: number;
  solPriceLow?: number;
}

export class DailyStatsRepository {
  /**
   * Get today's date at midnight UTC
   */
  private getTodayMidnight(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  /**
   * Get or create today's stats record
   */
  async getOrCreateToday(): Promise<DailyStatsRecord> {
    const today = this.getTodayMidnight();

    // Try to get existing
    const existing = await prisma.$queryRaw<DailyStatsRecord[]>`
      SELECT * FROM "DailyStats" WHERE date = ${today}
    `;

    if (existing.length > 0) {
      return existing[0];
    }

    // Create new
    const result = await prisma.$queryRaw<DailyStatsRecord[]>`
      INSERT INTO "DailyStats" (date) VALUES (${today})
      RETURNING *
    `;
    return result[0];
  }

  /**
   * Increment a counter field for today
   */
  async incrementToday(field: keyof DailyStatsUpdate, amount: number = 1): Promise<void> {
    const today = this.getTodayMidnight();

    // First ensure record exists
    await this.getOrCreateToday();

    // Then increment
    await prisma.$executeRaw`
      UPDATE "DailyStats"
      SET "${prisma.$queryRawUnsafe(field)}" = COALESCE("${prisma.$queryRawUnsafe(field)}", 0) + ${amount},
          "updatedAt" = NOW()
      WHERE date = ${today}
    `;
  }

  /**
   * Increment multiple counters atomically
   */
  async incrementMultiple(increments: Partial<Record<keyof DailyStatsUpdate, number>>): Promise<void> {
    const today = this.getTodayMidnight();

    // First ensure record exists
    await this.getOrCreateToday();

    // Build SET clause dynamically
    const setClauses: string[] = ['"updatedAt" = NOW()'];
    const values: any[] = [];

    for (const [field, amount] of Object.entries(increments)) {
      if (amount !== undefined && amount !== 0) {
        setClauses.push(`"${field}" = COALESCE("${field}", 0) + $${values.length + 1}`);
        values.push(amount);
      }
    }

    if (values.length === 0) return;

    // Use raw SQL with dynamic field names
    const sql = `
      UPDATE "DailyStats"
      SET ${setClauses.join(', ')}
      WHERE date = $${values.length + 1}
    `;

    await prisma.$executeRawUnsafe(sql, ...values, today);
  }

  /**
   * Update today's stats with calculated values
   */
  async updateToday(updates: DailyStatsUpdate): Promise<void> {
    const today = this.getTodayMidnight();

    // First ensure record exists
    await this.getOrCreateToday();

    // Build SET clause
    const setClauses: string[] = ['"updatedAt" = NOW()'];
    const values: any[] = [];

    for (const [field, value] of Object.entries(updates)) {
      if (value !== undefined) {
        setClauses.push(`"${field}" = $${values.length + 1}`);
        values.push(value);
      }
    }

    if (values.length === 0) return;

    const sql = `
      UPDATE "DailyStats"
      SET ${setClauses.join(', ')}
      WHERE date = $${values.length + 1}
    `;

    await prisma.$executeRawUnsafe(sql, ...values, today);
  }

  /**
   * Get stats for a specific date
   */
  async getByDate(date: Date): Promise<DailyStatsRecord | null> {
    const midnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const result = await prisma.$queryRaw<DailyStatsRecord[]>`
      SELECT * FROM "DailyStats" WHERE date = ${midnight}
    `;
    return result.length > 0 ? result[0] : null;
  }

  /**
   * Get stats for last N days
   */
  async getLastNDays(days: number): Promise<DailyStatsRecord[]> {
    const startDate = new Date();
    startDate.setUTCDate(startDate.getUTCDate() - days);
    startDate.setUTCHours(0, 0, 0, 0);

    return prisma.$queryRaw<DailyStatsRecord[]>`
      SELECT * FROM "DailyStats"
      WHERE date >= ${startDate}
      ORDER BY date DESC
    `;
  }

  /**
   * Get aggregated stats for a date range
   */
  async getAggregatedStats(startDate: Date, endDate: Date): Promise<{
    totalSignalsReceived: number;
    totalSignalsEmitted: number;
    totalTradesExecuted: number;
    totalPnlSol: number;
    overallWinRate: number | null;
    avgDailyPnlSol: number;
  }> {
    const result = await prisma.$queryRaw<Array<{
      total_signals: bigint;
      total_emitted: bigint;
      total_trades: bigint;
      total_pnl: string;
      total_wins: bigint;
      total_losses: bigint;
      days_count: bigint;
    }>>`
      SELECT
        COALESCE(SUM("signalsReceived"), 0) as total_signals,
        COALESCE(SUM("signalsEmitted"), 0) as total_emitted,
        COALESCE(SUM("tradesExecuted"), 0) as total_trades,
        COALESCE(SUM("totalPnlSol"), 0) as total_pnl,
        COALESCE(SUM(wins), 0) as total_wins,
        COALESCE(SUM(losses), 0) as total_losses,
        COUNT(*) as days_count
      FROM "DailyStats"
      WHERE date >= ${startDate} AND date <= ${endDate}
    `;

    const stats = result[0];
    const totalWins = Number(stats.total_wins);
    const totalLosses = Number(stats.total_losses);
    const totalPnl = Number(stats.total_pnl);
    const daysCount = Number(stats.days_count);

    return {
      totalSignalsReceived: Number(stats.total_signals),
      totalSignalsEmitted: Number(stats.total_emitted),
      totalTradesExecuted: Number(stats.total_trades),
      totalPnlSol: totalPnl,
      overallWinRate: totalWins + totalLosses > 0
        ? totalWins / (totalWins + totalLosses)
        : null,
      avgDailyPnlSol: daysCount > 0 ? totalPnl / daysCount : 0,
    };
  }
}
