import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { ClosedLotRepository, ClosedLotRecord } from '../repositories/closed-lot.repository.js';
import { TradeFeatureRepository, TradeFeatureRecord } from '../repositories/trade-feature.repository.js';
import { BinancePriceService } from './binance-price.service.js';

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
  realizedPnlUsd: number;
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
};

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

export class MetricsCalculatorService {
  private binancePriceService: BinancePriceService;

  constructor(
    private smartWalletRepo: SmartWalletRepository,
    private tradeRepo: TradeRepository,
    private metricsHistoryRepo: MetricsHistoryRepository,
    private closedLotRepo: ClosedLotRepository = new ClosedLotRepository(),
    private tradeFeatureRepo: TradeFeatureRepository = new TradeFeatureRepository()
  ) {
    this.binancePriceService = new BinancePriceService();
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
    
    // Use rolling stats for recentPnl30d (from closed lots, same as detail page)
    // This ensures consistency between homepage and detail page
    const rolling30d = rollingInsights.rolling['30d'];
    const recentPnl30dUsd = rolling30d?.realizedPnlUsd ?? 0;
    const recentPnl30dPercent = rolling30d?.realizedRoiPercent ?? 0;

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
      totalTrades,
      winRate,
      avgRr,
      avgPnlPercent,
      pnlTotalBase,
      avgHoldingTimeMin,
      maxDrawdownPercent,
      recentPnl30dPercent,
      recentPnl30dUsd,
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
      recentPnl30dUsd,
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

    // Minimální hodnota v base měně pro považování za reálný trade (filtruj airdropy/transfery)
    const MIN_BASE_VALUE = 0.0001; // 0.0001 SOL nebo base token

    for (const trade of trades) {
      const tokenId = trade.tokenId;
      const side = trade.side;
      const amount = Number(trade.amountToken);
      const price = Number(trade.priceBasePerToken);
      const amountBase = Number(trade.amountBase || 0);
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
    const closedPositions = positions.filter(p => 
      p.sellAmount && 
      p.sellPrice && 
      p.buyPrice && 
      p.buyPrice > 0
    );
    
    return closedPositions.reduce((sum, p) => {
      const buyValue = p.buyAmount * p.buyPrice;
      const sellValue = p.sellAmount! * p.sellPrice!;
      return sum + (sellValue - buyValue);
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

  private calculateRecentPnl30d(positions: Position[]): { percent: number; usd: number } {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentPositions = positions.filter(
      p => p.sellTimestamp && p.sellTimestamp >= thirtyDaysAgo
    );

    if (recentPositions.length === 0) {
      return { percent: 0, usd: 0 };
    }

    // Vypočti celkový ROI správně (celková investice vs celkový výnos), ne sčítání procent
    const totalBuyValue = recentPositions.reduce((sum, p) => {
      return sum + Number(p.buyPrice) * Number(p.buyAmount);
    }, 0);

    const totalSellValue = recentPositions.reduce((sum, p) => {
      return sum + Number(p.sellPrice!) * Number(p.sellAmount!);
    }, 0);

    // ROI v procentech
    if (totalBuyValue <= 0) {
      return { percent: 0, usd: 0 };
    }
    
    const totalPnl = totalSellValue - totalBuyValue;
    const pnlPercent = (totalPnl / totalBuyValue) * 100;

    return { percent: pnlPercent, usd: totalPnl };
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

    // DŮLEŽITÉ: Použij stejnou logiku jako portfolio endpoint (totalProceedsBase - totalCostBase z trades)
    // místo closed lots, aby byla konzistence s detailem tradera
    const [trades, tradeFeatures] = await Promise.all([
      this.tradeRepo.findAllForMetrics(walletId),
      this.fetchTradeFeaturesSafe(walletId, earliest),
    ]);

    const rolling = {} as Record<RollingWindowLabel, RollingWindowStats>;
    for (const [label, days] of Object.entries(WINDOW_CONFIG) as Array<[RollingWindowLabel, number]>) {
      const cutoff = new Date(now);
      cutoff.setDate(cutoff.getDate() - days);
      // STEJNÁ LOGIKA JAKO PORTFOLIO ENDPOINT: Filtruj closed positions podle lastSellTimestamp
      // Portfolio endpoint filtruje closed positions podle lastSellTimestamp (kdy byla pozice uzavřena)
      // Ne podle kdy byly trades, ale podle kdy byla pozice uzavřena!
      // Takže musíme použít všechny trades (pro výpočet balance a PnL), ale filtrovat podle lastSellTimestamp
      rolling[label] = await this.buildRollingWindowStatsFromTrades(trades, cutoff);
    }

    const behaviour = this.buildBehaviourStats(tradeFeatures);
    const scores = this.buildScoreBreakdown(rolling, behaviour);

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

  // Build rolling stats from trades (same logic as portfolio endpoint)
  // cutoff: filter closed positions by lastSellTimestamp (when position was closed)
  private async buildRollingWindowStatsFromTrades(trades: any[], cutoff?: Date): Promise<RollingWindowStats> {
    if (trades.length === 0) {
      return {
        realizedPnlUsd: 0,
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

    // Get current SOL price for conversion
    let solPriceUsd = 150; // Default fallback
    try {
      solPriceUsd = await this.binancePriceService.getCurrentSolPrice();
    } catch (error) {
      console.warn(`⚠️  Failed to fetch SOL price, using fallback: ${solPriceUsd}`);
    }

    // STEJNÁ LOGIKA JAKO PORTFOLIO ENDPOINT: totalProceedsBase - totalCostBase
    // Seskup trades podle tokenId a spočítej totalCostBase (BUY/ADD) a totalProceedsBase (SELL/REM)
    // Portfolio endpoint zahrnuje ADD/REM trades do balance výpočtu
    const positionMap = new Map<string, { 
      totalCostBase: number; 
      totalProceedsBase: number; 
      balance: number; // Balance = totalBought - totalSold (zahrnuje ADD/REM)
      baseToken: string;
      lastSellTimestamp: Date | null; // Kdy byla pozice uzavřena (poslední SELL/REM)
    }>();
    
    for (const trade of trades) {
      const tokenId = trade.tokenId;
      const amountBase = Number(trade.amountBase || 0);
      const amountToken = Number(trade.amountToken || 0);
      const baseToken = (trade.meta as any)?.baseToken || 'SOL';
      const tradeTimestamp = new Date(trade.timestamp);
      
      if (!positionMap.has(tokenId)) {
        positionMap.set(tokenId, { 
          totalCostBase: 0, 
          totalProceedsBase: 0, 
          balance: 0,
          baseToken,
          lastSellTimestamp: null
        });
      }
      
      const position = positionMap.get(tokenId)!;
      
      // STEJNÁ LOGIKA JAKO PORTFOLIO ENDPOINT: buy/add zvyšuje balance a cost, sell/remove snižuje balance a zvyšuje proceeds
      if (trade.side === 'buy' || trade.side === 'add') {
        position.totalCostBase += amountBase;
        position.balance += amountToken;
      } else if (trade.side === 'sell' || trade.side === 'remove') {
        position.totalProceedsBase += amountBase;
        position.balance -= amountToken;
        // Update lastSellTimestamp (kdy byla pozice uzavřena)
        if (!position.lastSellTimestamp || tradeTimestamp > position.lastSellTimestamp) {
          position.lastSellTimestamp = tradeTimestamp;
        }
      }
    }

    // Pro každou pozici spočítej closed PnL (stejně jako portfolio endpoint)
    // Portfolio endpoint počítá pouze uzavřené pozice (normalizedBalance <= 0)
    // A filtruje podle lastSellTimestamp (kdy byla pozice uzavřena)
    let totalRealizedPnlUsd = 0;
    let totalInvestedCapitalUsd = 0;
    const closedPositions: Array<{ pnlUsd: number; roiPercent: number }> = [];

    for (const [tokenId, position] of positionMap.entries()) {
      // STEJNÁ LOGIKA JAKO PORTFOLIO ENDPOINT: normalizedBalance <= 0 (treat small negatives as 0)
      const normalizedBalance = position.balance < 0 && Math.abs(position.balance) < 0.0001 ? 0 : position.balance;
      
      // Pouze closed positions (normalizedBalance <= 0 znamená, že byly prodány všechny tokeny)
      if (normalizedBalance <= 0 && position.totalProceedsBase > 0 && position.totalCostBase > 0) {
        // STEJNÁ LOGIKA JAKO PORTFOLIO ENDPOINT: Filtruj podle lastSellTimestamp (kdy byla pozice uzavřena)
        // Portfolio endpoint filtruje closed positions podle lastSellTimestamp, ne podle kdy byly trades
        if (cutoff && position.lastSellTimestamp) {
          if (position.lastSellTimestamp < cutoff) {
            continue; // Skip positions closed before cutoff
          }
        }
        const closedPnlBase = position.totalProceedsBase - position.totalCostBase;
        
        // Convert to USD (stejně jako portfolio endpoint)
        let closedPnlUsd = 0;
        if (position.baseToken === 'SOL') {
          closedPnlUsd = closedPnlBase * solPriceUsd;
        } else if (position.baseToken === 'USDC' || position.baseToken === 'USDT') {
          closedPnlUsd = closedPnlBase; // 1:1 with USD
        } else {
          closedPnlUsd = closedPnlBase * solPriceUsd; // Fallback
        }
        
        const investedCapitalUsd = position.totalCostBase * (position.baseToken === 'SOL' ? solPriceUsd : 1);
        const roiPercent = investedCapitalUsd > 0 ? (closedPnlUsd / investedCapitalUsd) * 100 : 0;
        
        totalRealizedPnlUsd += closedPnlUsd;
        totalInvestedCapitalUsd += investedCapitalUsd;
        closedPositions.push({ pnlUsd: closedPnlUsd, roiPercent });
      }
    }

    const realizedRoiPercent = totalInvestedCapitalUsd > 0 
      ? (totalRealizedPnlUsd / totalInvestedCapitalUsd) * 100 
      : 0;
    
    const wins = closedPositions.filter(p => p.pnlUsd > 0).length;
    const roiValues = closedPositions.map(p => p.roiPercent);

    return {
      realizedPnlUsd: totalRealizedPnlUsd,
      realizedRoiPercent,
      winRate: closedPositions.length ? wins / closedPositions.length : 0,
      medianTradeRoiPercent: median(roiValues),
      percentile5TradeRoiPercent: percentile(roiValues, 0.05),
      percentile95TradeRoiPercent: percentile(roiValues, 0.95),
      maxDrawdownPercent: 0, // TODO: Calculate from positions
      volatilityPercent: 0, // TODO: Calculate from positions
      medianHoldMinutesWinners: 0, // TODO: Calculate from positions
      medianHoldMinutesLosers: 0, // TODO: Calculate from positions
      numClosedTrades: closedPositions.length,
      totalVolumeUsd: totalInvestedCapitalUsd + totalRealizedPnlUsd, // Approximate
      avgTradeSizeUsd: closedPositions.length > 0 ? totalInvestedCapitalUsd / closedPositions.length : 0,
    };
  }

  // Keep old method for backward compatibility (used by closed lots)
  private async buildRollingWindowStats(lots: ClosedLotRecord[]): Promise<RollingWindowStats> {
    if (lots.length === 0) {
      return {
        realizedPnlUsd: 0,
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

    // Get current SOL price for conversion (approximation - ideally we'd use historical prices)
    let solPriceUsd = 150; // Default fallback
    try {
      solPriceUsd = await this.binancePriceService.getCurrentSolPrice();
    } catch (error) {
      console.warn(`⚠️  Failed to fetch SOL price, using fallback: ${solPriceUsd}`);
    }

    // Convert SOL amounts to USD
    // Note: realizedPnl, proceeds, and costBasis are in SOL (base currency)
    const realizedPnlUsd = lots.reduce((sum, lot) => sum + lot.realizedPnl * solPriceUsd, 0);
    const totalVolumeUsd = lots.reduce((sum, lot) => sum + lot.proceeds * solPriceUsd, 0);
    const investedCapital = lots.reduce((sum, lot) => sum + Math.max(lot.costBasis, 0) * solPriceUsd, 0);
    const realizedRoiPercent =
      investedCapital > 0 ? (realizedPnlUsd / investedCapital) * 100 : 0;
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
      realizedPnlUsd,
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
      totalVolumeUsd,
      avgTradeSizeUsd: totalVolumeUsd / lots.length,
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
    behaviour: BehaviourStats
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

    const smartScore = clamp(walletScoreRaw * sampleFactor, 0, 100);

    return {
      profitabilityScore,
      consistencyScore,
      riskScore,
      behaviourScore,
      sampleFactor,
      walletScoreRaw,
      smartScore,
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

