import { PaperTradeService, PaperTradingConfig } from './paper-trade.service.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { supabase, TABLES } from '../lib/supabase.js';

export interface RiskLevel {
  level: 'low' | 'medium' | 'high';
  positionSizePercent: number; // 5-20%
  description: string;
}

export interface TradeQuality {
  score: number; // 0-100
  riskLevel: RiskLevel;
  shouldCopy: boolean;
  reasoning: string;
}

export interface ConsensusTrade {
  tokenId: string;
  walletIds: string[];
  firstBuyTime: Date;
  lastBuyTime: Date;
  timeSpanMinutes: number;
  walletCount: number;
  avgWalletScore: number;
  totalBuyAmount: number;
}

const INITIAL_CAPITAL_USD = 1000;
const MIN_POSITION_SIZE_PERCENT = 5;
const MAX_POSITION_SIZE_PERCENT = 20;

export class PaperTradingModelsService {
  private paperTradeService: PaperTradeService;
  private tradeRepo: TradeRepository;
  private smartWalletRepo: SmartWalletRepository;
  private tokenRepo: TokenRepository;

  constructor() {
    this.paperTradeService = new PaperTradeService();
    this.tradeRepo = new TradeRepository();
    this.smartWalletRepo = new SmartWalletRepository();
    this.tokenRepo = new TokenRepository();
  }

  /**
   * Model 1: Smart Copy Trading
   * Filtruje trades podle kvality a rizika
   */
  async evaluateTradeForSmartCopy(
    tradeId: string
  ): Promise<TradeQuality> {
    const trade = await this.tradeRepo.findById(tradeId);
    if (!trade || trade.side !== 'buy') {
      return {
        score: 0,
        riskLevel: { level: 'high', positionSizePercent: 5, description: 'Invalid trade' },
        shouldCopy: false,
        reasoning: 'Not a BUY trade',
      };
    }

    // Načti wallet metrics
    const wallet = await this.smartWalletRepo.findById(trade.walletId);
    if (!wallet) {
      return {
        score: 0,
        riskLevel: { level: 'high', positionSizePercent: 5, description: 'Wallet not found' },
        shouldCopy: false,
        reasoning: 'Wallet not found',
      };
    }

    // Načti token data
    const token = await this.tokenRepo.findById(trade.tokenId);
    
    // Vypočti score (0-100)
    let score = 0;
    const reasoning: string[] = [];

    // 1. Wallet Score (max 40 bodů)
    const walletScore = wallet.score || 0;
    score += (walletScore / 100) * 40;
    reasoning.push(`Wallet score: ${walletScore.toFixed(1)}/100 (+${((walletScore / 100) * 40).toFixed(1)} points)`);

    // 2. Win Rate (max 25 bodů)
    const winRate = wallet.winRate || 0;
    score += winRate * 25;
    reasoning.push(`Win rate: ${(winRate * 100).toFixed(1)}% (+${(winRate * 25).toFixed(1)} points)`);

    // 3. Recent PnL 30d (max 20 bodů)
    const recentPnl30d = wallet.recentPnl30dPercent || 0;
    const pnlScore = Math.min(Math.max(recentPnl30d / 10, 0), 1) * 20; // 0% = 0, 10%+ = 20
    score += pnlScore;
    reasoning.push(`Recent PnL 30d: ${recentPnl30d.toFixed(1)}% (+${pnlScore.toFixed(1)} points)`);

    // 4. Total Trades (max 10 bodů) - více trades = více zkušeností
    const totalTrades = wallet.totalTrades || 0;
    const tradesScore = Math.min(totalTrades / 100, 1) * 10; // 100+ trades = 10
    score += tradesScore;
    reasoning.push(`Total trades: ${totalTrades} (+${tradesScore.toFixed(1)} points)`);

    // 5. Max Drawdown penalty (max -5 bodů)
    const maxDrawdown = wallet.maxDrawdownPercent || 0;
    const drawdownPenalty = Math.min(Math.max(maxDrawdown / 20, 0), 1) * 5; // 20%+ drawdown = -5
    score -= drawdownPenalty;
    if (drawdownPenalty > 0) {
      reasoning.push(`Max drawdown: ${maxDrawdown.toFixed(1)}% (-${drawdownPenalty.toFixed(1)} points)`);
    }

    // 6. Avg PnL % (max 5 bodů)
    const avgPnlPercent = wallet.avgPnlPercent || 0;
    const avgPnlScore = Math.min(Math.max(avgPnlPercent / 5, 0), 1) * 5; // 5%+ avg = 5
    score += avgPnlScore;
    reasoning.push(`Avg PnL %: ${avgPnlPercent.toFixed(1)}% (+${avgPnlScore.toFixed(1)} points)`);

    // Urči risk level a position size
    let riskLevel: RiskLevel;
    if (score >= 70) {
      riskLevel = {
        level: 'low',
        positionSizePercent: 15, // 15% pro low risk
        description: 'Low risk - High quality wallet',
      };
    } else if (score >= 50) {
      riskLevel = {
        level: 'medium',
        positionSizePercent: 10, // 10% pro medium risk
        description: 'Medium risk - Moderate quality wallet',
      };
    } else {
      riskLevel = {
        level: 'high',
        positionSizePercent: 5, // 5% pro high risk
        description: 'High risk - Lower quality wallet',
      };
    }

    // Rozhodni, jestli kopírovat (min score 40)
    const shouldCopy = score >= 40;

    return {
      score: Math.max(0, Math.min(100, score)),
      riskLevel,
      shouldCopy,
      reasoning: reasoning.join('; '),
    };
  }

  /**
   * Model 2: Consensus Trading
   * Hledá tokeny, které koupily alespoň 2 smart wallets v rozestupu 2h
   * @param timeWindowHours - časové okno pro hledání consensus (default 2h)
   * @param minTimestamp - minimální timestamp - kopíruje jen consensus trades, které obsahují alespoň jeden NOVÝ trade (novější než minTimestamp)
   */
  async findConsensusTrades(
    timeWindowHours: number = 2,
    minTimestamp?: Date
  ): Promise<ConsensusTrade[]> {
    const timeWindowMs = timeWindowHours * 60 * 60 * 1000;
    const now = new Date();
    const windowStart = new Date(now.getTime() - timeWindowMs);

    // Najdi všechny BUY trades v časovém okně (posledních 2h)
    // Pokud je minTimestamp, zahrneme i starší trades (pro consensus), ale filtrujeme jen ty, které mají alespoň jeden nový trade
    let query = supabase
      .from(TABLES.TRADE)
      .select('id, walletId, tokenId, timestamp, amountBase, side')
      .eq('side', 'buy')
      .neq('side', 'void')
      .gte('timestamp', windowStart.toISOString())
      .order('timestamp', { ascending: true });
    
    const { data: recentBuys, error } = await query;

    if (error || !recentBuys) {
      console.error('Error fetching recent buys:', error);
      return [];
    }

    if (!recentBuys || recentBuys.length === 0) {
      return [];
    }

    // Seskup podle tokenId
    const tradesByToken = new Map<string, typeof recentBuys>();
    for (const trade of recentBuys) {
      if (!tradesByToken.has(trade.tokenId)) {
        tradesByToken.set(trade.tokenId, []);
      }
      tradesByToken.get(trade.tokenId)!.push(trade);
    }

    const consensusTrades: ConsensusTrade[] = [];

    // Pro každý token zkontroluj, jestli má alespoň 2 různé wallets
    for (const [tokenId, trades] of tradesByToken.entries()) {
      const uniqueWallets = new Set(trades.map(t => t.walletId));
      
      if (uniqueWallets.size >= 2) {
        // Načti wallet scores pro průměr
        const walletIds = Array.from(uniqueWallets) as string[];
        const wallets = await Promise.all(
          walletIds.map((id: string) => this.smartWalletRepo.findById(id).catch(() => null))
        );
        const validWallets = wallets.filter(w => w !== null);
        const avgWalletScore = validWallets.length > 0
          ? validWallets.reduce((sum, w) => sum + (w?.score || 0), 0) / validWallets.length
          : 0;

        // Najdi časové rozmezí
        const timestamps = trades.map((t: any) => new Date(t.timestamp));
        const firstBuyTime = new Date(Math.min(...timestamps.map((t: Date) => t.getTime())));
        const lastBuyTime = new Date(Math.max(...timestamps.map((t: Date) => t.getTime())));
        const timeSpanMinutes = (lastBuyTime.getTime() - firstBuyTime.getTime()) / (1000 * 60);

        // Zkontroluj, jestli je v rozestupu 2h
        if (timeSpanMinutes <= timeWindowHours * 60) {
          // Pokud je minTimestamp, zkontroluj, jestli consensus obsahuje alespoň jeden NOVÝ trade
          if (minTimestamp) {
            const hasNewTrade = trades.some((t: any) => new Date(t.timestamp) > minTimestamp);
            if (!hasNewTrade) {
              // Tento consensus trade neobsahuje žádný nový trade, přeskoč ho
              continue;
            }
          }

          const totalBuyAmount = trades.reduce((sum: number, t: any) => sum + Number(t.amountBase || 0), 0);

          consensusTrades.push({
            tokenId,
            walletIds: walletIds as string[],
            firstBuyTime,
            lastBuyTime,
            timeSpanMinutes,
            walletCount: uniqueWallets.size,
            avgWalletScore,
            totalBuyAmount,
          });
        }
      }
    }

    // Seřaď podle počtu wallets (více = lepší)
    return consensusTrades.sort((a, b) => b.walletCount - a.walletCount);
  }

  /**
   * Vypočítá position size podle rizika a základního kapitálu
   */
  calculatePositionSize(
    riskLevel: RiskLevel,
    originalTradeAmount: number,
    currentPortfolioValue: number = INITIAL_CAPITAL_USD
  ): { amountToken: number; amountBase: number } {
    // Position size jako % z portfolia
    const positionSizePercent = riskLevel.positionSizePercent;
    const positionSizeUsd = (currentPortfolioValue * positionSizePercent) / 100;

    // Omezení na min/max
    const minPositionUsd = (currentPortfolioValue * MIN_POSITION_SIZE_PERCENT) / 100;
    const maxPositionUsd = (currentPortfolioValue * MAX_POSITION_SIZE_PERCENT) / 100;
    const finalPositionSize = Math.max(minPositionUsd, Math.min(maxPositionUsd, positionSizeUsd));

    return {
      amountToken: 0, // Bude vypočítáno z positionSize a price v copyBuyTrade
      amountBase: finalPositionSize,
    };
  }

  /**
   * Zkopíruje trade pomocí Model 1 (Smart Copy Trading)
   */
  async copyTradeSmartCopy(
    tradeId: string,
    currentPortfolioValue: number = INITIAL_CAPITAL_USD
  ): Promise<{ success: boolean; paperTrade?: any; quality?: TradeQuality }> {
    const quality = await this.evaluateTradeForSmartCopy(tradeId);

    if (!quality.shouldCopy) {
      return {
        success: false,
        quality,
      };
    }

    const trade = await this.tradeRepo.findById(tradeId);
    if (!trade) {
      return { success: false };
    }

    // Vypočti position size podle rizika
    const positionSize = this.calculatePositionSize(
      quality.riskLevel,
      Number(trade.amountBase),
      currentPortfolioValue
    );

    // Vytvoř paper trade s upravenou velikostí
    const config: PaperTradingConfig = {
      enabled: true,
      copyAllTrades: false,
      positionSizePercent: quality.riskLevel.positionSizePercent,
      maxPositionSizeUsd: positionSize.amountBase,
      meta: {
        model: 'smart-copy',
        riskLevel: quality.riskLevel.level,
        qualityScore: quality.score,
      },
    };

    const paperTrade = await this.paperTradeService.copyBuyTrade(tradeId, config);

    return {
      success: !!paperTrade,
      paperTrade,
      quality,
    };
  }

  /**
   * Zkopíruje consensus trade (Model 2)
   * Větší position size pro consensus trades
   */
  async copyConsensusTrade(
    consensusTrade: ConsensusTrade,
    currentPortfolioValue: number = INITIAL_CAPITAL_USD
  ): Promise<{ success: boolean; paperTrades: any[] }> {
    const paperTrades: any[] = [];

    // Pro consensus trades použij position size podle počtu wallets
    // 2 wallets = 10%, 3+ wallets = 15%
    let positionSizePercent = 10; // Base 10% pro 2 wallets
    if (consensusTrade.walletCount >= 3) {
      positionSizePercent = 15; // 3+ wallets = 15%
    }

    // Najdi všechny BUY trades pro tento token v časovém okně
    const { data: trades } = await supabase
      .from(TABLES.TRADE)
      .select('id, walletId, tokenId, timestamp, amountBase')
      .eq('tokenId', consensusTrade.tokenId)
      .eq('side', 'buy')
      .in('walletId', consensusTrade.walletIds)
      .gte('timestamp', consensusTrade.firstBuyTime.toISOString())
      .lte('timestamp', consensusTrade.lastBuyTime.toISOString());

    if (!trades || trades.length === 0) {
      return { success: false, paperTrades: [] };
    }

    // Zkopíruj první trade s větší position size
    const firstTrade = trades[0];
    const positionSize = this.calculatePositionSize(
      { level: 'low', positionSizePercent, description: 'Consensus trade' },
      Number(firstTrade.amountBase || 0),
      currentPortfolioValue
    );

    // Urči risk level podle počtu wallets
    const riskLevel = consensusTrade.walletCount >= 3 ? 'low' : 'medium';
    
    const config: PaperTradingConfig = {
      enabled: true,
      copyAllTrades: false,
      positionSizePercent,
      maxPositionSizeUsd: positionSize.amountBase,
      meta: {
        model: 'consensus',
        riskLevel,
        qualityScore: consensusTrade.avgWalletScore,
      },
    };

    const paperTrade = await this.paperTradeService.copyBuyTrade(firstTrade.id, config);
    if (paperTrade) {
      paperTrades.push(paperTrade);
    }

    return {
      success: paperTrades.length > 0,
      paperTrades,
    };
  }
}
