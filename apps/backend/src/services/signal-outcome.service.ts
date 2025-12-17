/**
 * Signal Outcome Service
 * 
 * Level 1.1: Sleduje výsledky signálů a počítá success rate
 * - Kontroluje ceny tokenů po určité době
 * - Určuje win/loss/breakeven
 * - Agreguje statistiky
 */

import { generateId } from '../lib/prisma.js';
import { supabase, TABLES } from '../lib/supabase.js';
import { TokenMarketDataService } from './token-market-data.service.js';

export interface SignalOutcome {
  signalId: string;
  status: 'pending' | 'win' | 'loss' | 'breakeven' | 'expired';
  pnlPercent: number;
  hitSL: boolean;
  hitTP: boolean;
  maxPnlPercent: number;
  minPnlPercent: number;
  currentPrice: number;
  checkedAt: Date;
}

export interface SignalStatsAggregated {
  period: string;
  periodStart: Date;
  signalType: string | null;
  totalSignals: number;
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  expiredCount: number;
  winRate: number;
  avgPnlPercent: number;
  avgWinPnlPercent: number;
  avgLossPnlPercent: number;
  bestPnlPercent: number;
  worstPnlPercent: number;
  aiAccuracy: number;
}

export class SignalOutcomeService {
  private tokenMarketData: TokenMarketDataService;
  
  // Konfigurace
  private readonly WIN_THRESHOLD_PERCENT = 10; // +10% = win
  private readonly LOSS_THRESHOLD_PERCENT = -20; // -20% = loss
  private readonly CHECK_INTERVALS_MINUTES = [30, 60, 120, 240, 480, 1440]; // 30m, 1h, 2h, 4h, 8h, 24h

  constructor() {
    this.tokenMarketData = new TokenMarketDataService();
  }

  /**
   * Zkontroluje výsledek jednoho signálu
   */
  async checkSignalOutcome(signalId: string): Promise<SignalOutcome | null> {
    try {
      // 1. Načti signál
      const { data: signal, error } = await supabase
        .from(TABLES.SIGNAL)
        .select(`
          *,
          token:Token(mintAddress, symbol)
        `)
        .eq('id', signalId)
        .single();

      if (error || !signal) {
        console.warn(`Signal ${signalId} not found`);
        return null;
      }

      // Pokud už má finální outcome, přeskoč
      if (signal.outcomeStatus && signal.outcomeStatus !== 'pending') {
        return {
          signalId,
          status: signal.outcomeStatus,
          pnlPercent: Number(signal.outcomePnlPercent || 0),
          hitSL: signal.outcomeHitSL || false,
          hitTP: signal.outcomeHitTP || false,
          maxPnlPercent: Number(signal.outcomeMaxPnlPercent || 0),
          minPnlPercent: Number(signal.outcomeMinPnlPercent || 0),
          currentPrice: Number(signal.outcomePriceAtCheck || 0),
          checkedAt: new Date(signal.outcomeCheckedAt || Date.now()),
        };
      }

      // 2. Získej aktuální cenu
      const mintAddress = signal.token?.mintAddress;
      if (!mintAddress) {
        console.warn(`No mint address for signal ${signalId}`);
        return null;
      }

      let currentPrice = 0;
      try {
        const marketData = await this.tokenMarketData.getMarketData(mintAddress);
        currentPrice = marketData?.price || 0;
      } catch (e) {
        console.warn(`Failed to get price for ${mintAddress}`);
        return null;
      }

      if (currentPrice === 0) {
        return null;
      }

      // 3. Vypočítej outcome
      const entryPrice = Number(signal.entryPriceUsd || signal.priceBasePerToken || 0);
      if (entryPrice === 0) {
        console.warn(`No entry price for signal ${signalId}`);
        return null;
      }

      const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
      const slPrice = Number(signal.stopLossPriceUsd || 0);
      const tpPrice = Number(signal.takeProfitPriceUsd || 0);
      
      // Track min/max
      const prevMaxPnl = Number(signal.outcomeMaxPnlPercent || pnlPercent);
      const prevMinPnl = Number(signal.outcomeMinPnlPercent || pnlPercent);
      const maxPnlPercent = Math.max(prevMaxPnl, pnlPercent);
      const minPnlPercent = Math.min(prevMinPnl, pnlPercent);

      // Urči status
      let status: SignalOutcome['status'] = 'pending';
      let hitSL = false;
      let hitTP = false;

      // Check SL/TP
      if (slPrice > 0 && currentPrice <= slPrice) {
        status = 'loss';
        hitSL = true;
      } else if (tpPrice > 0 && currentPrice >= tpPrice) {
        status = 'win';
        hitTP = true;
      } 
      // Check thresholds
      else if (pnlPercent >= this.WIN_THRESHOLD_PERCENT) {
        status = 'win';
      } else if (pnlPercent <= this.LOSS_THRESHOLD_PERCENT) {
        status = 'loss';
      }
      // Check expiry (24h od vytvoření)
      else {
        const signalAge = Date.now() - new Date(signal.createdAt).getTime();
        const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
        if (signalAge > maxAgeMs) {
          if (pnlPercent > -5 && pnlPercent < 5) {
            status = 'breakeven';
          } else if (pnlPercent > 0) {
            status = 'win';
          } else {
            status = 'loss';
          }
        }
      }

      // 4. Ulož výsledek
      await supabase
        .from(TABLES.SIGNAL)
        .update({
          outcomeStatus: status,
          outcomeCheckedAt: new Date().toISOString(),
          outcomePriceAtCheck: currentPrice,
          outcomePnlPercent: pnlPercent,
          outcomeHitSL: hitSL,
          outcomeHitTP: hitTP,
          outcomeMaxPriceUsd: entryPrice * (1 + maxPnlPercent / 100),
          outcomeMinPriceUsd: entryPrice * (1 + minPnlPercent / 100),
          outcomeMaxPnlPercent: maxPnlPercent,
          outcomeMinPnlPercent: minPnlPercent,
          updatedAt: new Date().toISOString(),
        })
        .eq('id', signalId);

      // 5. Zaloguj
      if (status !== 'pending') {
        console.log(`📊 Signal outcome: ${signal.token?.symbol} - ${status.toUpperCase()} (${pnlPercent.toFixed(1)}%)`);
      }

      return {
        signalId,
        status,
        pnlPercent,
        hitSL,
        hitTP,
        maxPnlPercent,
        minPnlPercent,
        currentPrice,
        checkedAt: new Date(),
      };
    } catch (error: any) {
      console.error(`Error checking signal outcome ${signalId}:`, error.message);
      return null;
    }
  }

  /**
   * Zkontroluje všechny pending signály
   */
  async checkAllPendingSignals(): Promise<{ checked: number; resolved: number }> {
    try {
      // Načti pending signály starší než 30 minut
      const minAge = new Date(Date.now() - 30 * 60 * 1000);
      
      const { data: signals, error } = await supabase
        .from(TABLES.SIGNAL)
        .select('id')
        .eq('status', 'active')
        .or('outcomeStatus.is.null,outcomeStatus.eq.pending')
        .lt('createdAt', minAge.toISOString())
        .limit(50);

      if (error || !signals || signals.length === 0) {
        return { checked: 0, resolved: 0 };
      }

      console.log(`🔍 Checking ${signals.length} pending signals...`);

      let resolved = 0;
      for (const signal of signals) {
        const outcome = await this.checkSignalOutcome(signal.id);
        if (outcome && outcome.status !== 'pending') {
          resolved++;
        }
        // Rate limit
        await new Promise(r => setTimeout(r, 200));
      }

      return { checked: signals.length, resolved };
    } catch (error: any) {
      console.error('Error checking pending signals:', error.message);
      return { checked: 0, resolved: 0 };
    }
  }

  /**
   * Spočítá agregované statistiky
   */
  async calculateStats(period: 'daily' | 'weekly' | 'monthly' | 'all_time', signalType?: string): Promise<SignalStatsAggregated | null> {
    try {
      // Určí časový rozsah
      let startDate: Date;
      const now = new Date();
      
      switch (period) {
        case 'daily':
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'weekly':
          const dayOfWeek = now.getDay();
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
          break;
        case 'monthly':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'all_time':
        default:
          startDate = new Date(2020, 0, 1);
      }

      // Query signály
      let query = supabase
        .from(TABLES.SIGNAL)
        .select('*')
        .gte('createdAt', startDate.toISOString())
        .not('outcomeStatus', 'is', null);

      if (signalType) {
        query = query.eq('model', signalType);
      }

      const { data: signals, error } = await query;

      if (error || !signals || signals.length === 0) {
        return null;
      }

      // Agregace
      const wins = signals.filter(s => s.outcomeStatus === 'win');
      const losses = signals.filter(s => s.outcomeStatus === 'loss');
      const breakevens = signals.filter(s => s.outcomeStatus === 'breakeven');
      const expired = signals.filter(s => s.outcomeStatus === 'expired');
      
      const pnls = signals
        .filter(s => s.outcomePnlPercent != null)
        .map(s => Number(s.outcomePnlPercent));
      
      const winPnls = wins
        .filter(s => s.outcomePnlPercent != null)
        .map(s => Number(s.outcomePnlPercent));
      
      const lossPnls = losses
        .filter(s => s.outcomePnlPercent != null)
        .map(s => Number(s.outcomePnlPercent));

      // AI accuracy
      const aiBuySignals = signals.filter(s => s.aiDecision === 'buy');
      const aiBuyWins = aiBuySignals.filter(s => s.outcomeStatus === 'win');
      const aiAccuracy = aiBuySignals.length > 0 
        ? (aiBuyWins.length / aiBuySignals.length) * 100 
        : 0;

      const stats: SignalStatsAggregated = {
        period,
        periodStart: startDate,
        signalType: signalType || null,
        totalSignals: signals.length,
        winCount: wins.length,
        lossCount: losses.length,
        breakevenCount: breakevens.length,
        expiredCount: expired.length,
        winRate: signals.length > 0 ? (wins.length / signals.length) * 100 : 0,
        avgPnlPercent: pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0,
        avgWinPnlPercent: winPnls.length > 0 ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0,
        avgLossPnlPercent: lossPnls.length > 0 ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length : 0,
        bestPnlPercent: pnls.length > 0 ? Math.max(...pnls) : 0,
        worstPnlPercent: pnls.length > 0 ? Math.min(...pnls) : 0,
        aiAccuracy,
      };

      // Ulož do SignalStats tabulky
      const { period: _p, periodStart: _ps, signalType: _st, ...statsWithoutKeys } = stats;
      await supabase
        .from('SignalStats')
        .upsert({
          id: generateId(),
          period,
          periodStart: startDate.toISOString().split('T')[0],
          signalType: signalType || null,
          ...statsWithoutKeys,
          updatedAt: new Date().toISOString(),
        }, {
          onConflict: 'period,periodStart,signalType',
        });

      return stats;
    } catch (error: any) {
      console.error('Error calculating stats:', error.message);
      return null;
    }
  }

  /**
   * Získá historické statistiky
   */
  async getHistoricalStats(days: number = 30): Promise<SignalStatsAggregated[]> {
    try {
      const { data, error } = await supabase
        .from('SignalStats')
        .select('*')
        .eq('period', 'daily')
        .order('periodStart', { ascending: false })
        .limit(days);

      if (error || !data) {
        return [];
      }

      return data as SignalStatsAggregated[];
    } catch (error: any) {
      console.error('Error getting historical stats:', error.message);
      return [];
    }
  }
}

