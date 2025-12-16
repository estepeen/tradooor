/**
 * Consensus Webhook Service
 * 
 * Zpracovává consensus trades přímo z webhooku - když přijde nový BUY trade,
 * zkontroluje, jestli už jiná wallet koupila stejný token v posledních 2h.
 * Pokud ano a je to 2+ wallet, vytvoří signál a paper trade při ceně druhého nákupu.
 */

import { supabase, TABLES } from '../lib/supabase.js';
import { PaperTradeService, PaperTradingConfig } from './paper-trade.service.js';
import { PaperTradeRepository } from '../repositories/paper-trade.repository.js';
import { SignalService } from './signal.service.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { AIDecisionService } from './ai-decision.service.js';
import { TokenMarketDataService } from './token-market-data.service.js';

const INITIAL_CAPITAL_USD = 1000;
const CONSENSUS_TIME_WINDOW_HOURS = 2;

export class ConsensusWebhookService {
  private paperTradeService: PaperTradeService;
  private paperTradeRepo: PaperTradeRepository;
  private signalService: SignalService;
  private tradeRepo: TradeRepository;
  private smartWalletRepo: SmartWalletRepository;
  private aiDecisionService: AIDecisionService;
  private tokenMarketData: TokenMarketDataService;

  constructor() {
    this.paperTradeService = new PaperTradeService();
    this.paperTradeRepo = new PaperTradeRepository();
    this.signalService = new SignalService();
    this.tradeRepo = new TradeRepository();
    this.smartWalletRepo = new SmartWalletRepository();
    this.aiDecisionService = new AIDecisionService();
    this.tokenMarketData = new TokenMarketDataService();
  }

  /**
   * Zkontroluje consensus po uložení nového BUY trade z webhooku
   * @param newTradeId - ID nově uloženého BUY trade
   * @param tokenId - ID tokenu
   * @param walletId - ID wallet, která koupila
   * @param timestamp - Čas nákupu
   */
  async checkConsensusAfterBuy(
    newTradeId: string,
    tokenId: string,
    walletId: string,
    timestamp: Date
  ): Promise<{ consensusFound: boolean; paperTradeCreated?: any; signalCreated?: any }> {
    try {
      // 1. Zkontroluj, jestli už není otevřená pozice pro tento token
      const openPositions = await this.paperTradeRepo.findOpenPositions();
      const alreadyOpen = openPositions.some(pos => pos.tokenId === tokenId);
      if (alreadyOpen) {
        console.log(`   ⏭️  Consensus check skipped: token ${tokenId.substring(0, 16)}... already in open positions`);
        return { consensusFound: false };
      }

      // 2. Najdi všechny BUY trades pro tento token v posledních 2h
      const timeWindowStart = new Date(timestamp.getTime() - CONSENSUS_TIME_WINDOW_HOURS * 60 * 60 * 1000);
      const timeWindowEnd = new Date(timestamp.getTime() + CONSENSUS_TIME_WINDOW_HOURS * 60 * 60 * 1000);

      const { data: recentBuys, error } = await supabase
        .from(TABLES.TRADE)
        .select('id, walletId, tokenId, timestamp, amountBase, priceBasePerToken, side')
        .eq('tokenId', tokenId)
        .eq('side', 'buy')
        .neq('side', 'void')
        .gte('timestamp', timeWindowStart.toISOString())
        .lte('timestamp', timeWindowEnd.toISOString())
        .order('timestamp', { ascending: true });

      if (error || !recentBuys || recentBuys.length === 0) {
        return { consensusFound: false };
      }

      // 3. Zkontroluj, jestli jsou alespoň 2 různé wallets
      const uniqueWallets = new Set(recentBuys.map(t => t.walletId));
      if (uniqueWallets.size < 2) {
        return { consensusFound: false };
      }

      // 4. Najdi druhý nákup - použij cenu druhého nákupu pro paper trade
      // Seřaď trades podle timestampu
      const sortedBuys = recentBuys.sort((a, b) => 
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      // Pokud je aktuální trade druhý nebo pozdější, použij jeho cenu
      const currentTradeIndex = sortedBuys.findIndex(t => t.id === newTradeId);
      
      // Pokud je aktuální trade první, počkej na druhý (consensus ještě není)
      if (currentTradeIndex === 0 && sortedBuys.length === 1) {
        return { consensusFound: false };
      }

      // Použij druhý nákup (nebo aktuální, pokud je to druhý)
      const tradeToUse = currentTradeIndex >= 1 ? sortedBuys[currentTradeIndex] : sortedBuys[1];
      const tradeToUseId = tradeToUse.id;
      const tradeToUsePrice = Number(tradeToUse.priceBasePerToken || 0);

      console.log(`   🎯 Consensus found: ${uniqueWallets.size} wallets bought ${tokenId.substring(0, 16)}... in 2h window`);
      console.log(`      Using trade ${tradeToUseId.substring(0, 16)}... price: $${tradeToUsePrice.toFixed(6)}`);

      // 5. Nejdřív vytvoř SIGNAL (primární zdroj)
      const riskLevel = uniqueWallets.size >= 3 ? 'low' : 'medium';
      
      try {
        // Vytvoř consensus signal
        const signal = await this.signalService.generateConsensusSignal(
          tradeToUseId,
          uniqueWallets.size,
          riskLevel
        );

        if (!signal) {
          console.warn(`   ⚠️  Failed to create consensus signal`);
          return { consensusFound: true };
        }

        console.log(`   📊 Consensus signal created: ${signal.id.substring(0, 16)}... (${uniqueWallets.size} wallets)`);

        // 5b. AI Evaluace signálu
        try {
          const aiDecision = await this.evaluateSignalWithAI(
            signal,
            tradeToUse,
            uniqueWallets.size,
            sortedBuys
          );
          
          if (aiDecision) {
            console.log(`   🤖 AI Decision: ${aiDecision.decision} (${aiDecision.confidence}% confidence)`);
            
            // Aktualizuj Signal s AI rozhodnutím
            await this.updateSignalWithAI(signal.id, aiDecision);
          }
        } catch (aiError: any) {
          console.warn(`   ⚠️  AI evaluation failed: ${aiError.message}`);
        }

        // 6. Z signalu vytvoř paper trade
        const portfolioStats = await this.paperTradeRepo.getPortfolioStats();
        const currentPortfolioValue = portfolioStats.totalValueUsd || INITIAL_CAPITAL_USD;
        
        let positionSizePercent = 10; // 2 wallets = 10%
        if (uniqueWallets.size >= 3) {
          positionSizePercent = 15; // 3+ wallets = 15%
        }

        const positionSize = (currentPortfolioValue * positionSizePercent) / 100;

        const config: PaperTradingConfig = {
          enabled: true,
          copyAllTrades: false,
          positionSizePercent,
          maxPositionSizeUsd: positionSize,
          meta: {
            model: 'consensus',
            riskLevel,
            walletCount: uniqueWallets.size,
            consensusTriggerTradeId: newTradeId,
            signalId: signal.id, // Link paper trade to signal
          },
        };

        // Vytvoř paper trade z signalu
        const paperTrade = await this.paperTradeService.copyBuyTrade(tradeToUseId, config);
        
        if (paperTrade) {
          console.log(`   ✅ Paper trade created from signal: ${paperTrade.id.substring(0, 16)}... (${uniqueWallets.size} wallets, ${positionSizePercent}% position)`);
          return { consensusFound: true, signalCreated: signal, paperTradeCreated: paperTrade };
        } else {
          console.warn(`   ⚠️  Failed to create paper trade from signal`);
          return { consensusFound: true, signalCreated: signal };
        }
      } catch (signalError: any) {
        console.error(`❌ Error creating consensus signal: ${signalError.message}`);
        return { consensusFound: false };
      }
    } catch (error: any) {
      console.error(`❌ Error checking consensus after buy:`, error.message);
      return { consensusFound: false };
    }
  }

  /**
   * Zpracuje SELL trade z webhooku - uzavře odpovídající paper trade
   */
  async processSellTrade(sellTradeId: string): Promise<{ closed: boolean }> {
    try {
      const config: PaperTradingConfig = {
        enabled: true,
        copyAllTrades: false,
      };

      const closed = await this.paperTradeService.closePaperTrade(sellTradeId, config);
      
      if (closed) {
        console.log(`   ✅ Paper trade closed for SELL: ${sellTradeId.substring(0, 16)}...`);
        
        // Vytvoř SELL signál
        try {
          await this.signalService.generateSellSignal(sellTradeId, {});
        } catch (signalError: any) {
          console.warn(`   ⚠️  Failed to create SELL signal: ${signalError.message}`);
        }
      }

      return { closed: !!closed };
    } catch (error: any) {
      console.error(`❌ Error processing SELL trade:`, error.message);
      return { closed: false };
    }
  }

  /**
   * AI evaluace consensus signálu
   */
  private async evaluateSignalWithAI(
    signal: any,
    trade: any,
    walletCount: number,
    allBuys: any[]
  ): Promise<any> {
    try {
      // 1. Načti token info
      const { data: token } = await supabase
        .from(TABLES.TOKEN)
        .select('*')
        .eq('id', trade.tokenId)
        .single();

      if (!token) return null;

      // 2. Načti market data
      let marketData: any = null;
      try {
        marketData = await this.tokenMarketData.getMarketData(token.mintAddress);
      } catch (e) {
        // Market data není kritická
      }

      // 3. Načti wallet info pro všechny zúčastněné wallety
      const walletIds = [...new Set(allBuys.map(b => b.walletId))];
      const { data: wallets } = await supabase
        .from(TABLES.SMART_WALLET)
        .select('id, score, winRate, totalPnlPercent, tags')
        .in('id', walletIds);

      const avgWalletScore = wallets && wallets.length > 0
        ? wallets.reduce((sum, w) => sum + (w.score || 0), 0) / wallets.length
        : 50;

      const avgWinRate = wallets && wallets.length > 0
        ? wallets.reduce((sum, w) => sum + (w.winRate || 0), 0) / wallets.length
        : 0.5;

      // 4. Spočítej celkový volume
      const totalVolume = allBuys.reduce((sum, b) => sum + Number(b.amountBase || 0), 0);

      // 5. Vytvoř context pro AI
      const context = {
        // Required by SignalContext interface
        walletScore: avgWalletScore,
        walletWinRate: avgWinRate,
        walletRecentPnl30d: wallets && wallets.length > 0
          ? wallets.reduce((sum, w) => sum + (w.totalPnlPercent || 0), 0) / wallets.length
          : 0,
        // Optional context
        walletTotalTrades: 100, // placeholder
        walletAvgHoldTimeMin: 60, // placeholder
        tokenAge: marketData?.ageMinutes || 0,
        tokenSymbol: token.symbol,
        tokenMint: token.mintAddress,
        tokenLiquidity: marketData?.liquidity || 0,
        tokenVolume24h: marketData?.volume24h || 0,
        tokenMarketCap: marketData?.marketCap || 0,
        consensusWalletCount: walletCount,
        entryPriceUsd: Number(trade.priceBasePerToken || 0),
      };

      // 6. Vytvoř signál pro AI
      const signalForAI = {
        type: 'consensus' as const,
        strength: (walletCount >= 3 ? 'strong' : walletCount >= 2 ? 'medium' : 'weak') as 'weak' | 'medium' | 'strong',
        confidence: Math.min(95, 50 + walletCount * 10 + avgWalletScore * 0.3),
        reasoning: `${walletCount} smart wallets bought ${token.symbol} within 2h window`,
        suggestedAction: 'buy' as const,
        riskLevel: (walletCount >= 3 ? 'low' : 'medium') as 'low' | 'medium' | 'high',
        context,
      };

      // 7. Zavolej AI
      const decision = await this.aiDecisionService.evaluateSignal(signalForAI, context);
      
      return decision;
    } catch (error: any) {
      console.warn(`AI evaluation error: ${error.message}`);
      return null;
    }
  }

  /**
   * Aktualizuj Signal s AI rozhodnutím
   */
  private async updateSignalWithAI(signalId: string, aiDecision: any): Promise<void> {
    try {
      // Získej původní signal pro entry price
      const { data: signal } = await supabase
        .from(TABLES.SIGNAL)
        .select('priceBasePerToken')
        .eq('id', signalId)
        .single();

      const entryPrice = signal ? Number(signal.priceBasePerToken) : 0;
      
      // Spočítej SL/TP ceny
      const stopLossPrice = entryPrice > 0 && aiDecision.stopLossPercent
        ? entryPrice * (1 - aiDecision.stopLossPercent / 100)
        : null;
      
      const takeProfitPrice = entryPrice > 0 && aiDecision.takeProfitPercent
        ? entryPrice * (1 + aiDecision.takeProfitPercent / 100)
        : null;

      await supabase
        .from(TABLES.SIGNAL)
        .update({
          aiDecision: aiDecision.decision,
          aiConfidence: aiDecision.confidence,
          aiReasoning: aiDecision.reasoning,
          aiSuggestedPositionPercent: aiDecision.suggestedPositionPercent,
          aiStopLossPercent: aiDecision.stopLossPercent,
          aiTakeProfitPercent: aiDecision.takeProfitPercent,
          aiRiskScore: aiDecision.riskScore,
          entryPriceUsd: entryPrice,
          stopLossPriceUsd: stopLossPrice,
          takeProfitPriceUsd: takeProfitPrice,
          suggestedHoldTimeMinutes: aiDecision.expectedHoldTimeMinutes,
          updatedAt: new Date().toISOString(),
        })
        .eq('id', signalId);

      console.log(`   💾 Signal ${signalId.substring(0, 8)}... updated with AI decision`);
    } catch (error: any) {
      console.warn(`Failed to update signal with AI: ${error.message}`);
    }
  }
}
