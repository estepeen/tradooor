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
import { PositionMonitorService } from './position-monitor.service.js';
import { SignalPerformanceService } from './signal-performance.service.js';
import { TradeFeatureRepository } from '../repositories/trade-feature.repository.js';
import { WalletCorrelationService } from './wallet-correlation.service.js';
import { redisService, SpectreSignalPayload } from './redis.service.js';

const INITIAL_CAPITAL_USD = 1000;
const CONSENSUS_TIME_WINDOW_HOURS = 2;
const CLUSTER_STRENGTH_THRESHOLD = 70; // Minimum cluster strength for 💎💎 CLUSTER signal

// NINJA Signal parameters (micro-cap, fast consensus)
const NINJA_MIN_MARKET_CAP_USD = 7000;    // $7K minimum (more stable than ultra-micro)
const NINJA_MAX_MARKET_CAP_USD = 22000;   // $22K maximum (micro-cap territory)
const NINJA_TIME_WINDOW_MINUTES = 3;       // 3 minute window for fast consensus
const NINJA_MAX_PRICE_PUMP_PERCENT = 50;   // Max 50% pump from first buy (filters late entries)
const NINJA_MIN_LIQUIDITY_USD = 3000;      // $3K minimum liquidity
const NINJA_STOP_LOSS_PERCENT = 30;        // -30% SL (more room for volatility)
const NINJA_TAKE_PROFIT_PERCENT = 30;      // +30% TP (quick scalp exit)
const NINJA_MIN_WALLETS = 2;               // 2+ wallets for consensus

// CONSENSUS Signal parameters (regular market cap)
const CONSENSUS_MIN_MARKET_CAP_USD = 22000; // $22K minimum for regular consensus (above NINJA range)

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
  private positionMonitor: PositionMonitorService;
  private signalPerformance: SignalPerformanceService;
  private tradeFeatureRepo: TradeFeatureRepository;
  private walletCorrelation: WalletCorrelationService;

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
    this.positionMonitor = new PositionMonitorService();
    this.signalPerformance = new SignalPerformanceService();
    this.tradeFeatureRepo = new TradeFeatureRepository();
    this.walletCorrelation = new WalletCorrelationService();
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
      // 1. Najdi všechny BUY trades pro tento token v posledních 2h
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

      // 2. Zkontroluj, jestli jsou alespoň 2 různé wallets
      const uniqueWallets = new Set(recentBuys.map(t => t.walletId));
      if (uniqueWallets.size < 2) {
        return { consensusFound: false };
      }

      const walletIds = Array.from(uniqueWallets);

      // 3. Najdi druhý nákup - použij cenu druhého nákupu pro paper trade
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

      // 4b. EARLY Market Cap Filter - check BEFORE creating signal
      // This ensures low market cap tokens don't create signals at all
      const token = await this.tokenRepo.findById(tokenId);

      // Determine signal type based on market cap: NINJA (<20K) vs CONSENSUS (>=20K)
      let isNinjaSignal = false;
      let marketCap: number | null = null;
      let liquidity: number | null = null;

      // PRIMÁRNĚ: Pro filtrování použij MCap z POSLEDNÍHO trade (= aktuální stav)
      // Ne z prvního trade - ten může mít velmi nízký MCap
      const latestTrade = sortedBuys[sortedBuys.length - 1];
      const tradeMeta = latestTrade?.meta as any;

      // Také získej MCap prvního trade pro price pump check
      const firstTrade = sortedBuys[0];
      const firstTradeMeta = firstTrade?.meta as any;
      const firstTradeMcap = firstTradeMeta?.marketCapUsd || firstTradeMeta?.fdvUsd || null;

      if (tradeMeta?.marketCapUsd) {
        marketCap = Number(tradeMeta.marketCapUsd);
        console.log(`   📊 [Signal] MCap from LATEST trade meta (bonding curve): $${(marketCap / 1000).toFixed(1)}K (first trade was $${firstTradeMcap ? (firstTradeMcap / 1000).toFixed(1) + 'K' : 'N/A'})`);
      } else if (tradeMeta?.fdvUsd) {
        marketCap = Number(tradeMeta.fdvUsd);
        console.log(`   📊 [Signal] FDV from LATEST trade meta: $${(marketCap / 1000).toFixed(1)}K`);
      }

      // FALLBACK: Pokud trade meta nemá MCap, zkus Birdeye API
      // (pro starší tokeny nebo non-pump.fun tokeny)
      if ((marketCap === null || marketCap === undefined) && token?.mintAddress) {
        try {
          const earlyMarketData = await this.tokenMarketData.getMarketData(token.mintAddress);
          if (earlyMarketData?.marketCap) {
            marketCap = earlyMarketData.marketCap;
            liquidity = earlyMarketData.liquidity ?? null;
            console.log(`   📊 [Signal] MCap from Birdeye API: $${(marketCap / 1000).toFixed(1)}K`);
          }
        } catch (e) {
          console.warn(`   ⚠️  [Consensus] Failed to fetch market data for ${token.symbol}`);
        }
      }

      console.log(`   📊 [Signal] Market data: MCap=$${marketCap ? (marketCap / 1000).toFixed(1) + 'K' : 'null'}, Liq=$${liquidity ? (liquidity / 1000).toFixed(1) + 'K' : 'null'}`);

      if (marketCap === null || marketCap === undefined) {
        // If we cannot verify market cap, don't create signal (safety first)
        console.warn(`   ⚠️  [Signal] Could not verify market cap from API or trade meta - FILTERED OUT (no signal created)`);
        return { consensusFound: false };
      }

      // For NINJA check: find 2+ wallets within NINJA_TIME_WINDOW_MINUTES
      // We need to check if there's a "cluster" of 2+ wallet buys in a short time window
      const currentTradeTime = new Date(tradeToUse.timestamp).getTime();
      const ninjaWindowStart = currentTradeTime - NINJA_TIME_WINDOW_MINUTES * 60 * 1000;

      // Filter buys within NINJA time window from current trade
      const buysInNinjaWindow = sortedBuys.filter(t => {
        const tradeTime = new Date(t.timestamp).getTime();
        return tradeTime >= ninjaWindowStart && tradeTime <= currentTradeTime;
      });

      const ninjaWallets = new Set(buysInNinjaWindow.map(t => t.walletId));
      const ninjaWalletCount = ninjaWallets.size;

      // Calculate total time span for logging
      const firstBuyTime = new Date(sortedBuys[0].timestamp).getTime();
      const lastBuyTime = new Date(sortedBuys[sortedBuys.length - 1].timestamp).getTime();
      const totalTimeSpanMinutes = (lastBuyTime - firstBuyTime) / (1000 * 60);

      // Time span within ninja window (for NINJA detection)
      const ninjaFirstBuy = buysInNinjaWindow[0];
      const ninjaLastBuy = buysInNinjaWindow[buysInNinjaWindow.length - 1];
      const ninjaTimeSpan = ninjaFirstBuy && ninjaLastBuy
        ? (new Date(ninjaLastBuy.timestamp).getTime() - new Date(ninjaFirstBuy.timestamp).getTime()) / (1000 * 60)
        : 0;

      console.log(`   ⏱️  [Signal] Total span: ${totalTimeSpanMinutes.toFixed(1)} min | NINJA window (${NINJA_TIME_WINDOW_MINUTES}min): ${ninjaWalletCount} wallets, ${ninjaTimeSpan.toFixed(1)} min span`);

      // Check if this qualifies as NINJA signal (micro-cap fast consensus)
      if (marketCap >= NINJA_MIN_MARKET_CAP_USD && marketCap < NINJA_MAX_MARKET_CAP_USD) {
        console.log(`   🥷 [NINJA] MCap in NINJA range ($${NINJA_MIN_MARKET_CAP_USD / 1000}K-$${NINJA_MAX_MARKET_CAP_USD / 1000}K): $${(marketCap / 1000).toFixed(1)}K`);

        // NINJA candidate - check additional requirements

        // Check liquidity minimum
        if (liquidity !== null && liquidity !== undefined && liquidity < NINJA_MIN_LIQUIDITY_USD) {
          console.log(`   ⚠️  [NINJA] Token ${token?.symbol} liquidity $${(liquidity / 1000).toFixed(1)}K < $${(NINJA_MIN_LIQUIDITY_USD / 1000).toFixed(0)}K minimum - FILTERED OUT`);
          return { consensusFound: false };
        }

        // Check if we have 2+ wallets within NINJA time window
        if (ninjaWalletCount < NINJA_MIN_WALLETS) {
          console.log(`   ⚠️  [NINJA] Only ${ninjaWalletCount} wallet(s) in ${NINJA_TIME_WINDOW_MINUTES}min window (need ${NINJA_MIN_WALLETS}+) - not a NINJA (checking CONSENSUS...)`);
          // Falls through to regular CONSENSUS check below
        } else {
          // Check price pump - current price vs first buy price in ninja window
          // Calculate USD price per token: prefer valueUsd/amountToken, fallback to priceBasePerToken
          const getUsdPricePerToken = (trade: any): number => {
            const amountToken = Number(trade.amountToken || 0);
            const valueUsd = Number(trade.valueUsd || 0);
            if (amountToken > 0 && valueUsd > 0) {
              return valueUsd / amountToken;
            }
            // Fallback to priceBasePerToken (might be in SOL, less accurate)
            return Number(trade.priceBasePerToken || 0);
          };

          const firstBuyTrade = ninjaFirstBuy || sortedBuys[0];
          const ninjaBuyPrice = getUsdPricePerToken(firstBuyTrade);
          const currentPrice = getUsdPricePerToken(tradeToUse);
          const pricePumpPercent = ninjaBuyPrice > 0 ? ((currentPrice - ninjaBuyPrice) / ninjaBuyPrice) * 100 : 0;

          console.log(`   📊 [NINJA] Price check: First buy $${ninjaBuyPrice.toFixed(12)}, Current $${currentPrice.toFixed(12)}, Pump: ${pricePumpPercent.toFixed(1)}%`);

          if (pricePumpPercent > NINJA_MAX_PRICE_PUMP_PERCENT) {
            console.log(`   ⚠️  [NINJA] Token ${token?.symbol} pumped +${pricePumpPercent.toFixed(0)}% > ${NINJA_MAX_PRICE_PUMP_PERCENT}% max - FILTERED OUT (missed entry)`);
            return { consensusFound: false };
          }

          // All NINJA checks passed!
          isNinjaSignal = true;
          console.log(`   🥷 [NINJA] ✅ NINJA Signal detected! MCap: $${(marketCap / 1000).toFixed(1)}K, ${ninjaWalletCount} wallets in ${ninjaTimeSpan.toFixed(1)} min, pump: +${pricePumpPercent.toFixed(0)}%`);
        }
      } else if (marketCap < NINJA_MIN_MARKET_CAP_USD) {
        console.log(`   ⚠️  [Signal] MCap $${(marketCap / 1000).toFixed(1)}K < $${NINJA_MIN_MARKET_CAP_USD / 1000}K NINJA minimum - too low, FILTERED OUT`);
        return { consensusFound: false };
      } else {
        console.log(`   📈 [CONSENSUS] MCap $${(marketCap / 1000).toFixed(1)}K >= $${NINJA_MAX_MARKET_CAP_USD / 1000}K - checking CONSENSUS signal`);
      }

      // If not NINJA, check regular CONSENSUS minimum
      if (!isNinjaSignal) {
        if (marketCap < CONSENSUS_MIN_MARKET_CAP_USD) {
          console.log(`   ⚠️  [CONSENSUS] Token ${token?.symbol} market cap $${(marketCap / 1000).toFixed(1)}K < $${(CONSENSUS_MIN_MARKET_CAP_USD / 1000).toFixed(0)}K minimum - FILTERED OUT`);
          return { consensusFound: false };
        }
        console.log(`   ✅ [CONSENSUS] Market cap check passed: $${(marketCap / 1000).toFixed(1)}K >= $${(CONSENSUS_MIN_MARKET_CAP_USD / 1000).toFixed(0)}K minimum`);
      }

      // Quality filters DISABLED - only MCap, liquidity, and wallet count matter
      // Create market data object for later use
      const marketDataForQuality = {
        marketCap,
        liquidity,
        price: null,
        volume24h: null,
        tokenAgeMinutes: null,
        ageMinutes: null,
      };

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

          // Vytvoř signal performance tracking record
          try {
            await this.signalPerformance.createPerformanceRecord(
              signal.id,
              tokenId,
              tradeToUsePrice
            );
          } catch (perfError: any) {
            console.warn(`   ⚠️  Signal performance record creation failed: ${perfError.message}`);
          }
        }

        // 5b. Připrav data pro Discord (AI bude async)
        let marketDataResult: any = null;
        let walletsData: any[] = [];

        // 5c. Pošli Discord notifikaci HNED (bez čekání na AI)
        try {
          // Use marketCap and liquidity already fetched from trade meta / Birdeye
          marketDataResult = marketDataForQuality;

          // Market cap filter already applied at step 4b - no need to check again

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

          // Spoj wallet info s trade info a načti market cap pro každý trade
          walletsData = await Promise.all(
            wallets.map(async (w) => {
            const trade = sortedBuys.find(b => b.walletId === w.id);
            if (!trade) {
              return {
                ...w,
                tradeAmountUsd: undefined,
                tradePrice: undefined,
                tradeTime: undefined,
                  marketCapUsd: undefined,
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

              // Načti market cap pro tento trade z TradeFeature (fdvUsd) nebo z Trade.meta
              // Pokud není k dispozici, necháme undefined (zobrazí se "- MCap")
              let marketCapUsd: number | undefined = undefined;
              
              // 1. Zkus načíst z TradeFeature (nejpřesnější - market cap v době trade)
              try {
                const tradeFeature = await this.tradeFeatureRepo.findByTradeId(trade.id);
                if (tradeFeature?.fdvUsd !== null && tradeFeature?.fdvUsd !== undefined) {
                  marketCapUsd = tradeFeature.fdvUsd;
                  console.log(`[CONSENSUS] Found marketCap in TradeFeature: ${marketCapUsd} for trade ${trade.id}`);
                }
              } catch (error: any) {
                // TradeFeature neexistuje, zkus fallback na Trade.meta
                console.log(`[CONSENSUS] TradeFeature not found for trade ${trade.id}, trying meta...`);
              }
              
              // 2. Fallback: zkus načíst z Trade.meta (pokud tam byl uložen při vytvoření trade)
              if (!marketCapUsd && trade.meta) {
                const meta = trade.meta as any;
                console.log(`[CONSENSUS] Trade ${trade.id} meta keys:`, Object.keys(meta || {}));
                if (meta.marketCapUsd !== null && meta.marketCapUsd !== undefined) {
                  marketCapUsd = Number(meta.marketCapUsd);
                  console.log(`[CONSENSUS] ✅ Found marketCapUsd in meta: ${marketCapUsd} for trade ${trade.id}`);
                } else if (meta.fdvUsd !== null && meta.fdvUsd !== undefined) {
                  marketCapUsd = Number(meta.fdvUsd);
                  console.log(`[CONSENSUS] ✅ Found fdvUsd in meta: ${marketCapUsd} for trade ${trade.id}`);
                } else if (meta.marketCap !== null && meta.marketCap !== undefined) {
                  marketCapUsd = Number(meta.marketCap);
                  console.log(`[CONSENSUS] ✅ Found marketCap in meta: ${marketCapUsd} for trade ${trade.id}`);
                } else {
                  console.warn(`[CONSENSUS] ⚠️  No market cap found in meta for trade ${trade.id}, full meta:`, JSON.stringify(meta).substring(0, 200));
                }
              } else if (!trade.meta) {
                console.warn(`[CONSENSUS] ⚠️  No meta object for trade ${trade.id}`);
              }
              
              // Pokud nemáme market cap, necháme undefined (zobrazí se "- MCap")
              if (!marketCapUsd) {
                console.warn(`[CONSENSUS] ⚠️  Final result: NO market cap for trade ${trade.id} - will show "- MCap"`);
              }

            return {
              ...w,
              // Velikost pozice v base tokenu (SOL/USDC/USDT)
              tradeAmountUsd: Number(trade.amountBase || 0),
              // Cena v USD za 1 token
              tradePrice: priceUsdPerToken || undefined,
              tradeTime: trade.timestamp.toISOString(),
                marketCapUsd, // Market cap v době trade
            };
            })
          );
          
          const avgWalletScore = walletsData.length > 0
            ? walletsData.reduce((sum, w) => sum + (Number(w.score) || 0), 0) / walletsData.length
            : 50;

          // Získej base token z trade (default SOL)
          const baseToken = ((tradeToUse as any).meta?.baseToken || 'SOL').toUpperCase();

          // Entry price for signal
          const entryPrice = Number(tradeToUse.priceBasePerToken || 0);
          // SL/TP will be calculated in async AI

          // Security data (RugCheck) REMOVED for latency optimization
          // Was adding 1-2 seconds delay

          // Sestaví data pro notifikaci
          // Najdi nejnovější wallet (který se právě přidal)
          const newestWallet = walletsData.sort((a, b) => 
            new Date(b.tradeTime || 0).getTime() - new Date(a.tradeTime || 0).getTime()
          )[0];

          // Determine signal type based on NINJA detection
          let signalType: string = isUpdate ? 'consensus-update' : 'consensus';

          if (isNinjaSignal && !isUpdate) {
            signalType = 'ninja';
          }

          // Set default SL/TP based on signal type
          // NINJA uses tighter parameters, CONSENSUS uses standard
          const defaultStopLoss = isNinjaSignal ? NINJA_STOP_LOSS_PERCENT : 20;
          const defaultTakeProfit = isNinjaSignal ? NINJA_TAKE_PROFIT_PERCENT : 50;

          // Připrav notification data BEZ AI (AI bude async)
          const notificationData: SignalNotificationData = {
            tokenSymbol: token?.symbol || 'Unknown',
            tokenMint: token?.mintAddress || '',
            signalType,
            strength: uniqueWallets.size >= 4 ? 'strong' : uniqueWallets.size >= 3 ? 'medium' : 'weak',
            walletCount: uniqueWallets.size,
            avgWalletScore,
            entryPriceUsd: entryPrice,
            marketCapUsd: marketDataResult?.marketCap,
            liquidityUsd: marketDataResult?.liquidity,
            volume24hUsd: marketDataResult?.volume24h,
            tokenAgeMinutes: marketDataResult?.ageMinutes,
            baseToken,
            // AI data will be added async via message edit
            aiDecision: undefined,
            aiConfidence: undefined,
            aiReasoning: isUpdate
              ? `🆕 New trader added: ${newestWallet?.label || 'Unknown'} (total ${uniqueWallets.size} wallets)`
              : undefined,
            aiPositionPercent: undefined,
            // Set default SL/TP (AI can update async)
            stopLossPercent: defaultStopLoss,
            takeProfitPercent: defaultTakeProfit,
            stopLossPriceUsd: undefined,
            takeProfitPriceUsd: undefined,
            aiRiskScore: undefined,
            wallets: walletsData.map(w => ({
              label: w.label || null,
              address: w.address,
              walletId: w.id,
              score: Number(w.score) || 0,
              tradeAmountUsd: w.tradeAmountUsd,
              tradePrice: w.tradePrice,
              tradeTime: w.tradeTime,
              marketCapUsd: w.marketCapUsd,
            })),
            // Security removed for latency
          };

          // Pošli notifikaci HNED (bez AI)
          console.log(`📨 [ConsensusWebhook] Sending Discord notification IMMEDIATELY (AI will be async)`);
          const discordResult = await this.discordNotification.sendSignalNotification(notificationData);

          // 5d. Push signal to Redis for SPECTRE trading bot (NINJA signals only for now)
          if (signalType === 'ninja' && process.env.ENABLE_SPECTRE_BOT === 'true') {
            const spectrePayload: SpectreSignalPayload = {
              signalType: 'ninja',
              tokenSymbol: notificationData.tokenSymbol,
              tokenMint: notificationData.tokenMint,
              marketCapUsd: notificationData.marketCapUsd ?? null,
              liquidityUsd: notificationData.liquidityUsd ?? null,
              entryPriceUsd: notificationData.entryPriceUsd ?? null,
              stopLossPercent: notificationData.stopLossPercent ?? NINJA_STOP_LOSS_PERCENT,
              takeProfitPercent: notificationData.takeProfitPercent ?? NINJA_TAKE_PROFIT_PERCENT,
              strength: notificationData.strength,
              timestamp: new Date().toISOString(),
              wallets: notificationData.wallets.map(w => ({
                address: w.address,
                label: w.label ?? null,
                score: w.score ?? null,
              })),
            };

            // Fire and forget - don't block Discord notification
            redisService.pushSignal(spectrePayload).catch(err => {
              console.warn(`   ⚠️  Redis SPECTRE push failed: ${err.message}`);
            });
          }

          // 5e. Spusť AI ASYNCHRONNĚ a edituj zprávu
          if (discordResult.success && discordResult.messageId && process.env.ENABLE_AI_DECISIONS === 'true') {
            // Fire and forget - nečekáme na AI
            this.runAsyncAIAndUpdateMessage(
              discordResult.messageId,
              notificationData,
              signal,
              tradeToUse,
              uniqueWallets.size,
              sortedBuys
            ).catch(err => {
              console.warn(`   ⚠️  Async AI update failed: ${err.message}`);
            });
          }

          // 5e. Vytvoř virtuální pozici pro exit monitoring
          try {
            const walletIdsList = Array.from(uniqueWallets);
            await this.positionMonitor.createPositionFromConsensus(
              signal.id, // consensusSignalId
              tokenId,
              null, // signalId - ConsensusSignal není v Signal tabulce, předej null
              entryPrice,
              walletIdsList as string[],
              { marketCapUsd: marketDataResult?.marketCap, liquidityUsd: marketDataResult?.liquidity }
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
   * Check if wallets form a correlated cluster and emit CLUSTER signal
   * Called separately from CONSENSUS/NINJA flow
   */
  async checkClusterSignal(
    tokenId: string,
    walletIds: string[],
    timestamp: Date
  ): Promise<{ clusterFound: boolean; signalCreated?: any }> {
    if (walletIds.length < 2) {
      return { clusterFound: false };
    }

    try {
      const clusterData = await this.walletCorrelation.checkCluster(walletIds, CLUSTER_STRENGTH_THRESHOLD);

      if (!clusterData.isCorrelated) {
        return { clusterFound: false };
      }

      const clusterPerformance = await this.walletCorrelation.getClusterPerformance(walletIds);
      console.log(`   💎 [CLUSTER] Detected! ${walletIds.length} wallets, avg strength: ${clusterData.avgStrength}, historical success: ${clusterPerformance}%`);

      // Get token info
      const token = await this.tokenRepo.findById(tokenId);
      if (!token) {
        console.warn(`   ⚠️  [CLUSTER] Token not found: ${tokenId}`);
        return { clusterFound: true };
      }

      // Create CLUSTER signal notification
      const notificationData: SignalNotificationData = {
        tokenSymbol: token.symbol || 'Unknown',
        tokenMint: token.mintAddress || '',
        signalType: 'cluster',
        strength: walletIds.length >= 4 ? 'strong' : walletIds.length >= 3 ? 'medium' : 'weak',
        walletCount: walletIds.length,
        avgWalletScore: 0,
        clusterStrength: clusterData.avgStrength,
        clusterPerformance: clusterPerformance !== null ? clusterPerformance : undefined,
        entryPriceUsd: undefined,
        marketCapUsd: undefined,
        liquidityUsd: undefined,
        volume24hUsd: undefined,
        tokenAgeMinutes: undefined,
        baseToken: undefined,
        wallets: [],
      };

      // Send Discord notification
      await this.discordNotification.sendSignalNotification(notificationData);

      return { clusterFound: true, signalCreated: { type: 'cluster', walletCount: walletIds.length } };
    } catch (error: any) {
      console.warn(`   ⚠️  [CLUSTER] Check failed: ${error.message}`);
      return { clusterFound: false };
    }
  }

  /**
   * Zpracuje SELL trade z webhooku - uzavře odpovídající paper trade a detekuje wallet exit
   */
  async processSellTrade(sellTradeId: string): Promise<{ closed: boolean; exitSignal?: any }> {
    try {
      // 1. Načti trade pro wallet exit detection
      const trade = await this.tradeRepo.findById(sellTradeId);

      // 2. Detekuj wallet exit pro virtual positions
      let exitSignal: any = undefined;
      if (trade) {
        try {
          const exitPriceUsd = Number(trade.valueUsd || 0) / Number(trade.amountToken || 1);
          const exitAmountUsd = Number(trade.valueUsd || 0);

          exitSignal = await this.positionMonitor.recordWalletExit(
            sellTradeId,
            trade.walletId,
            trade.tokenId,
            exitPriceUsd,
            exitAmountUsd
          );

          if (exitSignal) {
            console.log(`   🚨 Exit signal generated: ${exitSignal.type} - ${exitSignal.recommendation}`);
          }
        } catch (exitError: any) {
          console.warn(`   ⚠️  Wallet exit detection failed: ${exitError.message}`);
        }
      }

      // 3. Zavři paper trade
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

      return { closed: !!closed, exitSignal };
    } catch (error: any) {
      console.error(`❌ Error processing SELL trade:`, error.message);
      return { closed: false };
    }
  }

  /**
   * Async AI evaluation and Discord message update
   * Runs in background after signal is sent
   */
  private async runAsyncAIAndUpdateMessage(
    messageId: string,
    originalData: any,
    signal: any,
    trade: any,
    walletCount: number,
    allBuys: any[]
  ): Promise<void> {
    const startTime = Date.now();
    console.log(`   🤖 [Async AI] Starting AI evaluation for message ${messageId.substring(0, 12)}...`);

    try {
      const aiDecisionResult = await this.evaluateSignalWithAI(
        signal,
        trade,
        walletCount,
        allBuys
      );

      if (!aiDecisionResult) {
        console.log(`   ⚠️  [Async AI] AI returned null - no update needed`);
        return;
      }

      if (aiDecisionResult.isFallback) {
        console.log(`   ⚠️  [Async AI] AI returned fallback - skipping update`);
        return;
      }

      const elapsed = Date.now() - startTime;
      console.log(`   🤖 [Async AI] Got AI decision in ${elapsed}ms: ${aiDecisionResult.decision} (${aiDecisionResult.confidence}%)`);

      // Update signal in DB
      await this.updateSignalWithAI(signal.id, aiDecisionResult);

      // Update Discord message with AI data
      await this.discordNotification.updateSignalWithAI(
        messageId,
        originalData,
        {
          aiDecision: aiDecisionResult.decision,
          aiConfidence: aiDecisionResult.confidence,
          aiPositionPercent: aiDecisionResult.suggestedPositionPercent,
          aiRiskScore: aiDecisionResult.riskScore,
          stopLossPercent: aiDecisionResult.stopLossPercent,
          takeProfitPercent: aiDecisionResult.takeProfitPercent,
          aiReasoning: aiDecisionResult.reasoning,
        }
      );

      console.log(`   ✅ [Async AI] Discord message updated with AI (total ${Date.now() - startTime}ms)`);
    } catch (error: any) {
      console.error(`   ❌ [Async AI] Failed: ${error.message}`);
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

      // 2. Načti market data - primárně z trade meta (bonding curve), pak Birdeye API
      let marketData: any = null;

      // PRIMÁRNĚ: Použij MCap z trade meta (bonding curve - okamžité, žádné API)
      const tradeMeta = trade.meta as any;
      if (tradeMeta?.marketCapUsd || tradeMeta?.fdvUsd) {
        marketData = {
          marketCap: tradeMeta.marketCapUsd || tradeMeta.fdvUsd,
          liquidity: tradeMeta.liquidity || null,
        };
      } else {
        // FALLBACK: Birdeye API pro starší tokeny
        try {
          marketData = await this.tokenMarketData.getMarketData(token.mintAddress);
        } catch (e) {
          // Market data není kritická
        }
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
