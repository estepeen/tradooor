/**
 * Backtest Service
 * 
 * Level 2.1: Historical backtesting engine
 * - Simuluje trading strategii na historických datech
 * - Počítá metriky (win rate, PnL, drawdown, Sharpe)
 * - Optimalizuje parametry
 */

import { generateId, prisma } from '../lib/prisma.js';
import { supabase, TABLES } from '../lib/supabase.js';

// Helper to check if Supabase is available
const isSupabaseAvailable = () => supabase && typeof supabase.from === 'function';

export interface BacktestConfig {
  name: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  
  // Signal filters
  signalTypes?: string[]; // ['consensus', 'whale-entry', ...]
  minWalletScore?: number;
  minWalletCount?: number;
  minAiConfidence?: number;
  
  // Position sizing
  positionSizePercent?: number;
  maxPositionsOpen?: number;
  
  // Exit rules
  stopLossPercent?: number;
  takeProfitPercent?: number;
  maxHoldTimeMinutes?: number;
  
  // Initial capital
  initialCapitalUsd?: number;
}

export interface BacktestResult {
  id: string;
  config: BacktestConfig;
  status: 'pending' | 'running' | 'completed' | 'failed';
  
  // Stats
  totalSignals: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  
  // PnL
  totalPnlPercent: number;
  totalPnlUsd: number;
  avgPnlPercent: number;
  bestTradePercent: number;
  worstTradePercent: number;
  
  // Risk metrics
  maxDrawdownPercent: number;
  sharpeRatio: number;
  profitFactor: number;
  
  // Trade details
  trades: BacktestTrade[];
  
  // Equity curve
  equityCurve: Array<{ date: Date; equity: number }>;
  
  completedAt?: Date;
}

export interface BacktestTrade {
  signalId?: string;
  tokenId: string;
  tokenSymbol: string;
  entryPrice: number;
  exitPrice: number;
  entryTime: Date;
  exitTime: Date;
  positionSizePercent: number;
  pnlPercent: number;
  pnlUsd: number;
  exitReason: 'take_profit' | 'stop_loss' | 'time_exit' | 'signal';
}

export class BacktestService {
  /**
   * Spustí backtest
   */
  async runBacktest(config: BacktestConfig): Promise<BacktestResult> {
    const id = generateId();
    
    console.log(`📊 Starting backtest: ${config.name}`);
    console.log(`   Period: ${config.startDate.toISOString()} - ${config.endDate.toISOString()}`);
    
    // Save initial backtest record
    await this.saveBacktestRecord(id, config, 'running');
    
    try {
      // 1. Načti historické signály
      const signals = await this.loadHistoricalSignals(config);
      console.log(`   Found ${signals.length} signals in period`);
      
      if (signals.length === 0) {
        const result = this.createEmptyResult(id, config);
        await this.updateBacktestRecord(id, result);
        return result;
      }
      
      // 2. Simuluj trading
      const trades = await this.simulateTrades(signals, config);
      console.log(`   Simulated ${trades.length} trades`);
      
      // 3. Spočítej metriky
      const result = this.calculateMetrics(id, config, signals.length, trades);
      
      // 4. Ulož výsledky
      await this.updateBacktestRecord(id, result);
      await this.saveBacktestTrades(id, trades);
      
      console.log(`✅ Backtest completed: Win Rate ${result.winRate.toFixed(1)}%, PnL ${result.totalPnlPercent.toFixed(1)}%`);
      
      return result;
    } catch (error: any) {
      console.error(`❌ Backtest failed: ${error.message}`);
      await this.updateBacktestRecord(id, {
        status: 'failed',
      } as any);
      throw error;
    }
  }

  /**
   * Načte historické signály
   */
  private async loadHistoricalSignals(config: BacktestConfig): Promise<any[]> {
    // Check if Supabase is available
    if (!isSupabaseAvailable()) {
      console.warn('⚠️  Supabase not available for loadHistoricalSignals');
      return [];
    }
    
    let query = supabase
      .from(TABLES.SIGNAL)
      .select(`
        *,
        token:Token(id, symbol, mintAddress)
      `)
      .gte('createdAt', config.startDate.toISOString())
      .lte('createdAt', config.endDate.toISOString())
      .order('createdAt', { ascending: true });
    
    // Apply filters
    if (config.signalTypes && config.signalTypes.length > 0) {
      query = query.in('model', config.signalTypes);
    }
    
    if (config.minAiConfidence) {
      query = query.gte('aiConfidence', config.minAiConfidence);
    }
    
    const { data, error } = await query;
    
    if (error) {
      throw new Error(`Failed to load signals: ${error.message}`);
    }
    
    // Additional filtering
    let signals = data || [];
    
    if (config.minWalletCount) {
      signals = signals.filter(s => 
        (s.meta?.walletCount || 1) >= config.minWalletCount!
      );
    }
    
    return signals;
  }

  /**
   * Simuluj trades
   */
  private async simulateTrades(signals: any[], config: BacktestConfig): Promise<BacktestTrade[]> {
    const trades: BacktestTrade[] = [];
    const openPositions: Map<string, any> = new Map(); // tokenId -> position
    
    const positionSize = config.positionSizePercent || 10;
    const stopLoss = config.stopLossPercent || 15;
    const takeProfit = config.takeProfitPercent || 50;
    const maxHoldTime = config.maxHoldTimeMinutes || 24 * 60; // 24h default
    const maxPositions = config.maxPositionsOpen || 5;
    
    for (const signal of signals) {
      const tokenId = signal.tokenId;
      const entryPrice = Number(signal.entryPriceUsd || signal.priceBasePerToken || 0);
      const signalTime = new Date(signal.createdAt);
      
      if (entryPrice === 0) continue;
      
      // Skip if already have position in this token
      if (openPositions.has(tokenId)) continue;
      
      // Skip if max positions reached
      if (openPositions.size >= maxPositions) continue;
      
      // Open position
      openPositions.set(tokenId, {
        signal,
        entryPrice,
        entryTime: signalTime,
        slPrice: entryPrice * (1 - stopLoss / 100),
        tpPrice: entryPrice * (1 + takeProfit / 100),
        maxHoldUntil: new Date(signalTime.getTime() + maxHoldTime * 60 * 1000),
      });
      
      // Check for exit using outcome data if available
      const outcomePrice = Number(signal.outcomePriceAtCheck || 0);
      const outcomeTime = signal.outcomeCheckedAt ? new Date(signal.outcomeCheckedAt) : null;
      
      if (outcomePrice > 0 && outcomeTime) {
        const position = openPositions.get(tokenId)!;
        let exitPrice = outcomePrice;
        let exitReason: BacktestTrade['exitReason'] = 'time_exit';
        
        // Determine exit reason
        if (outcomePrice <= position.slPrice) {
          exitPrice = position.slPrice;
          exitReason = 'stop_loss';
        } else if (outcomePrice >= position.tpPrice) {
          exitPrice = position.tpPrice;
          exitReason = 'take_profit';
        } else if (signal.outcomeHitSL) {
          exitPrice = position.slPrice;
          exitReason = 'stop_loss';
        } else if (signal.outcomeHitTP) {
          exitPrice = position.tpPrice;
          exitReason = 'take_profit';
        }
        
        // Calculate PnL
        const pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
        
        trades.push({
          signalId: signal.id,
          tokenId,
          tokenSymbol: signal.token?.symbol || 'Unknown',
          entryPrice: position.entryPrice,
          exitPrice,
          entryTime: position.entryTime,
          exitTime: outcomeTime,
          positionSizePercent: positionSize,
          pnlPercent,
          pnlUsd: 0, // Will be calculated later
          exitReason,
        });
        
        openPositions.delete(tokenId);
      }
    }
    
    // Close remaining open positions at max hold time
    for (const [tokenId, position] of openPositions) {
      // Use entry price as exit (conservative)
      trades.push({
        signalId: position.signal.id,
        tokenId,
        tokenSymbol: position.signal.token?.symbol || 'Unknown',
        entryPrice: position.entryPrice,
        exitPrice: position.entryPrice,
        entryTime: position.entryTime,
        exitTime: position.maxHoldUntil,
        positionSizePercent: positionSize,
        pnlPercent: 0,
        pnlUsd: 0,
        exitReason: 'time_exit',
      });
    }
    
    return trades;
  }

  /**
   * Spočítej metriky
   */
  private calculateMetrics(
    id: string,
    config: BacktestConfig,
    totalSignals: number,
    trades: BacktestTrade[]
  ): BacktestResult {
    const initialCapital = config.initialCapitalUsd || 1000;
    let currentCapital = initialCapital;
    const equityCurve: Array<{ date: Date; equity: number }> = [];
    let maxEquity = initialCapital;
    let maxDrawdown = 0;
    
    // Sort trades by entry time
    trades.sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());
    
    // Calculate PnL in USD and track equity
    for (const trade of trades) {
      const positionValue = currentCapital * (trade.positionSizePercent / 100);
      trade.pnlUsd = positionValue * (trade.pnlPercent / 100);
      currentCapital += trade.pnlUsd;
      
      equityCurve.push({
        date: trade.exitTime,
        equity: currentCapital,
      });
      
      // Track max drawdown
      if (currentCapital > maxEquity) {
        maxEquity = currentCapital;
      }
      const drawdown = ((maxEquity - currentCapital) / maxEquity) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
    
    // Calculate stats
    const wins = trades.filter(t => t.pnlPercent > 0);
    const losses = trades.filter(t => t.pnlPercent <= 0);
    const pnls = trades.map(t => t.pnlPercent);
    const winPnls = wins.map(t => t.pnlPercent);
    const lossPnls = losses.map(t => t.pnlPercent);
    
    const totalPnlPercent = ((currentCapital - initialCapital) / initialCapital) * 100;
    const avgPnl = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
    
    // Sharpe Ratio (simplified - assumes daily returns)
    const avgReturn = avgPnl;
    const stdDev = this.standardDeviation(pnls);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0; // Annualized
    
    // Profit Factor
    const grossProfit = winPnls.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(lossPnls.reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
    
    return {
      id,
      config,
      status: 'completed',
      totalSignals,
      totalTrades: trades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalPnlPercent,
      totalPnlUsd: currentCapital - initialCapital,
      avgPnlPercent: avgPnl,
      bestTradePercent: pnls.length > 0 ? Math.max(...pnls) : 0,
      worstTradePercent: pnls.length > 0 ? Math.min(...pnls) : 0,
      maxDrawdownPercent: maxDrawdown,
      sharpeRatio,
      profitFactor,
      trades,
      equityCurve,
      completedAt: new Date(),
    };
  }

  /**
   * Standard deviation
   */
  private standardDeviation(values: number[]): number {
    if (values.length === 0) return 0;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squareDiffs = values.map(v => Math.pow(v - avg, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / squareDiffs.length;
    return Math.sqrt(avgSquareDiff);
  }

  /**
   * Create empty result
   */
  private createEmptyResult(id: string, config: BacktestConfig): BacktestResult {
    return {
      id,
      config,
      status: 'completed',
      totalSignals: 0,
      totalTrades: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
      totalPnlPercent: 0,
      totalPnlUsd: 0,
      avgPnlPercent: 0,
      bestTradePercent: 0,
      worstTradePercent: 0,
      maxDrawdownPercent: 0,
      sharpeRatio: 0,
      profitFactor: 0,
      trades: [],
      equityCurve: [],
      completedAt: new Date(),
    };
  }

  /**
   * Save backtest record
   */
  private async saveBacktestRecord(id: string, config: BacktestConfig, status: string): Promise<void> {
    await supabase
      .from('BacktestRun')
      .insert({
        id,
        name: config.name,
        description: config.description,
        startDate: config.startDate.toISOString(),
        endDate: config.endDate.toISOString(),
        config,
        status,
        createdAt: new Date().toISOString(),
      });
  }

  /**
   * Update backtest record
   */
  private async updateBacktestRecord(id: string, result: Partial<BacktestResult>): Promise<void> {
    await supabase
      .from('BacktestRun')
      .update({
        status: result.status,
        totalSignals: result.totalSignals,
        totalTrades: result.totalTrades,
        winCount: result.winCount,
        lossCount: result.lossCount,
        winRate: result.winRate,
        totalPnlPercent: result.totalPnlPercent,
        maxDrawdownPercent: result.maxDrawdownPercent,
        sharpeRatio: result.sharpeRatio,
        results: {
          avgPnlPercent: result.avgPnlPercent,
          bestTradePercent: result.bestTradePercent,
          worstTradePercent: result.worstTradePercent,
          profitFactor: result.profitFactor,
          equityCurve: result.equityCurve?.slice(-100), // Last 100 points
        },
        completedAt: result.completedAt?.toISOString(),
      })
      .eq('id', id);
  }

  /**
   * Save backtest trades
   */
  private async saveBacktestTrades(backtestId: string, trades: BacktestTrade[]): Promise<void> {
    const records = trades.map(t => ({
      id: generateId(),
      backtestId,
      signalId: t.signalId,
      tokenId: t.tokenId,
      tokenSymbol: t.tokenSymbol,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      entryTime: t.entryTime.toISOString(),
      exitTime: t.exitTime.toISOString(),
      positionSizePercent: t.positionSizePercent,
      pnlPercent: t.pnlPercent,
      exitReason: t.exitReason,
    }));

    // Insert in batches (only if Supabase is available)
    if (isSupabaseAvailable()) {
      const batchSize = 100;
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        await supabase.from('BacktestTrade').insert(batch);
      }
    } else {
      console.warn('⚠️  Supabase not available for saveBacktestTrades');
    }
  }

  /**
   * Get all backtest runs
   */
  async getBacktestRuns(limit: number = 20): Promise<any[]> {
    // Check if Supabase is available
    if (!isSupabaseAvailable()) {
      console.warn('⚠️  Supabase not available for getBacktestRuns');
      return [];
    }
    
    const { data, error } = await supabase
      .from('BacktestRun')
      .select('*')
      .order('createdAt', { ascending: false })
      .limit(limit);

    if (error) return [];
    return data || [];
  }

  /**
   * Get backtest details
   */
  async getBacktestDetails(id: string): Promise<BacktestResult | null> {
    const { data: run, error } = await supabase
      .from('BacktestRun')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !run) return null;

    // Get trades
    const { data: trades } = await supabase
      .from('BacktestTrade')
      .select('*')
      .eq('backtestId', id)
      .order('entryTime', { ascending: true });

    return {
      ...run,
      trades: trades || [],
    } as BacktestResult;
  }
}

