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

const INITIAL_CAPITAL_USD = 1000;
const CONSENSUS_TIME_WINDOW_HOURS = 2;

export class ConsensusWebhookService {
  private paperTradeService: PaperTradeService;
  private paperTradeRepo: PaperTradeRepository;
  private signalService: SignalService;
  private tradeRepo: TradeRepository;
  private smartWalletRepo: SmartWalletRepository;

  constructor() {
    this.paperTradeService = new PaperTradeService();
    this.paperTradeRepo = new PaperTradeRepository();
    this.signalService = new SignalService();
    this.tradeRepo = new TradeRepository();
    this.smartWalletRepo = new SmartWalletRepository();
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

      // 5. Vypočti position size podle počtu wallets
      const portfolioStats = await this.paperTradeRepo.getPortfolioStats();
      const currentPortfolioValue = portfolioStats.totalValueUsd || INITIAL_CAPITAL_USD;
      
      let positionSizePercent = 10; // 2 wallets = 10%
      if (uniqueWallets.size >= 3) {
        positionSizePercent = 15; // 3+ wallets = 15%
      }

      const positionSize = (currentPortfolioValue * positionSizePercent) / 100;
      const riskLevel = uniqueWallets.size >= 3 ? 'low' : 'medium';

      // 6. Vytvoř paper trade při ceně druhého nákupu
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
        },
      };

      // Použij trade, který má být kopírován (druhý nebo aktuální)
      const paperTrade = await this.paperTradeService.copyBuyTrade(tradeToUseId, config);
      
      if (!paperTrade) {
        console.warn(`   ⚠️  Failed to create paper trade for consensus`);
        return { consensusFound: true };
      }

      console.log(`   ✅ Paper trade created: ${paperTrade.id.substring(0, 16)}... (${uniqueWallets.size} wallets, ${positionSizePercent}% position)`);

      // 7. Vytvoř signál
      try {
        const signal = await this.signalService.generateBuySignal(tradeToUseId, {
          minQualityScore: 0, // Consensus trades mají automaticky vysokou kvalitu
          enableConsensus: true,
        });

        if (signal) {
          console.log(`   📊 Signal created: ${signal.id.substring(0, 16)}...`);
          return { consensusFound: true, paperTradeCreated: paperTrade, signalCreated: signal };
        }
      } catch (signalError: any) {
        console.warn(`   ⚠️  Failed to create signal: ${signalError.message}`);
      }

      return { consensusFound: true, paperTradeCreated: paperTrade };
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
}
