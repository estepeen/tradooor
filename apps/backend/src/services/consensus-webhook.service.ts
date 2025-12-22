/**
 * Consensus Webhook Service
 * 
 * Zpracovává consensus trades přímo z webhooku - když přijde nový BUY trade,
 * zkontroluje, jestli už jiná wallet koupila stejný token v posledních 2h.
 * Pokud ano a je to 2+ wallet, vytvoří signál a paper trade při ceně druhého nákupu.
 */

import { prisma } from '../lib/prisma.js';
import { PaperTradeService, PaperTradingConfig } from './paper-trade.service.js';
import { PaperTradeRepository } from '../repositories/paper-trade.repository.js';
import { SignalService } from './signal.service.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { SignalRepository } from '../repositories/signal.repository.js';
import { AIDecisionService } from './ai-decision.service.js';
import { TokenMarketDataService } from './token-market-data.service.js';
import { DiscordNotificationService, SignalNotificationData } from './discord-notification.service.js';
import { RugCheckService } from './rugcheck.service.js';
import { PositionMonitorService } from './position-monitor.service.js';

const INITIAL_CAPITAL_USD = 1000;
const CONSENSUS_TIME_WINDOW_HOURS = 2;

export class ConsensusWebhookService {
  private paperTradeService: PaperTradeService;
  private paperTradeRepo: PaperTradeRepository;
  private signalService: SignalService;
  private tradeRepo: TradeRepository;
  private smartWalletRepo: SmartWalletRepository;
  private tokenRepo: TokenRepository;
  private signalRepo: SignalRepository;
  private aiDecisionService: AIDecisionService;
  private tokenMarketData: TokenMarketDataService;
  private discordNotification: DiscordNotificationService;
  private rugCheck: RugCheckService;
  private positionMonitor: PositionMonitorService;

  constructor() {
    this.paperTradeService = new PaperTradeService();
    this.paperTradeRepo = new PaperTradeRepository();
    this.signalService = new SignalService();
    this.tradeRepo = new TradeRepository();
    this.smartWalletRepo = new SmartWalletRepository();
    this.tokenRepo = new TokenRepository();
    this.signalRepo = new SignalRepository();
    this.aiDecisionService = new AIDecisionService();
    this.tokenMarketData = new TokenMarketDataService();
    this.discordNotification = new DiscordNotificationService();
    this.rugCheck = new RugCheckService();
    this.positionMonitor = new PositionMonitorService();
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
    console.log(`🔍 [Consensus] Checking consensus for trade ${newTradeId.substring(0, 16)}... (token: ${tokenId.substring(0, 16)}..., wallet: ${walletId.substring(0, 16)}...)`);
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

      const recentBuys = await this.tradeRepo.findBuysByTokenAndTimeWindow(
        tokenId,
        timeWindowStart,
        timeWindowEnd
      );

      if (!recentBuys || recentBuys.length === 0) {
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
      // Cena v USD za token – preferuj valueUsd/amountToken, fallback na base price
      const tradeToUseAmountToken = Number(tradeToUse.amountToken || 0);
      const tradeToUseValueUsd = Number(tradeToUse.valueUsd || 0);
      let tradeToUsePrice = 0;
      if (tradeToUseAmountToken > 0 && tradeToUseValueUsd > 0) {
        tradeToUsePrice = tradeToUseValueUsd / tradeToUseAmountToken;
      } else {
        tradeToUsePrice = Number(tradeToUse.priceBasePerToken || 0);
      }

      console.log(`   🎯 [Consensus] Consensus found: ${uniqueWallets.size} wallets bought ${tokenId.substring(0, 16)}... in 2h window`);
      console.log(`      Using trade ${tradeToUseId.substring(0, 16)}... price: $${tradeToUsePrice.toFixed(6)}`);
      console.log(`   🤖 [Consensus] Will call AI decision service now...`);

      // 5. Zkontroluj existující signál a urči typ notifikace
      const riskLevel = uniqueWallets.size >= 3 ? 'low' : 'medium';
      let isUpdate = false;
      let previousWalletCount = 0;
      
      // Zkontroluj, jestli už existuje signal pro tento token
      const existingSignal = await this.signalRepo.findActiveByTokenAndModel(tokenId, 'consensus');

      if (existingSignal) {
        previousWalletCount = (existingSignal.meta as any)?.walletCount || 0;
        
        // Pokud je stejný nebo menší počet wallets, skip (nevoláme AI znovu)
        if (uniqueWallets.size <= previousWalletCount) {
          console.log(`   ⏭️  Consensus already notified for ${previousWalletCount} wallets, current: ${uniqueWallets.size} - skipping AI evaluation`);
          return { consensusFound: true };
        }
        
        // Nový wallet se přidal - update!
        isUpdate = true;
        console.log(`   📈 Consensus update: ${previousWalletCount} → ${uniqueWallets.size} wallets`);
        
        // Aktualizuj existující signal
        await this.signalRepo.update(existingSignal.id, {
          meta: {
            ...(existingSignal.meta as object || {}),
            walletCount: uniqueWallets.size,
            lastUpdateTradeId: newTradeId,
          },
          qualityScore: uniqueWallets.size >= 4 ? 90 : uniqueWallets.size >= 3 ? 80 : 60,
          riskLevel,
          reasoning: `Consensus: ${uniqueWallets.size} smart wallets bought this token within 2h window`,
        });
      }
      
      try {
        let signal: any = existingSignal;
        
        // Vytvoř nový signal pouze pokud neexistuje
        if (!existingSignal) {
          signal = await this.signalService.generateConsensusSignal(
            tradeToUseId,
            uniqueWallets.size,
            riskLevel
          );

          if (!signal) {
            console.warn(`   ⚠️  Failed to create consensus signal`);
            return { consensusFound: true };
          }
          
          console.log(`   📊 Consensus signal created: ${signal.id.substring(0, 16)}... (${uniqueWallets.size} wallets)`);
        }

        // 5b. AI Evaluace signálu
        let aiDecisionResult: any = null;
        let marketDataResult: any = null;
        let walletsData: any[] = [];
        
        try {
          // Check if GROQ_API_KEY is set
          const hasGroqKey = !!process.env.GROQ_API_KEY;
          if (!hasGroqKey) {
            console.warn(`   ⚠️  GROQ_API_KEY not set - AI decisions will use fallback rules`);
          } else {
            console.log(`   🤖 Calling AI decision service...`);
          }
          
          aiDecisionResult = await this.evaluateSignalWithAI(
            signal,
            tradeToUse,
            uniqueWallets.size,
            sortedBuys
          );
          
          if (aiDecisionResult && !aiDecisionResult.isFallback) {
            const model = aiDecisionResult.model || 'unknown';
            console.log(`   🤖 AI Decision (${model}): ${aiDecisionResult.decision} (${aiDecisionResult.confidence}% confidence)`);
            console.log(`      Reasoning: ${aiDecisionResult.reasoning?.substring(0, 100)}...`);
            console.log(`      Position: ${aiDecisionResult.suggestedPositionPercent}%, SL: ${aiDecisionResult.stopLossPercent}%, TP: ${aiDecisionResult.takeProfitPercent}%, Risk: ${aiDecisionResult.riskScore}/10`);
            
            // Aktualizuj Signal s AI rozhodnutím
            await this.updateSignalWithAI(signal.id, aiDecisionResult);
          } else if (aiDecisionResult && aiDecisionResult.isFallback) {
            // Use fallback decision if rate limited (better than showing "-")
            // Only skip if it's a parse error fallback, not rate limit fallback
            const isRateLimitFallback = aiDecisionResult.reasoning?.includes('Fallback decision based on');
            if (isRateLimitFallback) {
              console.warn(`   ⚠️  AI rate limited, using fallback decision (rule-based)`);
              // Keep aiDecisionResult - it will be used in Discord embed
            } else {
              console.warn(`   ⚠️  AI returned fallback decision - will not use (showing "-" instead)`);
              aiDecisionResult = null;
            }
          } else {
            console.warn(`   ⚠️  AI evaluation returned null - AI not available`);
          }
        } catch (aiError: any) {
          console.error(`   ❌ AI evaluation failed: ${aiError.message}`);
          console.error(`   Stack: ${aiError.stack}`);
        }

        // 5c. Pošli Discord notifikaci
        try {
          // Načti token info
          const token = await this.tokenRepo.findById(tradeToUse.tokenId);

          // Načti market data
          try {
            marketDataResult = await this.tokenMarketData.getMarketData(token?.mintAddress || '');
          } catch (e) {
            // ignoruj
          }

          // Načti wallet info
          const walletIds = sortedBuys.map(b => b.walletId);
          const wallets = await prisma.smartWallet.findMany({
            where: {
              id: { in: walletIds },
            },
            select: {
              id: true,
              address: true,
              label: true,
              score: true,
            },
          });

          // Spoj wallet info s trade info
          walletsData = wallets.map(w => {
            const trade = sortedBuys.find(b => b.walletId === w.id);
            if (!trade) {
              return {
                ...w,
                tradeAmountUsd: undefined,
                tradePrice: undefined,
                tradeTime: undefined,
              };
            }
            
            const amountToken = Number(trade.amountToken || 0);
            const valueUsd = Number(trade.valueUsd || 0);
            let priceUsdPerToken = 0;
            if (amountToken > 0 && valueUsd > 0) {
              priceUsdPerToken = valueUsd / amountToken;
            } else {
              priceUsdPerToken = Number(trade.priceBasePerToken || 0);
            }

            return {
              ...w,
              // Velikost pozice v base tokenu (SOL/USDC/USDT)
              tradeAmountUsd: Number(trade.amountBase || 0),
              // Cena v USD za 1 token
              tradePrice: priceUsdPerToken || undefined,
              tradeTime: trade.timestamp.toISOString(),
            };
          });
          
          const avgWalletScore = walletsData.length > 0
            ? walletsData.reduce((sum, w) => sum + (Number(w.score) || 0), 0) / walletsData.length
            : 50;

          // Získej base token z trade (default SOL)
          const baseToken = ((tradeToUse as any).meta?.baseToken || 'SOL').toUpperCase();

          // Spočítej SL/TP ceny
          const entryPrice = Number(tradeToUse.priceBasePerToken || 0);
          const stopLossPriceUsd = aiDecisionResult?.stopLossPercent && entryPrice
            ? entryPrice * (1 - aiDecisionResult.stopLossPercent / 100)
            : undefined;
          const takeProfitPriceUsd = aiDecisionResult?.takeProfitPercent && entryPrice
            ? entryPrice * (1 + aiDecisionResult.takeProfitPercent / 100)
            : undefined;

          // Načti security data z RugCheck
          let securityData: SignalNotificationData['security'] | undefined;
          try {
            const rugReport = await this.rugCheck.getReport(token?.mintAddress || '');
            if (rugReport) {
              securityData = {
                riskLevel: rugReport.riskLevel,
                riskScore: rugReport.riskScore,
                isLpLocked: rugReport.isLpLocked,
                lpLockedPercent: rugReport.lpLockedPercent,
                isDexPaid: rugReport.isDexPaid,
                isMintable: rugReport.isMintable,
                isFreezable: rugReport.isFreezable,
                isHoneypot: rugReport.isHoneypot,
                honeypotReason: rugReport.honeypotReason,
                buyTax: rugReport.buyTax,
                sellTax: rugReport.sellTax,
                hasDangerousTax: rugReport.hasDangerousTax,
                risks: rugReport.risks,
              };
              
              // Log security status
              if (rugReport.isHoneypot) {
                console.log(`   🍯🚨 HONEYPOT DETECTED for ${token?.symbol}! ${rugReport.honeypotReason || ''}`);
              } else {
                const taxInfo = rugReport.buyTax !== undefined || rugReport.sellTax !== undefined
                  ? ` | Tax: B${rugReport.buyTax || 0}%/S${rugReport.sellTax || 0}%`
                  : '';
                console.log(`   🛡️  RugCheck: ${rugReport.riskLevel} (${rugReport.riskScore}/100)${taxInfo}`);
              }
            }
          } catch (rugError: any) {
            console.warn(`   ⚠️  RugCheck failed: ${rugError.message}`);
          }

          // Sestaví data pro notifikaci
          // Najdi nejnovější wallet (který se právě přidal)
          const newestWallet = walletsData.sort((a, b) => 
            new Date(b.tradeTime || 0).getTime() - new Date(a.tradeTime || 0).getTime()
          )[0];

          const notificationData: SignalNotificationData = {
            tokenSymbol: token?.symbol || 'Unknown',
            tokenMint: token?.mintAddress || '',
            signalType: isUpdate ? 'consensus-update' : 'consensus',
            strength: uniqueWallets.size >= 4 ? 'strong' : uniqueWallets.size >= 3 ? 'medium' : 'weak',
            walletCount: uniqueWallets.size,
            avgWalletScore,
            entryPriceUsd: entryPrice,
            marketCapUsd: marketDataResult?.marketCap,
            liquidityUsd: marketDataResult?.liquidity,
            volume24hUsd: marketDataResult?.volume24h,
            tokenAgeMinutes: marketDataResult?.ageMinutes,
            baseToken, // Add base token
            // Only include AI decision if we have a real one (not fallback)
            aiDecision: aiDecisionResult && !aiDecisionResult.isFallback ? aiDecisionResult.decision : undefined,
            aiConfidence: aiDecisionResult && !aiDecisionResult.isFallback ? aiDecisionResult.confidence : undefined,
            // Pro update přidej info o novém walletovi
            aiReasoning: isUpdate 
              ? `🆕 Nový trader přidán: ${newestWallet?.label || 'Unknown'} (celkem ${uniqueWallets.size} wallets)`
              : (aiDecisionResult && !aiDecisionResult.isFallback ? aiDecisionResult.reasoning : undefined),
            aiPositionPercent: aiDecisionResult && !aiDecisionResult.isFallback ? aiDecisionResult.suggestedPositionPercent : undefined,
            stopLossPercent: aiDecisionResult && !aiDecisionResult.isFallback ? aiDecisionResult.stopLossPercent : undefined,
            takeProfitPercent: aiDecisionResult && !aiDecisionResult.isFallback ? aiDecisionResult.takeProfitPercent : undefined,
            stopLossPriceUsd: aiDecisionResult && !aiDecisionResult.isFallback ? stopLossPriceUsd : undefined,
            takeProfitPriceUsd: aiDecisionResult && !aiDecisionResult.isFallback ? takeProfitPriceUsd : undefined,
            aiRiskScore: aiDecisionResult && !aiDecisionResult.isFallback ? aiDecisionResult.riskScore : undefined,
            wallets: walletsData.map(w => ({
              label: w.label || null,
              address: w.address,
              walletId: w.id, // Add wallet ID for profile link
              score: Number(w.score) || 0,
              tradeAmountUsd: w.tradeAmountUsd,
              tradePrice: w.tradePrice,
              tradeTime: w.tradeTime,
            })),
            security: securityData,
          };

          // Pošli notifikaci
          console.log(`📨 [ConsensusWebhook] About to send Discord notification - baseToken: ${notificationData.baseToken || 'MISSING'}, walletIds: ${notificationData.wallets?.map(w => w.walletId ? 'yes' : 'no').join(',') || 'none'}, aiDecision: ${notificationData.aiDecision || 'undefined'}`);
          await this.discordNotification.sendSignalNotification(notificationData);
          
          // 5d. Vytvoř virtuální pozici pro exit monitoring
          try {
            const walletIdsList = Array.from(uniqueWallets);
            await this.positionMonitor.createPositionFromConsensus(
              signal.id,
              tokenId,
              entryPrice,
              walletIdsList as string[],
              { marketCap: marketDataResult?.marketCap, liquidity: marketDataResult?.liquidity }
            );
          } catch (posError: any) {
            console.warn(`   ⚠️  Position creation failed: ${posError.message}`);
          }
        } catch (discordError: any) {
          console.warn(`   ⚠️  Discord notification failed: ${discordError.message}`);
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
      const token = await this.tokenRepo.findById(trade.tokenId);

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
      const wallets = await prisma.smartWallet.findMany({
        where: {
          id: { in: walletIds },
        },
        select: {
          id: true,
          score: true,
          winRate: true,
          avgPnlPercent: true,
          tags: true,
        },
      });

      const avgWalletScore = wallets && wallets.length > 0
        ? wallets.reduce((sum, w) => sum + (Number(w.score) || 0), 0) / wallets.length
        : 50;

      const avgWinRate = wallets && wallets.length > 0
        ? wallets.reduce((sum, w) => sum + (Number(w.winRate) || 0), 0) / wallets.length
        : 0.5;

      // 4. Spočítej celkový volume
      const totalVolume = allBuys.reduce((sum, b) => sum + Number(b.amountBase || 0), 0);

      // 5. Vytvoř context pro AI
          const context = {
        // Required by SignalContext interface
        walletScore: avgWalletScore,
        walletWinRate: avgWinRate,
        walletRecentPnl30d: wallets && wallets.length > 0
          ? wallets.reduce((sum, w) => sum + (Number(w.avgPnlPercent) || 0), 0) / wallets.length
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
        // Entry price in USD per token (prefer valueUsd/amountToken)
        entryPriceUsd: (() => {
          const amountToken = Number(trade.amountToken || 0);
          const valueUsd = Number(trade.valueUsd || 0);
          if (amountToken > 0 && valueUsd > 0) {
            return valueUsd / amountToken;
          }
          return Number(trade.priceBasePerToken || 0);
        })(),
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
          
          if (!decision) {
            console.warn(`   ⚠️  AI decision returned null - AI not available or failed`);
            return null;
          }
      
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
      const signal = await this.signalRepo.findById(signalId);

      const entryPrice = signal ? signal.priceBasePerToken : 0;
      
      // Spočítej SL/TP ceny
      const stopLossPrice = entryPrice > 0 && aiDecision.stopLossPercent
        ? entryPrice * (1 - aiDecision.stopLossPercent / 100)
        : null;
      
      const takeProfitPrice = entryPrice > 0 && aiDecision.takeProfitPercent
        ? entryPrice * (1 + aiDecision.takeProfitPercent / 100)
        : null;

      await this.signalRepo.update(signalId, {
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
      });

      console.log(`   💾 Signal ${signalId.substring(0, 8)}... updated with AI decision`);
    } catch (error: any) {
      console.warn(`Failed to update signal with AI: ${error.message}`);
    }
  }
}
