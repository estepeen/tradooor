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
import { redisService, SpectreSignalPayload, SpectrePreSignalPayload } from './redis.service.js';

const INITIAL_CAPITAL_USD = 1000;
const CONSENSUS_TIME_WINDOW_HOURS = 2;
const CLUSTER_STRENGTH_THRESHOLD = 70; // Minimum cluster strength for 💎💎 CLUSTER signal

// ============================================================================
// NEW NINJA SIGNAL PARAMETERS (2025 Redesign) - TIERED SYSTEM
// ============================================================================

// Global limits
const NINJA_MIN_MARKET_CAP_USD = 80000;     // $80K minimum (Tier 1 start)
const NINJA_MAX_MARKET_CAP_USD = 500000;    // $500K maximum (Tier 4 end)
const NINJA_MIN_LIQUIDITY_USD = 15000;      // $15K minimum liquidity
const NINJA_MIN_TOKEN_AGE_MINUTES = 60;     // 1 hour minimum age

// Diversity (same for all tiers)
const NINJA_MIN_DIVERSITY_PERCENT = 70;     // 70% unique wallets
const NINJA_DIVERSITY_SAMPLE_SIZE = 30;     // From last 30 trades

// Volume Spike Detection
const NINJA_MIN_VOLUME_SPIKE_RATIO = 1.75;  // Min 1.75x volume vs avg last hour

// Liquidity Monitoring (Pre-Entry Checks)
const NINJA_LIQUIDITY_5MIN_MAX_DROP = 0.10;   // Max 10% drop in 5min
const NINJA_LIQUIDITY_15MIN_MAX_DROP = 0.20;  // Max 20% drop in 15min
const NINJA_MIN_LIQUIDITY_MCAP_RATIO = 0.08;  // Min 8% liquidity/mcap ratio

// Buy/Sell Pressure Monitoring (5min window)
const NINJA_MIN_BUY_SELL_VOLUME_RATIO = 1.5;  // Min buy/sell volume ratio
const NINJA_BLOCK_BUY_SELL_VOLUME_RATIO = 1.0; // Block if below this (more sells than buys)
const NINJA_MIN_BUYERS_SELLERS_RATIO = 2.0;   // Min unique buyers/sellers ratio
const NINJA_MIN_PRICE_MOMENTUM_PERCENT = 5;   // Min +5% price momentum (5min)
const NINJA_MAX_PRICE_MOMENTUM_PERCENT = 25;  // Max +25% (avoid overheated)
const NINJA_BLOCK_PRICE_MOMENTUM_PERCENT = -3; // Block if below -3% (downtrend)
const NINJA_OVERHEAT_PRICE_MOMENTUM_PERCENT = 40; // Block if above 40% (too hot)

// Moving Average Trend Filter
// Entry only when price is above both MA_1min and MA_5min (uptrend confirmation)
const NINJA_MA_1MIN_ENABLED = true;   // Check 1min MA
const NINJA_MA_5MIN_ENABLED = true;   // Check 5min MA

// Whale Activity Detection (Pre-Entry)
const NINJA_WHALE_SUPPLY_PERCENT_BLOCK = 1.0;  // Block if single sell > 1% supply
const NINJA_WHALE_USD_BLOCK_LOW_MCAP = 500;    // Block if single sell > $500 (for 50-100k mcap)
const NINJA_WHALE_USD_BLOCK_THRESHOLD_MCAP = 100000; // Apply USD block only below this mcap
const NINJA_WHALE_LOOKBACK_5MIN = 5 * 60 * 1000;     // 5min lookback for large sells
const NINJA_WHALE_LOOKBACK_10MIN = 10 * 60 * 1000;   // 10min lookback for top holder sells
const NINJA_WHALE_LOOKBACK_15MIN = 15 * 60 * 1000;   // 15min lookback for dev sells
const PUMP_FUN_TOTAL_SUPPLY = 1_000_000_000;         // 1B tokens for pump.fun

// Trading Parameters
const NINJA_STOP_LOSS_PERCENT = 20;         // -20% SL
const NINJA_TAKE_PROFIT_PERCENT = 30;       // +30% first TP

// ============================================================================
// DYNAMIC PRIORITY FEES (ČÁST 10)
// Based on momentum: buy/sell ratio + price change
// ============================================================================
// Very strong momentum: buy/sell >3.0 AND price +15-20%
const PRIORITY_FEE_VERY_STRONG_LAMPORTS = 1_000_000;  // 0.001 SOL
const PRIORITY_FEE_VERY_STRONG_MIN_BS_RATIO = 3.0;
const PRIORITY_FEE_VERY_STRONG_MIN_PRICE_CHANGE = 15;
const PRIORITY_FEE_VERY_STRONG_MAX_PRICE_CHANGE = 25;  // Still within optimal range

// Standard momentum: buy/sell 1.5-3.0 AND price +5-15%
const PRIORITY_FEE_STANDARD_LAMPORTS = 700_000;       // 0.0007 SOL
const PRIORITY_FEE_STANDARD_MIN_BS_RATIO = 1.5;
const PRIORITY_FEE_STANDARD_MIN_PRICE_CHANGE = 5;

// Weak momentum: buy/sell 1.0-1.5 - DON'T TRADE (already filtered by NINJA checks)
// But if signal passes, use minimal fee
const PRIORITY_FEE_WEAK_LAMPORTS = 500_000;           // 0.0005 SOL

// SELL priority (always same, set in SPECTRE config)
// const PRIORITY_FEE_SELL_LAMPORTS = 250_000;        // 0.00025 SOL (handled by jito_tip_sell_lamports)

// ============================================================================
// TIER DEFINITIONS
// ============================================================================
interface NinjaTier {
  name: string;
  minMcap: number;
  maxMcap: number;
  timeWindowMinutes: number;
  minWallets: number;
  activityWindowMinutes: number;
  minUniqueBuyers: number;
  qualityRequirement?: {
    minQualityWallets: number;      // Min wallets that are tracked/quality
    minBuyAmountUsd?: number;       // Or min buy amount in USD
  };
}

const NINJA_TIERS: NinjaTier[] = [
  {
    name: 'Tier 1',
    minMcap: 80000,      // $80K
    maxMcap: 120000,     // $120K
    timeWindowMinutes: 5,
    minWallets: 3,
    activityWindowMinutes: 10,
    minUniqueBuyers: 8,
  },
  {
    name: 'Tier 2',
    minMcap: 120000,     // $120K
    maxMcap: 200000,     // $200K
    timeWindowMinutes: 8,
    minWallets: 3,
    activityWindowMinutes: 10,
    minUniqueBuyers: 6,
  },
  {
    name: 'Tier 3',
    minMcap: 200000,     // $200K
    maxMcap: 350000,     // $350K
    timeWindowMinutes: 12,
    minWallets: 4,
    activityWindowMinutes: 15,
    minUniqueBuyers: 5,
    qualityRequirement: {
      minQualityWallets: 2,  // Min 2 tracked/quality wallets
      minBuyAmountUsd: 100,  // Or buys > $100
    },
  },
  {
    name: 'Tier 4',
    minMcap: 350000,     // $350K
    maxMcap: 500000,     // $500K
    timeWindowMinutes: 15,
    minWallets: 4,
    activityWindowMinutes: 20,
    minUniqueBuyers: 8,
    qualityRequirement: {
      minQualityWallets: 3,  // Min 3 tracked/quality wallets
      minBuyAmountUsd: 100,  // Or buys > $100
    },
  },
];

// Helper function to get tier for market cap
function getNinjaTier(marketCap: number): NinjaTier | null {
  for (const tier of NINJA_TIERS) {
    if (marketCap >= tier.minMcap && marketCap < tier.maxMcap) {
      return tier;
    }
  }
  return null;
}

// CONSENSUS Signal parameters (post-graduation, higher market cap)
const CONSENSUS_MIN_MARKET_CAP_USD = 50000; // $50K minimum for regular consensus

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

      // 2. Zkontroluj počet unikátních wallets
      const uniqueWallets = new Set(recentBuys.map(t => t.walletId));
      const walletCount = uniqueWallets.size;

      // ⚡ PRE-SIGNAL SYSTEM: Prepare TX before signal confirmation
      // Tier 1 & 2 ($80K-$200K): Prepare after 2 wallets, wait for 3rd
      // Tier 3 & 4 ($200K-$500K): Prepare after 3 wallets, wait for 4th
      if (process.env.ENABLE_SPECTRE_BOT === 'true') {
        const latestTrade = recentBuys[recentBuys.length - 1];
        const tradeMeta = latestTrade?.meta as any;
        const marketCap = tradeMeta?.marketCapUsd ? Number(tradeMeta.marketCapUsd) : null;
        const liquidity = tradeMeta?.liquidityUsd ? Number(tradeMeta.liquidityUsd) : null;

        // Check if MCap is in NINJA range
        if (marketCap !== null && marketCap >= NINJA_MIN_MARKET_CAP_USD && marketCap < NINJA_MAX_MARKET_CAP_USD) {
          const tier = getNinjaTier(marketCap);

          if (tier) {
            // Determine pre-signal threshold based on tier
            // Tier 1 & 2: prepare at 2 wallets (need 3 for signal)
            // Tier 3 & 4: prepare at 3 wallets (need 4 for signal)
            const preSignalThreshold = tier.minWallets - 1;

            // Send pre-signal when we hit the threshold (exactly, not more)
            if (walletCount === preSignalThreshold) {
              const token = await this.tokenRepo.findById(tokenId);
              const wallet = await this.smartWalletRepo.findById(walletId);

              // Calculate entry price from latest trade
              const amountToken = Number(latestTrade.amountToken || 0);
              const valueUsd = Number(latestTrade.valueUsd || 0);
              const entryPrice = amountToken > 0 && valueUsd > 0 ? valueUsd / amountToken : null;

              // Collect all wallet info for pre-signal
              const walletInfos: Array<{ address: string; label: string | null; score: number | null }> = [];
              for (const wId of uniqueWallets) {
                const w = await this.smartWalletRepo.findById(wId);
                if (w) {
                  walletInfos.push({
                    address: w.address,
                    label: w.label || null,
                    score: w.score ? Number(w.score) : null,
                  });
                }
              }

              const preSignal: SpectrePreSignalPayload = {
                tokenMint: token?.mintAddress || '',
                tokenSymbol: token?.symbol || 'Unknown',
                marketCapUsd: marketCap,
                liquidityUsd: liquidity,
                entryPriceUsd: entryPrice,
                timestamp: new Date().toISOString(),
                firstWallet: walletInfos[0] || {
                  address: wallet?.address || '',
                  label: wallet?.label || null,
                  score: wallet?.score ? Number(wallet.score) : null,
                },
                // Extended info for tiered system
                tier: tier.name,
                currentWallets: walletCount,
                requiredWallets: tier.minWallets,
                allWallets: walletInfos,
              };

              // Fire and forget - prepare TX in background
              redisService.pushPreSignal(preSignal).catch(err => {
                console.warn(`   ⚠️  Redis pre-signal push failed: ${err.message}`);
              });

              console.log(`   ⚡ [Pre-Signal] ${tier.name}: ${walletCount}/${tier.minWallets} wallets for ${token?.symbol} @ $${(marketCap / 1000).toFixed(1)}K MCap - PREPARING TX`);
            }
          }
        }
      }

      // Continue with consensus check - need at least 2 wallets to proceed
      if (walletCount < 2) {
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

      // ============================================================================
      // NEW NINJA SIGNAL DETECTION (2025 Redesign) - TIERED SYSTEM
      // Only NINJA signals are emitted - CONSENSUS signals DISABLED
      // ============================================================================
      const currentTradeTime = new Date(tradeToUse.timestamp).getTime();

      // 1. GLOBAL MARKET CAP CHECK
      if (marketCap < NINJA_MIN_MARKET_CAP_USD) {
        console.log(`   ❌ [NINJA] MCap $${(marketCap / 1000).toFixed(1)}K < $${NINJA_MIN_MARKET_CAP_USD / 1000}K minimum - FILTERED OUT`);
        return { consensusFound: false };
      }

      if (marketCap > NINJA_MAX_MARKET_CAP_USD) {
        console.log(`   ❌ [NINJA] MCap $${(marketCap / 1000).toFixed(1)}K > $${NINJA_MAX_MARKET_CAP_USD / 1000}K maximum - FILTERED OUT`);
        return { consensusFound: false };
      }

      // 2. GET TIER FOR THIS MARKET CAP
      const tier = getNinjaTier(marketCap);
      if (!tier) {
        console.log(`   ❌ [NINJA] MCap $${(marketCap / 1000).toFixed(1)}K doesn't match any tier - FILTERED OUT`);
        return { consensusFound: false };
      }

      console.log(`   🎯 [NINJA] ${tier.name} ($${tier.minMcap / 1000}K-$${tier.maxMcap / 1000}K): MCap $${(marketCap / 1000).toFixed(1)}K`);

      // 3. LIQUIDITY CHECK (global minimum)
      if (liquidity !== null && liquidity !== undefined && liquidity < NINJA_MIN_LIQUIDITY_USD) {
        console.log(`   ❌ [NINJA] Liquidity $${(liquidity / 1000).toFixed(1)}K < $${NINJA_MIN_LIQUIDITY_USD / 1000}K minimum - FILTERED OUT`);
        return { consensusFound: false };
      }
      console.log(`   ✅ [NINJA] Liquidity: $${liquidity ? (liquidity / 1000).toFixed(1) + 'K' : 'N/A'} (min $${NINJA_MIN_LIQUIDITY_USD / 1000}K)`);

      // 3b. LIQUIDITY/MCAP RATIO CHECK
      if (liquidity !== null && liquidity !== undefined && marketCap > 0) {
        const liquidityMcapRatio = liquidity / marketCap;
        if (liquidityMcapRatio < NINJA_MIN_LIQUIDITY_MCAP_RATIO) {
          console.log(`   ❌ [NINJA] Liquidity/MCap ratio ${(liquidityMcapRatio * 100).toFixed(1)}% < ${NINJA_MIN_LIQUIDITY_MCAP_RATIO * 100}% minimum - thin liquidity, FILTERED OUT`);
          return { consensusFound: false };
        }
        console.log(`   ✅ [NINJA] Liquidity/MCap: ${(liquidityMcapRatio * 100).toFixed(1)}% (min ${NINJA_MIN_LIQUIDITY_MCAP_RATIO * 100}%)`);
      }

      // 3c. LIQUIDITY TREND CHECK (compare with historical trades)
      // Get liquidity from trades 5min and 15min ago to detect drops
      const fiveMinAgo = currentTradeTime - 5 * 60 * 1000;
      const fifteenMinAgo = currentTradeTime - 15 * 60 * 1000;

      // Find trades closest to 5min and 15min ago
      const tradesFor5minCheck = sortedBuys.filter(t => {
        const tradeTime = new Date(t.timestamp).getTime();
        return tradeTime >= fifteenMinAgo && tradeTime <= fiveMinAgo;
      });

      const tradesFor15minCheck = sortedBuys.filter(t => {
        const tradeTime = new Date(t.timestamp).getTime();
        return tradeTime >= fifteenMinAgo - 10 * 60 * 1000 && tradeTime <= fifteenMinAgo;
      });

      // Get liquidity from 5min ago
      let liquidity5minAgo: number | null = null;
      if (tradesFor5minCheck.length > 0) {
        const trade5min = tradesFor5minCheck[tradesFor5minCheck.length - 1]; // Most recent in that window
        const meta5min = trade5min?.meta as any;
        liquidity5minAgo = meta5min?.liquidityUsd ? Number(meta5min.liquidityUsd) : null;
      }

      // Get liquidity from 15min ago
      let liquidity15minAgo: number | null = null;
      if (tradesFor15minCheck.length > 0) {
        const trade15min = tradesFor15minCheck[tradesFor15minCheck.length - 1];
        const meta15min = trade15min?.meta as any;
        liquidity15minAgo = meta15min?.liquidityUsd ? Number(meta15min.liquidityUsd) : null;
      }

      // Check 5min liquidity drop
      if (liquidity !== null && liquidity5minAgo !== null && liquidity5minAgo > 0) {
        const drop5min = 1 - (liquidity / liquidity5minAgo);
        if (drop5min > NINJA_LIQUIDITY_5MIN_MAX_DROP) {
          console.log(`   ❌ [NINJA] Liquidity dropped ${(drop5min * 100).toFixed(1)}% in 5min (max ${NINJA_LIQUIDITY_5MIN_MAX_DROP * 100}%) - $${(liquidity5minAgo / 1000).toFixed(1)}K → $${(liquidity / 1000).toFixed(1)}K - FILTERED OUT`);
          return { consensusFound: false };
        }
        if (drop5min > 0) {
          console.log(`   ⚠️  [NINJA] Liquidity 5min: -${(drop5min * 100).toFixed(1)}% ($${(liquidity5minAgo / 1000).toFixed(1)}K → $${(liquidity / 1000).toFixed(1)}K)`);
        } else {
          console.log(`   ✅ [NINJA] Liquidity 5min: +${(Math.abs(drop5min) * 100).toFixed(1)}% (stable/growing)`);
        }
      }

      // Check 15min liquidity drop
      if (liquidity !== null && liquidity15minAgo !== null && liquidity15minAgo > 0) {
        const drop15min = 1 - (liquidity / liquidity15minAgo);
        if (drop15min > NINJA_LIQUIDITY_15MIN_MAX_DROP) {
          console.log(`   ❌ [NINJA] Liquidity dropped ${(drop15min * 100).toFixed(1)}% in 15min (max ${NINJA_LIQUIDITY_15MIN_MAX_DROP * 100}%) - $${(liquidity15minAgo / 1000).toFixed(1)}K → $${(liquidity / 1000).toFixed(1)}K - FILTERED OUT`);
          return { consensusFound: false };
        }
        if (drop15min > 0) {
          console.log(`   ⚠️  [NINJA] Liquidity 15min: -${(drop15min * 100).toFixed(1)}% ($${(liquidity15minAgo / 1000).toFixed(1)}K → $${(liquidity / 1000).toFixed(1)}K)`);
        } else {
          console.log(`   ✅ [NINJA] Liquidity 15min: +${(Math.abs(drop15min) * 100).toFixed(1)}% (stable/growing)`);
        }
      }

      // 4. TIER-SPECIFIC TIME WINDOW & WALLET COUNT
      const ninjaTimeWindowMinutes = tier.timeWindowMinutes;
      const ninjaWindowStart = currentTradeTime - ninjaTimeWindowMinutes * 60 * 1000;

      const buysInNinjaWindow = sortedBuys.filter(t => {
        const tradeTime = new Date(t.timestamp).getTime();
        return tradeTime >= ninjaWindowStart && tradeTime <= currentTradeTime;
      });

      const ninjaWallets = new Set(buysInNinjaWindow.map(t => t.walletId));
      const ninjaWalletCount = ninjaWallets.size;

      if (ninjaWalletCount < tier.minWallets) {
        console.log(`   ❌ [NINJA] Only ${ninjaWalletCount} wallet(s) in ${ninjaTimeWindowMinutes}min window (${tier.name} needs ${tier.minWallets}+) - FILTERED OUT`);
        return { consensusFound: false };
      }
      console.log(`   ✅ [NINJA] Wallets: ${ninjaWalletCount} in ${ninjaTimeWindowMinutes}min window (${tier.name} min: ${tier.minWallets})`);

      // 5. TIER-SPECIFIC ACTIVITY CHECK (unique buyers in activity window)
      const activityWindowStart = currentTradeTime - tier.activityWindowMinutes * 60 * 1000;
      const allTokenBuys = await this.tradeRepo.findBuysByTokenAndTimeWindow(
        tokenId,
        new Date(activityWindowStart),
        new Date(currentTradeTime)
      );

      const uniqueBuyersInActivityWindow = new Set(allTokenBuys.map(t => t.walletId)).size;

      if (uniqueBuyersInActivityWindow < tier.minUniqueBuyers) {
        console.log(`   ❌ [NINJA] Only ${uniqueBuyersInActivityWindow} unique buyers in ${tier.activityWindowMinutes}min (${tier.name} needs ${tier.minUniqueBuyers}+) - FILTERED OUT`);
        return { consensusFound: false };
      }
      console.log(`   ✅ [NINJA] Activity: ${uniqueBuyersInActivityWindow} unique buyers in ${tier.activityWindowMinutes}min (${tier.name} min: ${tier.minUniqueBuyers})`);

      // 6. TIER-SPECIFIC QUALITY REQUIREMENT (Tier 3 & 4)
      if (tier.qualityRequirement) {
        // Count quality wallets: T1/T2 wallets OR bought > minBuyAmountUsd
        let qualityWalletCount = 0;
        const qualityWalletLabels: string[] = [];

        for (const trade of buysInNinjaWindow) {
          const wallet = await this.smartWalletRepo.findById(trade.walletId);
          const tradeValueUsd = Number(trade.valueUsd || 0);

          // Quality = T1 or T2 wallet (tier 1 or 2) OR buy > minBuyAmountUsd
          const isQualityTier = wallet?.tier !== null && wallet?.tier !== undefined && wallet.tier <= 2;
          const isBigBuy = tier.qualityRequirement.minBuyAmountUsd
            ? tradeValueUsd >= tier.qualityRequirement.minBuyAmountUsd
            : false;

          if (isQualityTier || isBigBuy) {
            qualityWalletCount++;
            if (isQualityTier && wallet?.label) {
              qualityWalletLabels.push(`${wallet.label}(T${wallet.tier})`);
            }
          }
        }

        if (qualityWalletCount < tier.qualityRequirement.minQualityWallets) {
          console.log(`   ❌ [NINJA] Only ${qualityWalletCount} quality wallets (${tier.name} needs ${tier.qualityRequirement.minQualityWallets}+ T1/T2 or >$${tier.qualityRequirement.minBuyAmountUsd} buys) - FILTERED OUT`);
          return { consensusFound: false };
        }
        console.log(`   ✅ [NINJA] Quality: ${qualityWalletCount} quality wallets (${tier.name} min: ${tier.qualityRequirement.minQualityWallets}) [${qualityWalletLabels.join(', ') || 'big buys'}]`);
      }

      // 7. VOLUME SPIKE DETECTION
      // Compare volume in tier's time window vs average volume in last hour
      const oneHourAgo = currentTradeTime - 60 * 60 * 1000;
      const allBuysLastHour = await this.tradeRepo.findBuysByTokenAndTimeWindow(
        tokenId,
        new Date(oneHourAgo),
        new Date(currentTradeTime)
      );

      // Calculate total volume in last hour (in USD)
      const totalVolumeLastHour = allBuysLastHour.reduce((sum, t) => sum + Number(t.valueUsd || 0), 0);

      // Calculate volume in tier's time window (in USD)
      const volumeInTierWindow = buysInNinjaWindow.reduce((sum, t) => sum + Number(t.valueUsd || 0), 0);

      // Average volume per minute in last hour
      const avgVolumePerMinute = totalVolumeLastHour / 60;

      // Expected volume for tier window based on hourly average
      const expectedVolumeInWindow = avgVolumePerMinute * tier.timeWindowMinutes;

      // Calculate volume spike ratio
      const volumeSpikeRatio = expectedVolumeInWindow > 0 ? volumeInTierWindow / expectedVolumeInWindow : 0;

      if (volumeSpikeRatio < NINJA_MIN_VOLUME_SPIKE_RATIO) {
        console.log(`   ❌ [NINJA] Volume spike ${volumeSpikeRatio.toFixed(2)}x < ${NINJA_MIN_VOLUME_SPIKE_RATIO}x minimum (window: $${volumeInTierWindow.toFixed(0)}, expected: $${expectedVolumeInWindow.toFixed(0)}) - FILTERED OUT`);
        return { consensusFound: false };
      }
      console.log(`   ✅ [NINJA] Volume spike: ${volumeSpikeRatio.toFixed(2)}x (window: $${volumeInTierWindow.toFixed(0)} vs expected: $${expectedVolumeInWindow.toFixed(0)}, min ${NINJA_MIN_VOLUME_SPIKE_RATIO}x)`);

      // 7b. BUY/SELL PRESSURE CHECK (5min window)
      const pressureWindowStart = currentTradeTime - 5 * 60 * 1000; // 5 min window
      const buysIn5min = await this.tradeRepo.findBuysByTokenAndTimeWindow(
        tokenId,
        new Date(pressureWindowStart),
        new Date(currentTradeTime)
      );
      const sellsIn5min = await this.tradeRepo.findSellsByTokenAndTimeWindow(
        tokenId,
        new Date(pressureWindowStart),
        new Date(currentTradeTime)
      );

      // Calculate buy/sell volume ratio
      const buyVolumeUsd = buysIn5min.reduce((sum, t) => sum + Number(t.valueUsd || 0), 0);
      const sellVolumeUsd = sellsIn5min.reduce((sum, t) => sum + Number(t.valueUsd || 0), 0);
      const buySellVolumeRatio = sellVolumeUsd > 0 ? buyVolumeUsd / sellVolumeUsd : (buyVolumeUsd > 0 ? 999 : 0);

      // Calculate unique buyers/sellers ratio
      const uniqueBuyers5min = new Set(buysIn5min.map(t => t.walletId)).size;
      const uniqueSellers5min = new Set(sellsIn5min.map(t => t.walletId)).size;
      const buyerSellerRatio = uniqueSellers5min > 0 ? uniqueBuyers5min / uniqueSellers5min : (uniqueBuyers5min > 0 ? 999 : 0);

      // Store for dynamic priority fee calculation (ČÁST 10)
      let momentumPriceMomentumPercent = 0;

      // Check buy/sell volume ratio
      if (buySellVolumeRatio < NINJA_BLOCK_BUY_SELL_VOLUME_RATIO) {
        console.log(`   ❌ [NINJA] Buy/Sell volume ratio ${buySellVolumeRatio.toFixed(2)} < ${NINJA_BLOCK_BUY_SELL_VOLUME_RATIO} (more sells!) - $${buyVolumeUsd.toFixed(0)} buys vs $${sellVolumeUsd.toFixed(0)} sells - FILTERED OUT`);
        return { consensusFound: false };
      }
      if (buySellVolumeRatio < NINJA_MIN_BUY_SELL_VOLUME_RATIO) {
        console.log(`   ⚠️  [NINJA] Buy/Sell volume ratio ${buySellVolumeRatio.toFixed(2)} < ${NINJA_MIN_BUY_SELL_VOLUME_RATIO} (weak buying) - waiting for better conditions`);
        // Don't block, just warn - can still proceed if other conditions are strong
      } else {
        console.log(`   ✅ [NINJA] Buy/Sell volume: ${buySellVolumeRatio.toFixed(2)}x ($${buyVolumeUsd.toFixed(0)} buys / $${sellVolumeUsd.toFixed(0)} sells)`);
      }

      // Check buyers/sellers ratio
      if (buyerSellerRatio < NINJA_MIN_BUYERS_SELLERS_RATIO && uniqueSellers5min > 0) {
        console.log(`   ⚠️  [NINJA] Buyers/Sellers ratio ${buyerSellerRatio.toFixed(2)} < ${NINJA_MIN_BUYERS_SELLERS_RATIO} (${uniqueBuyers5min} buyers / ${uniqueSellers5min} sellers) - weak momentum`);
        // Don't block, just warn
      } else {
        console.log(`   ✅ [NINJA] Buyers/Sellers: ${buyerSellerRatio.toFixed(2)}x (${uniqueBuyers5min} buyers / ${uniqueSellers5min} sellers)`);
      }

      // 7c. PRICE MOMENTUM CHECK (5min)
      // Get price from earliest and latest trade in 5min window
      if (buysIn5min.length >= 2) {
        const earliestTrade = buysIn5min[0];
        const latestTrade = buysIn5min[buysIn5min.length - 1];
        const earliestPrice = Number(earliestTrade.priceBasePerToken || 0);
        const latestPrice = Number(latestTrade.priceBasePerToken || 0);

        if (earliestPrice > 0 && latestPrice > 0) {
          const priceMomentumPercent = ((latestPrice - earliestPrice) / earliestPrice) * 100;
          momentumPriceMomentumPercent = priceMomentumPercent; // Store for priority fee calculation

          if (priceMomentumPercent < NINJA_BLOCK_PRICE_MOMENTUM_PERCENT) {
            console.log(`   ❌ [NINJA] Price momentum ${priceMomentumPercent.toFixed(1)}% < ${NINJA_BLOCK_PRICE_MOMENTUM_PERCENT}% - DOWNTREND, FILTERED OUT`);
            return { consensusFound: false };
          }

          if (priceMomentumPercent > NINJA_OVERHEAT_PRICE_MOMENTUM_PERCENT) {
            console.log(`   ❌ [NINJA] Price momentum ${priceMomentumPercent.toFixed(1)}% > ${NINJA_OVERHEAT_PRICE_MOMENTUM_PERCENT}% - OVERHEATED, FILTERED OUT`);
            return { consensusFound: false };
          }

          if (priceMomentumPercent >= NINJA_MIN_PRICE_MOMENTUM_PERCENT && priceMomentumPercent <= NINJA_MAX_PRICE_MOMENTUM_PERCENT) {
            console.log(`   ✅ [NINJA] Price momentum: +${priceMomentumPercent.toFixed(1)}% (optimal range ${NINJA_MIN_PRICE_MOMENTUM_PERCENT}-${NINJA_MAX_PRICE_MOMENTUM_PERCENT}%)`);
          } else if (priceMomentumPercent > NINJA_MAX_PRICE_MOMENTUM_PERCENT) {
            console.log(`   ⚠️  [NINJA] Price momentum: +${priceMomentumPercent.toFixed(1)}% (above optimal, may be cooling)`);
          } else {
            console.log(`   ⚠️  [NINJA] Price momentum: ${priceMomentumPercent >= 0 ? '+' : ''}${priceMomentumPercent.toFixed(1)}% (below optimal ${NINJA_MIN_PRICE_MOMENTUM_PERCENT}%)`);
          }
        }
      }

      // 7d. MOVING AVERAGE TREND FILTER
      // Calculate MA_1min and MA_5min, block entry if current price is below either
      const currentPrice = Number(tradeToUse.priceBasePerToken || 0);

      if (currentPrice > 0 && buysIn5min.length > 0) {
        // Calculate MA_1min (average price in last 1 minute)
        const oneMinAgo = currentTradeTime - 1 * 60 * 1000;
        const tradesIn1min = buysIn5min.filter(t => new Date(t.timestamp).getTime() >= oneMinAgo);

        let ma1min: number | null = null;
        if (NINJA_MA_1MIN_ENABLED && tradesIn1min.length > 0) {
          const sum1min = tradesIn1min.reduce((sum, t) => sum + Number(t.priceBasePerToken || 0), 0);
          ma1min = sum1min / tradesIn1min.length;
        }

        // Calculate MA_5min (average price in last 5 minutes)
        let ma5min: number | null = null;
        if (NINJA_MA_5MIN_ENABLED && buysIn5min.length > 0) {
          const sum5min = buysIn5min.reduce((sum, t) => sum + Number(t.priceBasePerToken || 0), 0);
          ma5min = sum5min / buysIn5min.length;
        }

        // Check MA_1min
        if (ma1min !== null && currentPrice < ma1min) {
          const belowMa1minPercent = ((ma1min - currentPrice) / ma1min) * 100;
          console.log(`   ❌ [NINJA] Price below MA_1min: ${currentPrice.toExponential(4)} < ${ma1min.toExponential(4)} (-${belowMa1minPercent.toFixed(2)}%) - DOWNTREND, FILTERED OUT`);
          return { consensusFound: false };
        }

        // Check MA_5min
        if (ma5min !== null && currentPrice < ma5min) {
          const belowMa5minPercent = ((ma5min - currentPrice) / ma5min) * 100;
          console.log(`   ❌ [NINJA] Price below MA_5min: ${currentPrice.toExponential(4)} < ${ma5min.toExponential(4)} (-${belowMa5minPercent.toFixed(2)}%) - DOWNTREND, FILTERED OUT`);
          return { consensusFound: false };
        }

        // Log MA status
        if (ma1min !== null && ma5min !== null) {
          const aboveMa1minPercent = ((currentPrice - ma1min) / ma1min) * 100;
          const aboveMa5minPercent = ((currentPrice - ma5min) / ma5min) * 100;
          console.log(`   ✅ [NINJA] MA Trend: Price above MA_1min (+${aboveMa1minPercent.toFixed(2)}%) and MA_5min (+${aboveMa5minPercent.toFixed(2)}%) - UPTREND`);
        } else if (ma1min !== null) {
          const aboveMa1minPercent = ((currentPrice - ma1min) / ma1min) * 100;
          console.log(`   ✅ [NINJA] MA Trend: Price above MA_1min (+${aboveMa1minPercent.toFixed(2)}%)`);
        } else if (ma5min !== null) {
          const aboveMa5minPercent = ((currentPrice - ma5min) / ma5min) * 100;
          console.log(`   ✅ [NINJA] MA Trend: Price above MA_5min (+${aboveMa5minPercent.toFixed(2)}%)`);
        } else {
          console.log(`   ⚠️  [NINJA] MA Trend: Not enough data for MA calculation`);
        }
      }

      // 7e. WHALE ACTIVITY DETECTION (Pre-Entry)
      // Check for large sells that indicate whale dumping
      if (sellsIn5min.length > 0) {
        // Check each sell for whale activity
        for (const sell of sellsIn5min) {
          const sellAmountToken = Number(sell.amountToken || 0);
          const sellValueUsd = Number(sell.valueUsd || 0);

          // Calculate percentage of total supply (pump.fun = 1B tokens)
          const supplyPercent = (sellAmountToken / PUMP_FUN_TOTAL_SUPPLY) * 100;

          // BLOCK: Single sell > 1% of supply
          if (supplyPercent >= NINJA_WHALE_SUPPLY_PERCENT_BLOCK) {
            console.log(`   ❌ [NINJA] WHALE SELL detected: ${supplyPercent.toFixed(2)}% of supply in single TX ($${sellValueUsd.toFixed(0)}) - FILTERED OUT`);
            return { consensusFound: false };
          }

          // BLOCK: Single sell > $500 for low mcap tokens (< 100k)
          if (marketCap < NINJA_WHALE_USD_BLOCK_THRESHOLD_MCAP && sellValueUsd >= NINJA_WHALE_USD_BLOCK_LOW_MCAP) {
            console.log(`   ❌ [NINJA] LARGE SELL at low mcap: $${sellValueUsd.toFixed(0)} sell (${supplyPercent.toFixed(3)}% supply) at $${(marketCap / 1000).toFixed(1)}K mcap - FILTERED OUT`);
            return { consensusFound: false };
          }
        }

        // Log whale check passed
        const maxSellUsd = Math.max(...sellsIn5min.map(s => Number(s.valueUsd || 0)));
        const maxSellSupply = Math.max(...sellsIn5min.map(s => (Number(s.amountToken || 0) / PUMP_FUN_TOTAL_SUPPLY) * 100));
        console.log(`   ✅ [NINJA] Whale check: Max sell $${maxSellUsd.toFixed(0)} (${maxSellSupply.toFixed(3)}% supply) - no whale dumps`);
      } else {
        console.log(`   ✅ [NINJA] Whale check: No sells in 5min window`);
      }

      // 8. DIVERSITY CHECK (global - same for all tiers)
      const allTokenBuys24h = await this.tradeRepo.findBuysByTokenAndTimeWindow(
        tokenId,
        new Date(currentTradeTime - 24 * 60 * 60 * 1000),
        new Date(currentTradeTime)
      );

      const recentTradesForDiversity = allTokenBuys24h
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, NINJA_DIVERSITY_SAMPLE_SIZE);

      const uniqueWalletsInSample = new Set(recentTradesForDiversity.map(t => t.walletId)).size;
      const sampleSize = recentTradesForDiversity.length;
      const diversityPercent = sampleSize > 0 ? (uniqueWalletsInSample / sampleSize) * 100 : 100;

      if (diversityPercent < NINJA_MIN_DIVERSITY_PERCENT) {
        console.log(`   ❌ [NINJA] Diversity ${diversityPercent.toFixed(0)}% < ${NINJA_MIN_DIVERSITY_PERCENT}% (${uniqueWalletsInSample}/${sampleSize} unique) - wash trading? FILTERED OUT`);
        return { consensusFound: false };
      }
      console.log(`   ✅ [NINJA] Diversity: ${diversityPercent.toFixed(0)}% (${uniqueWalletsInSample}/${sampleSize} unique, min ${NINJA_MIN_DIVERSITY_PERCENT}%)`);

      // 9. TOKEN AGE CHECK (global - 1 hour minimum)
      let tokenAgeMinutes: number | null = null;
      if (allTokenBuys24h.length > 0) {
        const oldestBuy = allTokenBuys24h.reduce((oldest, t) =>
          new Date(t.timestamp).getTime() < new Date(oldest.timestamp).getTime() ? t : oldest
        );
        tokenAgeMinutes = (currentTradeTime - new Date(oldestBuy.timestamp).getTime()) / (1000 * 60);
      }

      if (tokenAgeMinutes !== null && tokenAgeMinutes < NINJA_MIN_TOKEN_AGE_MINUTES) {
        console.log(`   ❌ [NINJA] Token age ${tokenAgeMinutes.toFixed(0)}min < ${NINJA_MIN_TOKEN_AGE_MINUTES}min minimum - FILTERED OUT`);
        return { consensusFound: false };
      }
      console.log(`   ✅ [NINJA] Token age: ${tokenAgeMinutes ? tokenAgeMinutes.toFixed(0) + 'min' : 'N/A'} (min ${NINJA_MIN_TOKEN_AGE_MINUTES}min)`);

      // ALL NINJA CHECKS PASSED!
      isNinjaSignal = true;
      console.log(`   🥷 [NINJA] ✅ ${tier.name} SIGNAL CONFIRMED!`);
      console.log(`      MCap: $${(marketCap / 1000).toFixed(1)}K | Liq: $${liquidity ? (liquidity / 1000).toFixed(1) + 'K' : 'N/A'}`);
      console.log(`      Wallets: ${ninjaWalletCount} in ${ninjaTimeWindowMinutes}min | Activity: ${uniqueBuyersInActivityWindow} in ${tier.activityWindowMinutes}min`);
      console.log(`      Diversity: ${diversityPercent.toFixed(0)}% | Age: ${tokenAgeMinutes ? tokenAgeMinutes.toFixed(0) + 'min' : 'N/A'}`);

      // CONSENSUS signals are DISABLED - only NINJA signals are emitted
      if (!isNinjaSignal) {
        console.log(`   ❌ [NINJA] Signal validation failed - FILTERED OUT`);
        return { consensusFound: false };
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

        // Pokud je stejný nebo menší počet wallets, skip
        if (uniqueWallets.size <= previousWalletCount) {
          console.log(`   ⏭️  [NINJA] Already notified for ${previousWalletCount} wallets, current: ${uniqueWallets.size} - skipping`);
          return { consensusFound: true };
        }

        // Nový wallet se přidal - NINJA update!
        isUpdate = true;
        console.log(`   📈 [NINJA] Update: ${previousWalletCount} → ${uniqueWallets.size} wallets`);

        // Aktualizuj existující signal
        await this.signalRepo.update(existingSignal.id, {
          meta: {
            ...(existingSignal.meta as object || {}),
            walletCount: uniqueWallets.size,
            lastUpdateTradeId: newTradeId,
          },
          qualityScore: uniqueWallets.size >= 4 ? 90 : uniqueWallets.size >= 3 ? 80 : 60,
          riskLevel,
          reasoning: `NINJA: ${uniqueWallets.size} smart wallets bought this token`,
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

          // Signal type is always NINJA (CONSENSUS signals disabled)
          // For updates, we use 'ninja-update' instead of 'consensus-update'
          let signalType: string = isUpdate ? 'ninja-update' : 'ninja';

          // Set default SL/TP (always NINJA parameters)
          const defaultStopLoss = NINJA_STOP_LOSS_PERCENT;
          const defaultTakeProfit = NINJA_TAKE_PROFIT_PERCENT;

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
            // Calculate dynamic priority fee based on momentum (ČÁST 10)
            // Very strong: buy/sell >3.0 AND price +15-25%
            // Standard: buy/sell 1.5-3.0 AND price +5-15%
            // Weak: anything else that passed filters
            let dynamicPriorityFeeLamports = PRIORITY_FEE_STANDARD_LAMPORTS; // Default to standard
            let priorityFeeReason = 'standard';

            if (buySellVolumeRatio >= PRIORITY_FEE_VERY_STRONG_MIN_BS_RATIO &&
                momentumPriceMomentumPercent >= PRIORITY_FEE_VERY_STRONG_MIN_PRICE_CHANGE &&
                momentumPriceMomentumPercent <= PRIORITY_FEE_VERY_STRONG_MAX_PRICE_CHANGE) {
              // Very strong momentum - highest priority
              dynamicPriorityFeeLamports = PRIORITY_FEE_VERY_STRONG_LAMPORTS;
              priorityFeeReason = 'very_strong';
            } else if (buySellVolumeRatio >= PRIORITY_FEE_STANDARD_MIN_BS_RATIO &&
                       momentumPriceMomentumPercent >= PRIORITY_FEE_STANDARD_MIN_PRICE_CHANGE) {
              // Standard momentum - normal priority
              dynamicPriorityFeeLamports = PRIORITY_FEE_STANDARD_LAMPORTS;
              priorityFeeReason = 'standard';
            } else {
              // Weak momentum (passed filters but not optimal) - lower priority
              dynamicPriorityFeeLamports = PRIORITY_FEE_WEAK_LAMPORTS;
              priorityFeeReason = 'weak';
            }

            console.log(`   💰 [NINJA] Priority fee: ${(dynamicPriorityFeeLamports / 1e9).toFixed(6)} SOL (${priorityFeeReason}) - B/S ratio: ${buySellVolumeRatio.toFixed(2)}, Price momentum: +${momentumPriceMomentumPercent.toFixed(1)}%`);

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
              priorityFeeLamports: dynamicPriorityFeeLamports,
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
