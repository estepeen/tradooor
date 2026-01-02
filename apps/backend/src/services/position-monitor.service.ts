/**
 * Position Monitor Service
 *
 * Sleduje virtuální pozice vytvořené z consensus signálů.
 * Generuje EXIT signály když:
 * - Smart wallets prodávají
 * - Cena dosáhne SL/TP
 * - Trailing stop je hit
 * - AI doporučí exit
 * - Pozice je příliš dlouho otevřená
 */

import { prisma } from '../lib/prisma.js';
import { TokenMarketDataService } from './token-market-data.service.js';
import { AIExitService, ExitContext as AIExitContext, AIExitDecision } from './ai-exit.service.js';
import { DiscordNotificationService } from './discord-notification.service.js';

// Liquidity Monitoring Constants
const LIQUIDITY_DROP_EMERGENCY_PERCENT = 15;  // >15% drop from entry = EMERGENCY EXIT

// Buy/Sell Pressure Monitoring Constants
const SELL_PRESSURE_EXIT_RATIO = 0.7;  // If buy/sell ratio < 0.7, exit 50%

// Whale Activity Monitoring Constants
const WHALE_DUMP_SUPPLY_PERCENT = 2.0;  // If whale sells > 2% supply = EMERGENCY EXIT 75%
const PUMP_FUN_TOTAL_SUPPLY = 1_000_000_000;  // 1B tokens for pump.fun
import {
  VirtualPositionRepository,
  VirtualPositionRecord,
} from '../repositories/virtual-position.repository.js';
import {
  ExitSignalRepository,
  ExitSignalRecord,
  ExitSignalType,
  ExitStrength,
  ExitRecommendation,
} from '../repositories/exit-signal.repository.js';
import {
  PositionWalletActivityRepository,
  PositionWalletActivityRecord,
} from '../repositories/position-wallet-activity.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';

// ============================================
// Types
// ============================================

export interface ExitContext {
  position: VirtualPositionRecord;
  walletActivities: PositionWalletActivityRecord[];
  currentPrice: number;
  pnlPercent: number;
  holdTimeMinutes: number;
  exitedWalletsPercent: number;
  volumeTrend: 'increasing' | 'stable' | 'decreasing';
  drawdownFromPeak: number;
  recentExits: PositionWalletActivityRecord[];
}

export interface ExitCheckResult {
  exitSignal?: ExitSignalRecord;
  aiDecision?: AIExitDecision;
  updated: boolean;
}

// ============================================
// Service
// ============================================

export class PositionMonitorService {
  private tokenMarketData: TokenMarketDataService;
  private aiExit: AIExitService;
  private discord: DiscordNotificationService;
  private positionRepo: VirtualPositionRepository;
  private exitSignalRepo: ExitSignalRepository;
  private walletActivityRepo: PositionWalletActivityRepository;
  private tradeRepo: TradeRepository;

  constructor() {
    this.tokenMarketData = new TokenMarketDataService();
    this.aiExit = new AIExitService();
    this.discord = new DiscordNotificationService();
    this.positionRepo = new VirtualPositionRepository();
    this.exitSignalRepo = new ExitSignalRepository();
    this.walletActivityRepo = new PositionWalletActivityRepository();
    this.tradeRepo = new TradeRepository();
  }

  // ============================================
  // Position Creation
  // ============================================

  /**
   * Vytvoří virtuální pozici z consensus signálu
   */
  async createPositionFromConsensus(
    consensusSignalId: string,
    tokenId: string,
    signalId: string | null,
    entryPriceUsd: number,
    walletIds: string[],
    marketData?: {
      marketCapUsd?: number;
      liquidityUsd?: number;
      stopLossPercent?: number;
      takeProfitPercent?: number;
    }
  ): Promise<VirtualPositionRecord> {
    console.log(`📊 [PositionMonitor] Creating position for token ${tokenId.substring(0, 8)}...`);

    // Calculate suggested SL/TP based on market cap
    const stopLoss = marketData?.stopLossPercent || this.calculateDefaultStopLoss(marketData?.marketCapUsd);
    const takeProfit = marketData?.takeProfitPercent || this.calculateDefaultTakeProfit(marketData?.marketCapUsd);

    const position = await this.positionRepo.create({
      tokenId,
      signalId,
      consensusSignalId,
      entryPriceUsd,
      entryWalletCount: walletIds.length,
      entryMarketCapUsd: marketData?.marketCapUsd,
      entryLiquidityUsd: marketData?.liquidityUsd,
      walletIds,
      suggestedStopLoss: entryPriceUsd * (1 - stopLoss / 100),
      suggestedTakeProfit: entryPriceUsd * (1 + takeProfit / 100),
      trailingStopPercent: 20, // Default 20% trailing
    });

    // Create wallet activity records
    for (const walletId of walletIds) {
      await this.walletActivityRepo.create({
        positionId: position.id,
        walletId,
        entryPriceUsd,
        entryTimestamp: new Date(),
      });
    }

    console.log(`✅ [PositionMonitor] Created position ${position.id.substring(0, 8)} with ${walletIds.length} wallets`);
    return position;
  }

  private calculateDefaultStopLoss(marketCapUsd?: number): number {
    if (!marketCapUsd) return 30;
    if (marketCapUsd < 100000) return 40; // Very small - wider stop
    if (marketCapUsd < 500000) return 30;
    return 25; // Larger - tighter stop
  }

  private calculateDefaultTakeProfit(marketCapUsd?: number): number {
    if (!marketCapUsd) return 100;
    if (marketCapUsd < 100000) return 150; // Very small - more room
    if (marketCapUsd < 500000) return 100;
    return 75; // Larger - more conservative
  }

  // ============================================
  // Position Monitoring
  // ============================================

  /**
   * Aktualizuje všechny otevřené pozice
   */
  async updateAllOpenPositions(): Promise<{
    updated: number;
    exitSignals: number;
    errors: number;
  }> {
    const stats = { updated: 0, exitSignals: 0, errors: 0 };

    const openPositions = await this.positionRepo.findOpen({ limit: 100 });
    console.log(`📊 [PositionMonitor] Updating ${openPositions.length} open positions...`);

    if (openPositions.length === 0) {
      return stats;
    }

    // Get token mint addresses for price fetching
    const tokenIds = [...new Set(openPositions.map(p => p.tokenId))];
    const tokens = await prisma.token.findMany({
      where: { id: { in: tokenIds } },
      select: { id: true, mintAddress: true, symbol: true },
    });
    const tokenMap = new Map(tokens.map(t => [t.id, t]));

    // Process each position
    for (const position of openPositions) {
      try {
        const token = tokenMap.get(position.tokenId);
        if (!token) {
          console.warn(`⚠️  [PositionMonitor] Token not found for position ${position.id}`);
          stats.errors++;
          continue;
        }

        const result = await this.updatePosition(position, token.mintAddress);

        if (result.updated) {
          stats.updated++;
        }

        if (result.exitSignal) {
          stats.exitSignals++;
          // Send Discord notification
          await this.sendExitNotification(result.exitSignal, position, token);
        }

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.error(`❌ [PositionMonitor] Error updating position ${position.id}:`, error);
        stats.errors++;
      }
    }

    console.log(`✅ [PositionMonitor] Updated ${stats.updated}, ${stats.exitSignals} exit signals, ${stats.errors} errors`);
    return stats;
  }

  /**
   * Aktualizuje jednu pozici - cena, P&L, kontroluje exit podmínky
   */
  async updatePosition(
    position: VirtualPositionRecord,
    tokenMintAddress: string
  ): Promise<ExitCheckResult> {
    const result: ExitCheckResult = { updated: false };

    // Fetch current price
    const marketData = await this.tokenMarketData.getMarketData(tokenMintAddress);
    if (!marketData?.price) {
      console.warn(`⚠️  [PositionMonitor] No price data for ${tokenMintAddress}`);
      return result;
    }

    const currentPrice = marketData.price;

    // Update position with current price
    const updatedPosition = await this.positionRepo.updatePriceAndPnl(
      position.id,
      currentPrice
    );

    if (!updatedPosition) {
      return result;
    }

    result.updated = true;

    // Check exit conditions
    const exitSignal = await this.checkExitConditions(updatedPosition, {
      currentPrice,
      marketCapUsd: marketData.marketCap,
      liquidityUsd: marketData.liquidity,
    });

    if (exitSignal) {
      result.exitSignal = exitSignal;
    }

    return result;
  }

  /**
   * Kontroluje podmínky pro exit
   */
  private async checkExitConditions(
    position: VirtualPositionRecord,
    context: {
      currentPrice: number;
      marketCapUsd?: number;
      liquidityUsd?: number;
    }
  ): Promise<ExitSignalRecord | undefined> {
    const pnlPercent = position.unrealizedPnlPercent || 0;
    const drawdown = position.drawdownFromPeak || 0;
    const holdTimeMinutes = (Date.now() - position.entryTimestamp.getTime()) / 60000;

    // 0. EMERGENCY: Check liquidity drop (>15% from entry = immediate exit)
    if (context.liquidityUsd !== undefined && position.entryLiquidityUsd) {
      const liquidityDropPercent = ((position.entryLiquidityUsd - context.liquidityUsd) / position.entryLiquidityUsd) * 100;

      if (liquidityDropPercent > LIQUIDITY_DROP_EMERGENCY_PERCENT) {
        console.log(`   🚨 [PositionMonitor] EMERGENCY: Liquidity dropped ${liquidityDropPercent.toFixed(1)}% from entry!`);
        console.log(`      Entry: $${(position.entryLiquidityUsd / 1000).toFixed(1)}K → Current: $${(context.liquidityUsd / 1000).toFixed(1)}K`);

        return this.createExitSignal(position, {
          type: 'liquidity_drop',
          strength: 'strong',
          recommendation: 'full_exit',
          priceAtSignal: context.currentPrice,
          pnlPercentAtSignal: pnlPercent,
          triggerReason: `EMERGENCY: Liquidity dropped ${liquidityDropPercent.toFixed(1)}% from entry ($${(position.entryLiquidityUsd / 1000).toFixed(1)}K → $${(context.liquidityUsd / 1000).toFixed(1)}K)`,
          marketCapAtSignal: context.marketCapUsd,
          liquidityAtSignal: context.liquidityUsd,
        });
      }

      // Log liquidity status for monitoring
      if (liquidityDropPercent > 5) {
        console.log(`   ⚠️  [PositionMonitor] Liquidity warning: -${liquidityDropPercent.toFixed(1)}% from entry`);
      }
    }

    // 0b. Check sell pressure (buy/sell ratio in last 5min)
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const now = new Date();
    const buysIn5min = await this.tradeRepo.findBuysByTokenAndTimeWindow(
      position.tokenId,
      fiveMinAgo,
      now
    );
    const sellsIn5min = await this.tradeRepo.findSellsByTokenAndTimeWindow(
      position.tokenId,
      fiveMinAgo,
      now
    );

    const buyVolumeUsd = buysIn5min.reduce((sum, t) => sum + Number(t.valueUsd || 0), 0);
    const sellVolumeUsd = sellsIn5min.reduce((sum, t) => sum + Number(t.valueUsd || 0), 0);
    const buySellRatio = sellVolumeUsd > 0 ? buyVolumeUsd / sellVolumeUsd : 999;

    if (buySellRatio < SELL_PRESSURE_EXIT_RATIO && sellVolumeUsd > 0) {
      console.log(`   🚨 [PositionMonitor] SELL PRESSURE: Buy/Sell ratio ${buySellRatio.toFixed(2)} < ${SELL_PRESSURE_EXIT_RATIO}`);
      console.log(`      Buys: $${buyVolumeUsd.toFixed(0)} vs Sells: $${sellVolumeUsd.toFixed(0)}`);

      return this.createExitSignal(position, {
        type: 'sell_pressure',
        strength: 'medium',
        recommendation: 'partial_exit_50',
        priceAtSignal: context.currentPrice,
        pnlPercentAtSignal: pnlPercent,
        triggerReason: `Sell pressure detected: Buy/Sell ratio ${buySellRatio.toFixed(2)} (buys: $${buyVolumeUsd.toFixed(0)} vs sells: $${sellVolumeUsd.toFixed(0)})`,
        marketCapAtSignal: context.marketCapUsd,
        liquidityAtSignal: context.liquidityUsd,
      });
    }

    // Log buy/sell pressure status
    if (buySellRatio < 1.5 && sellVolumeUsd > 0) {
      console.log(`   ⚠️  [PositionMonitor] Pressure warning: Buy/Sell ${buySellRatio.toFixed(2)}x`);
    }

    // 0c. Check whale dumps (single sell > 2% of supply)
    if (sellsIn5min.length > 0) {
      for (const sell of sellsIn5min) {
        const sellAmountToken = Number(sell.amountToken || 0);
        const sellValueUsd = Number(sell.valueUsd || 0);
        const supplyPercent = (sellAmountToken / PUMP_FUN_TOTAL_SUPPLY) * 100;

        if (supplyPercent >= WHALE_DUMP_SUPPLY_PERCENT) {
          console.log(`   🐋 [PositionMonitor] WHALE DUMP: ${supplyPercent.toFixed(2)}% of supply sold ($${sellValueUsd.toFixed(0)})`);

          return this.createExitSignal(position, {
            type: 'whale_dump',
            strength: 'strong',
            recommendation: 'partial_exit_75',
            priceAtSignal: context.currentPrice,
            pnlPercentAtSignal: pnlPercent,
            triggerReason: `WHALE DUMP: ${supplyPercent.toFixed(2)}% of supply sold in single TX ($${sellValueUsd.toFixed(0)})`,
            marketCapAtSignal: context.marketCapUsd,
            liquidityAtSignal: context.liquidityUsd,
          });
        }
      }

      // Log max sell for monitoring
      const maxSellSupply = Math.max(...sellsIn5min.map(s => (Number(s.amountToken || 0) / PUMP_FUN_TOTAL_SUPPLY) * 100));
      if (maxSellSupply > 0.5) {
        console.log(`   ⚠️  [PositionMonitor] Large sell detected: ${maxSellSupply.toFixed(2)}% of supply`);
      }
    }

    // 1. Check stop loss
    if (position.suggestedStopLoss && context.currentPrice <= position.suggestedStopLoss) {
      return this.createExitSignal(position, {
        type: 'stop_loss',
        strength: 'strong',
        recommendation: 'full_exit',
        priceAtSignal: context.currentPrice,
        pnlPercentAtSignal: pnlPercent,
        triggerReason: `Price hit stop loss at $${position.suggestedStopLoss.toFixed(8)}`,
        marketCapAtSignal: context.marketCapUsd,
        liquidityAtSignal: context.liquidityUsd,
      });
    }

    // 2. Check trailing stop
    if (position.trailingStopPrice && context.currentPrice <= position.trailingStopPrice) {
      return this.createExitSignal(position, {
        type: 'trailing_stop',
        strength: 'strong',
        recommendation: 'full_exit',
        priceAtSignal: context.currentPrice,
        pnlPercentAtSignal: pnlPercent,
        drawdownAtSignal: drawdown,
        triggerReason: `Trailing stop triggered at $${position.trailingStopPrice.toFixed(8)} (${position.trailingStopPercent}% from peak)`,
        marketCapAtSignal: context.marketCapUsd,
        liquidityAtSignal: context.liquidityUsd,
      });
    }

    // 3. Check take profit
    if (position.suggestedTakeProfit && context.currentPrice >= position.suggestedTakeProfit) {
      return this.createExitSignal(position, {
        type: 'take_profit',
        strength: 'medium',
        recommendation: 'partial_exit_50',
        priceAtSignal: context.currentPrice,
        pnlPercentAtSignal: pnlPercent,
        triggerReason: `Price hit take profit at $${position.suggestedTakeProfit.toFixed(8)}`,
        marketCapAtSignal: context.marketCapUsd,
        liquidityAtSignal: context.liquidityUsd,
      });
    }

    // 4. Check wallet exits (if 50%+ wallets exited)
    const walletExitPercent = position.entryWalletCount > 0
      ? (position.exitedWalletCount / position.entryWalletCount) * 100
      : 0;

    if (walletExitPercent >= 50) {
      return this.createExitSignal(position, {
        type: 'wallet_exit',
        strength: walletExitPercent >= 75 ? 'strong' : 'medium',
        recommendation: walletExitPercent >= 75 ? 'full_exit' : 'partial_exit_75',
        priceAtSignal: context.currentPrice,
        pnlPercentAtSignal: pnlPercent,
        walletsExitedCount: position.exitedWalletCount,
        walletsHoldingCount: position.activeWalletCount,
        triggerReason: `${walletExitPercent.toFixed(0)}% of original wallets have exited`,
        marketCapAtSignal: context.marketCapUsd,
        liquidityAtSignal: context.liquidityUsd,
      });
    }

    // 5. Check time-based exit (24+ hours)
    if (holdTimeMinutes >= 24 * 60 && pnlPercent < 20) {
      return this.createExitSignal(position, {
        type: 'time_based',
        strength: 'weak',
        recommendation: 'partial_exit_50',
        priceAtSignal: context.currentPrice,
        pnlPercentAtSignal: pnlPercent,
        triggerReason: `Position held for ${(holdTimeMinutes / 60).toFixed(1)}h with only ${pnlPercent.toFixed(1)}% gain`,
        marketCapAtSignal: context.marketCapUsd,
        liquidityAtSignal: context.liquidityUsd,
      });
    }

    // 6. Check AI exit (if conditions warrant evaluation)
    if (this.aiExit.shouldEvaluate(position, this.buildAIExitContext(position, context))) {
      const aiContext = this.buildAIExitContext(position, context);
      const aiDecision = await this.aiExit.evaluateExit(aiContext);

      // Update position with AI decision
      await this.positionRepo.updateAiDecision(
        position.id,
        aiDecision.decision,
        aiDecision.confidence,
        aiDecision.reasoning
      );

      // Generate exit signal if AI recommends exit
      if (aiDecision.decision !== 'hold' && aiDecision.confidence >= 60) {
        return this.createExitSignal(position, {
          type: 'ai_recommendation',
          strength: aiDecision.urgency === 'high' ? 'strong' : aiDecision.urgency === 'medium' ? 'medium' : 'weak',
          recommendation: aiDecision.decision as ExitRecommendation,
          priceAtSignal: context.currentPrice,
          pnlPercentAtSignal: pnlPercent,
          drawdownAtSignal: drawdown,
          aiDecision: aiDecision.decision,
          aiConfidence: aiDecision.confidence,
          aiReasoning: aiDecision.reasoning,
          marketCapAtSignal: context.marketCapUsd,
          liquidityAtSignal: context.liquidityUsd,
        });
      }
    }

    return undefined;
  }

  private buildAIExitContext(
    position: VirtualPositionRecord,
    context: { currentPrice: number; marketCapUsd?: number; liquidityUsd?: number }
  ): AIExitContext {
    const holdTimeMinutes = (Date.now() - position.entryTimestamp.getTime()) / 60000;
    const pnlPercent = position.unrealizedPnlPercent || 0;
    const athPnlPercent = position.highestPriceUsd
      ? ((position.highestPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100
      : pnlPercent;

    return {
      position,
      currentPriceUsd: context.currentPrice,
      marketCapUsd: context.marketCapUsd,
      liquidityUsd: context.liquidityUsd,
      pnlPercent,
      athPnlPercent,
      drawdownFromPeakPercent: position.drawdownFromPeak || 0,
      holdTimeMinutes,
      entryWalletCount: position.entryWalletCount,
      activeWalletCount: position.activeWalletCount,
      exitedWalletCount: position.exitedWalletCount,
    };
  }

  /**
   * Vytvoří exit signál
   */
  private async createExitSignal(
    position: VirtualPositionRecord,
    data: {
      type: ExitSignalType;
      strength: ExitStrength;
      recommendation: ExitRecommendation;
      priceAtSignal?: number;
      pnlPercentAtSignal?: number;
      drawdownAtSignal?: number;
      walletsExitedCount?: number;
      walletsHoldingCount?: number;
      triggerWalletId?: string;
      triggerTradeId?: string;
      triggerReason?: string;
      aiDecision?: string;
      aiConfidence?: number;
      aiReasoning?: string;
      marketCapAtSignal?: number;
      liquidityAtSignal?: number;
    }
  ): Promise<ExitSignalRecord> {
    console.log(`🚨 [PositionMonitor] Creating ${data.type} exit signal for position ${position.id.substring(0, 8)}`);

    const exitSignal = await this.exitSignalRepo.create({
      positionId: position.id,
      tokenId: position.tokenId,
      ...data,
    });

    // Record notification in position
    await this.positionRepo.recordNotificationSent(position.id);

    return exitSignal;
  }

  // ============================================
  // Smart Wallet Exit Detection
  // ============================================

  /**
   * Detekuje když smart wallet prodá token z aktivní pozice
   */
  async recordWalletExit(
    tradeId: string,
    walletId: string,
    tokenId: string,
    exitPriceUsd: number,
    exitAmountUsd?: number
  ): Promise<ExitSignalRecord | undefined> {
    console.log(`👛 [PositionMonitor] Recording wallet exit: ${walletId.substring(0, 8)} from token ${tokenId.substring(0, 8)}`);

    // Find open positions for this token with this wallet
    const positions = await this.positionRepo.findByTokenId(tokenId, 'open');

    for (const position of positions) {
      if (!position.walletIds.includes(walletId)) continue;

      // Record wallet exit
      await this.walletActivityRepo.recordFullExit(position.id, walletId, {
        exitTradeId: tradeId,
        exitPriceUsd,
        exitAmountUsd,
      });

      // Update position wallet counts
      const stats = await this.walletActivityRepo.getPositionWalletStats(position.id);
      await this.positionRepo.updateWalletCounts(
        position.id,
        stats.holdingCount + stats.partialExitCount,
        stats.fullExitCount
      );

      // Check if this triggers an exit signal
      const walletExitPercent = position.entryWalletCount > 0
        ? ((stats.fullExitCount + 1) / position.entryWalletCount) * 100
        : 0;

      if (walletExitPercent >= 25) {
        const strength: ExitStrength = walletExitPercent >= 75 ? 'strong' : walletExitPercent >= 50 ? 'medium' : 'weak';
        const recommendation: ExitRecommendation = walletExitPercent >= 75 ? 'full_exit'
          : walletExitPercent >= 50 ? 'partial_exit_75'
          : 'partial_exit_25';

        return this.createExitSignal(position, {
          type: 'wallet_exit',
          strength,
          recommendation,
          priceAtSignal: exitPriceUsd,
          pnlPercentAtSignal: position.unrealizedPnlPercent || undefined,
          walletsExitedCount: stats.fullExitCount + 1,
          walletsHoldingCount: stats.holdingCount,
          triggerWalletId: walletId,
          triggerTradeId: tradeId,
          triggerReason: `${walletExitPercent.toFixed(0)}% of wallets have exited`,
        });
      }
    }

    return undefined;
  }

  // ============================================
  // Position Management
  // ============================================

  /**
   * Zavře pozici
   */
  async closePosition(
    positionId: string,
    exitReason: string,
    exitPriceUsd: number
  ): Promise<VirtualPositionRecord | null> {
    console.log(`📊 [PositionMonitor] Closing position ${positionId.substring(0, 8)}, reason: ${exitReason}`);
    return this.positionRepo.close(positionId, exitReason, exitPriceUsd);
  }

  /**
   * Nastaví trailing stop procento
   */
  async setTrailingStop(
    positionId: string,
    trailingStopPercent: number
  ): Promise<VirtualPositionRecord | null> {
    console.log(`📊 [PositionMonitor] Setting trailing stop ${trailingStopPercent}% for position ${positionId.substring(0, 8)}`);
    return this.positionRepo.setTrailingStop(positionId, trailingStopPercent);
  }

  /**
   * Získá všechny otevřené pozice
   */
  async getOpenPositions(): Promise<VirtualPositionRecord[]> {
    return this.positionRepo.findOpen();
  }

  /**
   * Získá pozici podle ID
   */
  async getPosition(positionId: string): Promise<VirtualPositionRecord | null> {
    return this.positionRepo.findById(positionId);
  }

  /**
   * Získá pozici s detaily
   */
  async getPositionWithDetails(positionId: string): Promise<{
    position: VirtualPositionRecord;
    walletActivities: PositionWalletActivityRecord[];
    exitSignals: ExitSignalRecord[];
  } | null> {
    const position = await this.positionRepo.findById(positionId);
    if (!position) return null;

    const walletActivities = await this.walletActivityRepo.findByPositionId(positionId);
    const exitSignals = await this.exitSignalRepo.findByPositionId(positionId);

    return { position, walletActivities, exitSignals };
  }

  /**
   * Získá statistiky pozic
   */
  async getStats(): Promise<{
    totalOpen: number;
    totalClosed: number;
    avgOpenPnlPercent: number;
    avgClosedPnlPercent: number;
    winRate: number;
  }> {
    return this.positionRepo.getStats();
  }

  // ============================================
  // Discord Notifications
  // ============================================

  /**
   * Pošle Discord notifikaci o exit signálu
   */
  private async sendExitNotification(
    exitSignal: ExitSignalRecord,
    position: VirtualPositionRecord,
    token: { mintAddress: string; symbol: string | null }
  ): Promise<void> {
    try {
      // Mark as sent
      await this.exitSignalRepo.markNotificationSent(exitSignal.id);

      // Build and send notification
      const pnlStr = exitSignal.pnlPercentAtSignal !== null
        ? `${exitSignal.pnlPercentAtSignal >= 0 ? '+' : ''}${exitSignal.pnlPercentAtSignal.toFixed(1)}%`
        : 'N/A';

      const holdTimeMinutes = (Date.now() - position.entryTimestamp.getTime()) / 60000;
      const holdTimeStr = holdTimeMinutes >= 60
        ? `${Math.floor(holdTimeMinutes / 60)}h ${Math.round(holdTimeMinutes % 60)}m`
        : `${Math.round(holdTimeMinutes)}m`;

      console.log(`📨 [PositionMonitor] Sending exit notification for ${token.symbol || token.mintAddress.substring(0, 8)}`);
      console.log(`   Type: ${exitSignal.type}, Recommendation: ${exitSignal.recommendation}, PnL: ${pnlStr}, Hold: ${holdTimeStr}`);

      // TODO: Implement exit notification embed in DiscordNotificationService
      // For now, just log the notification
    } catch (error) {
      console.error(`❌ [PositionMonitor] Error sending exit notification:`, error);
    }
  }
}
