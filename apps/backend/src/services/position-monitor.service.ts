/**
 * Position Monitor Service
 * 
 * Sleduje virtuální pozice vytvořené z consensus signálů.
 * Generuje EXIT signály když:
 * - Smart wallets prodávají
 * - Cena dosáhne SL/TP
 * - AI doporučí exit
 * - Pozice je příliš dlouho otevřená
 */

import { supabase, TABLES } from '../lib/supabase.js';
import { TokenMarketDataService } from './token-market-data.service.js';
import { AIDecisionService } from './ai-decision.service.js';
import { DiscordNotificationService } from './discord-notification.service.js';
import { RugCheckService } from './rugcheck.service.js';

// ============================================
// Types
// ============================================

export interface VirtualPosition {
  id: string;
  tokenId: string;
  consensusSignalId?: string;
  entryPriceUsd: number;
  entryTime: Date;
  entryWalletCount: number;
  entryMarketCapUsd?: number;
  entryLiquidityUsd?: number;
  currentPriceUsd?: number;
  currentMarketCapUsd?: number;
  lastPriceUpdate?: Date;
  unrealizedPnlPercent?: number;
  unrealizedPnlUsd?: number;
  highestPriceUsd?: number;
  lowestPriceUsd?: number;
  maxDrawdownPercent?: number;
  activeWalletCount: number;
  exitedWalletCount: number;
  walletIds: string[];
  status: 'open' | 'partial_exit' | 'closed' | 'stopped';
  exitReason?: string;
  exitPriceUsd?: number;
  exitTime?: Date;
  realizedPnlPercent?: number;
  realizedPnlUsd?: number;
  lastAiDecision?: string;
  lastAiConfidence?: number;
  lastAiReasoning?: string;
  lastAiEvaluation?: Date;
  suggestedStopLoss?: number;
  suggestedTakeProfit?: number;
  trailingStopPercent?: number;
  lastNotificationSent?: Date;
  notificationCount: number;
  createdAt: Date;
  updatedAt: Date;
  // Joined fields
  token?: {
    symbol: string;
    mintAddress: string;
  };
}

export interface PositionWalletActivity {
  id: string;
  positionId: string;
  walletId: string;
  entryTradeId?: string;
  entryPriceUsd?: number;
  entryAmountUsd?: number;
  entryTime?: Date;
  exitTradeId?: string;
  exitPriceUsd?: number;
  exitAmountUsd?: number;
  exitTime?: Date;
  status: 'holding' | 'partial_exit' | 'full_exit';
  holdingPercent: number;
  realizedPnlPercent?: number;
  realizedPnlUsd?: number;
  wallet?: {
    address: string;
    label?: string;
    score: number;
  };
}

export interface ExitSignal {
  id: string;
  positionId: string;
  tokenId: string;
  type: 'wallet_exit' | 'stop_loss' | 'take_profit' | 'trailing_stop' | 'ai_recommendation' | 'time_based';
  strength: 'weak' | 'medium' | 'strong';
  recommendation: 'hold' | 'partial_exit' | 'full_exit';
  priceAtSignal?: number;
  pnlPercentAtSignal?: number;
  walletsExitedCount?: number;
  walletsHoldingCount?: number;
  triggerWalletId?: string;
  triggerTradeId?: string;
  triggerReason?: string;
  aiDecision?: string;
  aiConfidence?: number;
  aiReasoning?: string;
  notificationSent: boolean;
  notificationSentAt?: Date;
  createdAt: Date;
}

export interface ExitContext {
  position: VirtualPosition;
  walletActivities: PositionWalletActivity[];
  currentPrice: number;
  pnlPercent: number;
  holdTimeMinutes: number;
  exitedWalletsPercent: number;
  volumeTrend: 'increasing' | 'stable' | 'decreasing';
  priceFromAth: number; // % down from ATH
  recentExits: PositionWalletActivity[];
}

// ============================================
// Service
// ============================================

export class PositionMonitorService {
  private tokenMarketData: TokenMarketDataService;
  private aiDecision: AIDecisionService;
  private discord: DiscordNotificationService;
  private rugCheck: RugCheckService;

  constructor() {
    this.tokenMarketData = new TokenMarketDataService();
    this.aiDecision = new AIDecisionService();
    this.discord = new DiscordNotificationService();
    this.rugCheck = new RugCheckService();
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
    entryPriceUsd: number,
    walletIds: string[],
    marketData?: { marketCap?: number; liquidity?: number }
  ): Promise<VirtualPosition | null> {
    try {
      // Check if position already exists for this consensus
      const { data: existing } = await supabase
        .from('VirtualPosition')
        .select('id')
        .eq('consensusSignalId', consensusSignalId)
        .single();

      if (existing) {
        console.log(`   Position already exists for consensus ${consensusSignalId.substring(0, 8)}...`);
        return null;
      }

      // Calculate suggested SL/TP (default: -20% SL, +50% TP)
      const suggestedStopLoss = entryPriceUsd * 0.8;
      const suggestedTakeProfit = entryPriceUsd * 1.5;

      const { data: position, error } = await supabase
        .from('VirtualPosition')
        .insert({
          tokenId,
          consensusSignalId,
          entryPriceUsd,
          entryTime: new Date().toISOString(),
          entryWalletCount: walletIds.length,
          entryMarketCapUsd: marketData?.marketCap,
          entryLiquidityUsd: marketData?.liquidity,
          currentPriceUsd: entryPriceUsd,
          highestPriceUsd: entryPriceUsd,
          lowestPriceUsd: entryPriceUsd,
          activeWalletCount: walletIds.length,
          exitedWalletCount: 0,
          walletIds,
          status: 'open',
          suggestedStopLoss,
          suggestedTakeProfit,
          trailingStopPercent: 20, // 20% trailing stop
        })
        .select()
        .single();

      if (error) {
        console.error('Error creating position:', error);
        return null;
      }

      // Create wallet activity entries
      for (const walletId of walletIds) {
        await this.createWalletActivity(position.id, walletId, entryPriceUsd);
      }

      console.log(`   📊 Created virtual position for token ${tokenId.substring(0, 8)}... with ${walletIds.length} wallets`);
      return position;
    } catch (error: any) {
      console.error('Error in createPositionFromConsensus:', error.message);
      return null;
    }
  }

  /**
   * Vytvoří záznam o wallet aktivitě v pozici
   */
  private async createWalletActivity(
    positionId: string,
    walletId: string,
    entryPriceUsd: number,
    entryTradeId?: string,
    entryAmountUsd?: number
  ): Promise<void> {
    try {
      await supabase
        .from('PositionWalletActivity')
        .upsert({
          positionId,
          walletId,
          entryPriceUsd,
          entryTradeId,
          entryAmountUsd,
          entryTime: new Date().toISOString(),
          status: 'holding',
          holdingPercent: 100,
        }, {
          onConflict: 'positionId,walletId',
        });
    } catch (error: any) {
      console.warn(`Error creating wallet activity: ${error.message}`);
    }
  }

  // ============================================
  // Position Monitoring
  // ============================================

  /**
   * Aktualizuje všechny otevřené pozice
   */
  async updateAllOpenPositions(): Promise<void> {
    const positions = await this.getOpenPositions();
    
    console.log(`📊 Updating ${positions.length} open positions...`);
    
    for (const position of positions) {
      try {
        await this.updatePosition(position);
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error: any) {
        console.warn(`Error updating position ${position.id.substring(0, 8)}...: ${error.message}`);
      }
    }
  }

  /**
   * Aktualizuje jednu pozici - cena, P&L, kontroluje exit podmínky
   */
  async updatePosition(position: VirtualPosition): Promise<{
    exitSignal?: ExitSignal;
    updated: boolean;
  }> {
    // Get token mint address
    const { data: token } = await supabase
      .from(TABLES.TOKEN)
      .select('mintAddress, symbol')
      .eq('id', position.tokenId)
      .single();

    if (!token?.mintAddress) {
      return { updated: false };
    }

    // Fetch current price
    let currentPrice: number | undefined;
    let marketData: any = null;
    
    try {
      marketData = await this.tokenMarketData.getMarketData(token.mintAddress);
      currentPrice = marketData?.price;
    } catch (e) {
      // Use last known price
      currentPrice = position.currentPriceUsd || position.entryPriceUsd;
    }

    if (!currentPrice) {
      return { updated: false };
    }

    // Calculate P&L
    const entryPrice = Number(position.entryPriceUsd);
    const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    const pnlUsd = (currentPrice - entryPrice) * (Number(position.entryMarketCapUsd) || 0) / entryPrice;

    // Update ATH/ATL
    const highestPrice = Math.max(currentPrice, Number(position.highestPriceUsd) || currentPrice);
    const lowestPrice = Math.min(currentPrice, Number(position.lowestPriceUsd) || currentPrice);
    const maxDrawdown = highestPrice > 0 ? ((highestPrice - currentPrice) / highestPrice) * 100 : 0;

    // Calculate hold time
    const holdTimeMinutes = (Date.now() - new Date(position.entryTime).getTime()) / (1000 * 60);

    // Update position in DB
    await supabase
      .from('VirtualPosition')
      .update({
        currentPriceUsd: currentPrice,
        currentMarketCapUsd: marketData?.marketCap,
        lastPriceUpdate: new Date().toISOString(),
        unrealizedPnlPercent: pnlPercent,
        unrealizedPnlUsd: pnlUsd,
        highestPriceUsd: highestPrice,
        lowestPriceUsd: lowestPrice,
        maxDrawdownPercent: maxDrawdown,
      })
      .eq('id', position.id);

    // Check for exit conditions
    const exitSignal = await this.checkExitConditions(position, {
      currentPrice,
      pnlPercent,
      maxDrawdown,
      holdTimeMinutes,
      token,
    });

    return { exitSignal, updated: true };
  }

  /**
   * Kontroluje podmínky pro exit
   */
  private async checkExitConditions(
    position: VirtualPosition,
    context: {
      currentPrice: number;
      pnlPercent: number;
      maxDrawdown: number;
      holdTimeMinutes: number;
      token: { mintAddress: string; symbol: string };
    }
  ): Promise<ExitSignal | undefined> {
    const { currentPrice, pnlPercent, maxDrawdown, holdTimeMinutes, token } = context;
    
    // 1. Check Stop Loss
    if (position.suggestedStopLoss && currentPrice <= Number(position.suggestedStopLoss)) {
      return this.createExitSignal(position, {
        type: 'stop_loss',
        strength: 'strong',
        recommendation: 'full_exit',
        priceAtSignal: currentPrice,
        pnlPercentAtSignal: pnlPercent,
        triggerReason: `Price hit stop loss at $${currentPrice.toFixed(8)}`,
        token,
      });
    }

    // 2. Check Take Profit
    if (position.suggestedTakeProfit && currentPrice >= Number(position.suggestedTakeProfit)) {
      return this.createExitSignal(position, {
        type: 'take_profit',
        strength: 'strong',
        recommendation: 'partial_exit', // Take 50%, let rest ride
        priceAtSignal: currentPrice,
        pnlPercentAtSignal: pnlPercent,
        triggerReason: `Price hit take profit at $${currentPrice.toFixed(8)} (+${pnlPercent.toFixed(1)}%)`,
        token,
      });
    }

    // 3. Check Trailing Stop (if profit > 30%, activate trailing stop)
    if (pnlPercent > 30 && position.trailingStopPercent) {
      const trailingStopPrice = Number(position.highestPriceUsd) * (1 - Number(position.trailingStopPercent) / 100);
      if (currentPrice <= trailingStopPrice) {
        return this.createExitSignal(position, {
          type: 'trailing_stop',
          strength: 'strong',
          recommendation: 'full_exit',
          priceAtSignal: currentPrice,
          pnlPercentAtSignal: pnlPercent,
          triggerReason: `Trailing stop triggered. ATH: $${Number(position.highestPriceUsd).toFixed(8)}, Current: $${currentPrice.toFixed(8)}`,
          token,
        });
      }
    }

    // 4. Check if too many wallets exited (>50%)
    const exitedPercent = position.exitedWalletCount / (position.activeWalletCount + position.exitedWalletCount) * 100;
    if (exitedPercent >= 50 && position.exitedWalletCount >= 2) {
      return this.createExitSignal(position, {
        type: 'wallet_exit',
        strength: 'strong',
        recommendation: 'full_exit',
        priceAtSignal: currentPrice,
        pnlPercentAtSignal: pnlPercent,
        walletsExitedCount: position.exitedWalletCount,
        walletsHoldingCount: position.activeWalletCount,
        triggerReason: `${position.exitedWalletCount}/${position.exitedWalletCount + position.activeWalletCount} wallets exited (${exitedPercent.toFixed(0)}%)`,
        token,
      });
    }

    // 5. Time-based check (position open > 24h with profit > 20%)
    if (holdTimeMinutes > 24 * 60 && pnlPercent > 20) {
      // Only notify once per day
      const lastNotif = position.lastNotificationSent ? new Date(position.lastNotificationSent) : null;
      const hoursSinceNotif = lastNotif ? (Date.now() - lastNotif.getTime()) / (1000 * 60 * 60) : 999;
      
      if (hoursSinceNotif > 12) {
        return this.createExitSignal(position, {
          type: 'time_based',
          strength: 'medium',
          recommendation: 'partial_exit',
          priceAtSignal: currentPrice,
          pnlPercentAtSignal: pnlPercent,
          triggerReason: `Position open ${(holdTimeMinutes / 60).toFixed(1)}h with +${pnlPercent.toFixed(1)}% profit. Consider taking some profit.`,
          token,
        });
      }
    }

    // 6. AI recommendation check (every 30 min for positions with significant P&L change)
    const shouldAiEvaluate = 
      !position.lastAiEvaluation || 
      (Date.now() - new Date(position.lastAiEvaluation).getTime() > 30 * 60 * 1000);

    if (shouldAiEvaluate && (Math.abs(pnlPercent) > 15 || position.exitedWalletCount > 0)) {
      const aiRecommendation = await this.getAiExitRecommendation(position, context);
      
      if (aiRecommendation && aiRecommendation.decision !== 'hold' && aiRecommendation.confidence >= 70) {
        return this.createExitSignal(position, {
          type: 'ai_recommendation',
          strength: aiRecommendation.confidence >= 80 ? 'strong' : 'medium',
          recommendation: aiRecommendation.decision as any,
          priceAtSignal: currentPrice,
          pnlPercentAtSignal: pnlPercent,
          triggerReason: aiRecommendation.reasoning,
          aiDecision: aiRecommendation.decision,
          aiConfidence: aiRecommendation.confidence,
          aiReasoning: aiRecommendation.reasoning,
          token,
        });
      }
    }

    return undefined;
  }

  /**
   * Vytvoří exit signál a pošle notifikaci
   */
  private async createExitSignal(
    position: VirtualPosition,
    data: {
      type: ExitSignal['type'];
      strength: ExitSignal['strength'];
      recommendation: ExitSignal['recommendation'];
      priceAtSignal: number;
      pnlPercentAtSignal: number;
      triggerReason: string;
      walletsExitedCount?: number;
      walletsHoldingCount?: number;
      triggerWalletId?: string;
      triggerTradeId?: string;
      aiDecision?: string;
      aiConfidence?: number;
      aiReasoning?: string;
      token: { mintAddress: string; symbol: string };
    }
  ): Promise<ExitSignal> {
    // Create exit signal in DB
    const { data: signal, error } = await supabase
      .from('ExitSignal')
      .insert({
        positionId: position.id,
        tokenId: position.tokenId,
        type: data.type,
        strength: data.strength,
        recommendation: data.recommendation,
        priceAtSignal: data.priceAtSignal,
        pnlPercentAtSignal: data.pnlPercentAtSignal,
        walletsExitedCount: data.walletsExitedCount ?? position.exitedWalletCount,
        walletsHoldingCount: data.walletsHoldingCount ?? position.activeWalletCount,
        triggerWalletId: data.triggerWalletId,
        triggerTradeId: data.triggerTradeId,
        triggerReason: data.triggerReason,
        aiDecision: data.aiDecision,
        aiConfidence: data.aiConfidence,
        aiReasoning: data.aiReasoning,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating exit signal:', error);
    }

    // Send Discord notification
    await this.sendExitNotification(position, data);

    // Update position notification tracking
    await supabase
      .from('VirtualPosition')
      .update({
        lastNotificationSent: new Date().toISOString(),
        notificationCount: (position.notificationCount || 0) + 1,
        lastAiDecision: data.aiDecision || data.recommendation,
        lastAiConfidence: data.aiConfidence,
        lastAiReasoning: data.aiReasoning || data.triggerReason,
        lastAiEvaluation: new Date().toISOString(),
      })
      .eq('id', position.id);

    // Mark signal as notified
    if (signal) {
      await supabase
        .from('ExitSignal')
        .update({
          notificationSent: true,
          notificationSentAt: new Date().toISOString(),
        })
        .eq('id', signal.id);
    }

    console.log(`   🚨 Exit signal created: ${data.type} - ${data.recommendation} for ${data.token.symbol}`);

    return signal;
  }

  // ============================================
  // Smart Wallet Exit Detection
  // ============================================

  /**
   * Detekuje když smart wallet prodá token z aktivní pozice
   */
  async detectWalletExit(
    tradeId: string,
    walletId: string,
    tokenId: string,
    sellAmountUsd: number,
    sellPriceUsd: number
  ): Promise<ExitSignal | undefined> {
    // Find open position for this token
    const { data: position } = await supabase
      .from('VirtualPosition')
      .select('*, token:tokenId(symbol, mintAddress)')
      .eq('tokenId', tokenId)
      .eq('status', 'open')
      .single();

    if (!position) {
      return undefined;
    }

    // Check if this wallet was part of the position
    const { data: walletActivity } = await supabase
      .from('PositionWalletActivity')
      .select('*, wallet:walletId(address, label, score)')
      .eq('positionId', position.id)
      .eq('walletId', walletId)
      .single();

    if (!walletActivity || walletActivity.status === 'full_exit') {
      return undefined;
    }

    // Update wallet activity to exited
    await supabase
      .from('PositionWalletActivity')
      .update({
        status: 'full_exit',
        exitTradeId: tradeId,
        exitPriceUsd: sellPriceUsd,
        exitAmountUsd: sellAmountUsd,
        exitTime: new Date().toISOString(),
        holdingPercent: 0,
        realizedPnlPercent: walletActivity.entryPriceUsd 
          ? ((sellPriceUsd - Number(walletActivity.entryPriceUsd)) / Number(walletActivity.entryPriceUsd)) * 100
          : null,
      })
      .eq('id', walletActivity.id);

    // Update position wallet counts
    const newExitedCount = position.exitedWalletCount + 1;
    const newActiveCount = position.activeWalletCount - 1;

    await supabase
      .from('VirtualPosition')
      .update({
        exitedWalletCount: newExitedCount,
        activeWalletCount: newActiveCount,
      })
      .eq('id', position.id);

    // Calculate P&L
    const entryPrice = Number(position.entryPriceUsd);
    const pnlPercent = ((sellPriceUsd - entryPrice) / entryPrice) * 100;

    // Determine signal strength based on wallet importance and exit count
    const walletScore = walletActivity.wallet?.score || 50;
    const exitPercent = newExitedCount / (newExitedCount + newActiveCount) * 100;
    
    let strength: ExitSignal['strength'] = 'weak';
    let recommendation: ExitSignal['recommendation'] = 'hold';

    if (exitPercent >= 50 || walletScore >= 80) {
      strength = 'strong';
      recommendation = 'full_exit';
    } else if (exitPercent >= 30 || walletScore >= 60) {
      strength = 'medium';
      recommendation = 'partial_exit';
    }

    const walletLabel = walletActivity.wallet?.label || walletActivity.wallet?.address?.substring(0, 8) + '...';
    
    // Create exit signal
    const exitSignal = await this.createExitSignal(position, {
      type: 'wallet_exit',
      strength,
      recommendation,
      priceAtSignal: sellPriceUsd,
      pnlPercentAtSignal: pnlPercent,
      walletsExitedCount: newExitedCount,
      walletsHoldingCount: newActiveCount,
      triggerWalletId: walletId,
      triggerTradeId: tradeId,
      triggerReason: `${walletLabel} (score: ${walletScore}) sold their position at $${sellPriceUsd.toFixed(8)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`,
      token: position.token || { symbol: 'Unknown', mintAddress: '' },
    });

    // Check if all wallets exited - close position
    if (newActiveCount === 0) {
      await this.closePosition(position.id, 'wallet_exit', sellPriceUsd);
    }

    return exitSignal;
  }

  // ============================================
  // AI Exit Recommendation
  // ============================================

  /**
   * Získá AI doporučení pro exit - rule-based pro rychlost
   * V budoucnu lze nahradit LLM voláním
   */
  private async getAiExitRecommendation(
    position: VirtualPosition,
    context: {
      currentPrice: number;
      pnlPercent: number;
      maxDrawdown: number;
      holdTimeMinutes: number;
      token: { mintAddress: string; symbol: string };
    }
  ): Promise<{ decision: string; confidence: number; reasoning: string } | null> {
    try {
      // Rule-based exit evaluation (fast, no LLM call needed)
      const { pnlPercent, maxDrawdown, holdTimeMinutes } = context;
      const exitedPercent = position.exitedWalletCount / (position.activeWalletCount + position.exitedWalletCount) * 100;

      let decision = 'hold';
      let confidence = 50;
      let reasoning = '';

      // High profit + long hold = take profit
      if (pnlPercent > 50 && holdTimeMinutes > 60) {
        decision = 'partial_exit';
        confidence = 75;
        reasoning = `Strong profit (+${pnlPercent.toFixed(1)}%) held for ${(holdTimeMinutes / 60).toFixed(1)}h. Consider taking partial profit.`;
      }
      // Very high profit = definitely take profit
      else if (pnlPercent > 100) {
        decision = 'partial_exit';
        confidence = 85;
        reasoning = `Exceptional profit (+${pnlPercent.toFixed(1)}%). Strongly recommend taking at least 50% profit.`;
      }
      // Major drawdown from ATH
      else if (maxDrawdown > 30 && pnlPercent > 0) {
        decision = 'partial_exit';
        confidence = 70;
        reasoning = `Significant drawdown from ATH (-${maxDrawdown.toFixed(1)}%). Consider securing remaining profit.`;
      }
      // Many wallets exited
      else if (exitedPercent > 50) {
        decision = 'full_exit';
        confidence = 80;
        reasoning = `${position.exitedWalletCount}/${position.exitedWalletCount + position.activeWalletCount} smart wallets exited. Strong sell signal.`;
      }
      // Loss getting worse
      else if (pnlPercent < -30) {
        decision = 'full_exit';
        confidence = 70;
        reasoning = `Position down ${pnlPercent.toFixed(1)}%. Cut losses.`;
      }
      // Moderate profit, some wallets exiting
      else if (pnlPercent > 20 && exitedPercent > 30) {
        decision = 'partial_exit';
        confidence = 65;
        reasoning = `Decent profit (+${pnlPercent.toFixed(1)}%) but ${exitedPercent.toFixed(0)}% of wallets exited. Consider partial exit.`;
      }
      // Default: hold
      else {
        decision = 'hold';
        confidence = 60;
        reasoning = `Position at ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%. No strong exit signals. Continue holding.`;
      }

      return { decision, confidence, reasoning };
    } catch (error: any) {
      console.warn(`AI exit evaluation failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Vytvoří prompt pro AI exit evaluaci
   */
  private buildExitPrompt(
    position: VirtualPosition,
    context: {
      currentPrice: number;
      pnlPercent: number;
      maxDrawdown: number;
      holdTimeMinutes: number;
      token: { mintAddress: string; symbol: string };
    }
  ): string {
    return `
POSITION EXIT EVALUATION for ${context.token.symbol}

Current Position Status:
- Entry Price: $${Number(position.entryPriceUsd).toFixed(8)}
- Current Price: $${context.currentPrice.toFixed(8)}
- P&L: ${context.pnlPercent >= 0 ? '+' : ''}${context.pnlPercent.toFixed(2)}%
- Hold Time: ${(context.holdTimeMinutes / 60).toFixed(1)} hours
- Max Drawdown from ATH: ${context.maxDrawdown.toFixed(1)}%

Wallet Activity:
- Original Wallets: ${position.entryWalletCount}
- Still Holding: ${position.activeWalletCount}
- Exited: ${position.exitedWalletCount}

Should I:
1. HOLD - Keep the position
2. PARTIAL_EXIT - Take some profit (50%)
3. FULL_EXIT - Close entire position

Consider:
- Smart wallet behavior (are they exiting?)
- Current profit level
- Risk of drawdown
- Time in position

Respond with your recommendation and reasoning.
    `;
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
  ): Promise<void> {
    const { data: position } = await supabase
      .from('VirtualPosition')
      .select('*')
      .eq('id', positionId)
      .single();

    if (!position) return;

    const entryPrice = Number(position.entryPriceUsd);
    const realizedPnlPercent = ((exitPriceUsd - entryPrice) / entryPrice) * 100;

    await supabase
      .from('VirtualPosition')
      .update({
        status: 'closed',
        exitReason,
        exitPriceUsd,
        exitTime: new Date().toISOString(),
        realizedPnlPercent,
      })
      .eq('id', positionId);

    console.log(`   ✅ Position ${positionId.substring(0, 8)}... closed. P&L: ${realizedPnlPercent >= 0 ? '+' : ''}${realizedPnlPercent.toFixed(2)}%`);
  }

  /**
   * Získá všechny otevřené pozice
   */
  async getOpenPositions(): Promise<VirtualPosition[]> {
    const { data, error } = await supabase
      .from('VirtualPosition')
      .select('*, token:tokenId(symbol, mintAddress)')
      .eq('status', 'open')
      .order('entryTime', { ascending: false });

    if (error) {
      console.error('Error fetching open positions:', error);
      return [];
    }

    return data || [];
  }

  /**
   * Získá pozici s detaily
   */
  async getPositionWithDetails(positionId: string): Promise<{
    position: VirtualPosition;
    walletActivities: PositionWalletActivity[];
    exitSignals: ExitSignal[];
  } | null> {
    const { data: position } = await supabase
      .from('VirtualPosition')
      .select('*, token:tokenId(symbol, mintAddress)')
      .eq('id', positionId)
      .single();

    if (!position) return null;

    const { data: walletActivities } = await supabase
      .from('PositionWalletActivity')
      .select('*, wallet:walletId(address, label, score)')
      .eq('positionId', positionId);

    const { data: exitSignals } = await supabase
      .from('ExitSignal')
      .select('*')
      .eq('positionId', positionId)
      .order('createdAt', { ascending: false });

    return {
      position,
      walletActivities: walletActivities || [],
      exitSignals: exitSignals || [],
    };
  }

  // ============================================
  // Discord Notifications
  // ============================================

  /**
   * Pošle Discord notifikaci o exit signálu
   */
  private async sendExitNotification(
    position: VirtualPosition,
    data: {
      type: ExitSignal['type'];
      strength: ExitSignal['strength'];
      recommendation: ExitSignal['recommendation'];
      priceAtSignal: number;
      pnlPercentAtSignal: number;
      triggerReason: string;
      walletsExitedCount?: number;
      walletsHoldingCount?: number;
      aiReasoning?: string;
      token: { mintAddress: string; symbol: string };
    }
  ): Promise<void> {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    const typeEmoji: Record<string, string> = {
      'wallet_exit': '👛',
      'stop_loss': '🛑',
      'take_profit': '🎯',
      'trailing_stop': '📉',
      'ai_recommendation': '🤖',
      'time_based': '⏰',
    };

    const strengthColor: Record<string, number> = {
      'weak': 0xffff00,    // Yellow
      'medium': 0xffa500,  // Orange
      'strong': 0xff0000,  // Red
    };

    const recommendationEmoji: Record<string, string> = {
      'hold': '✋',
      'partial_exit': '⚖️',
      'full_exit': '🚪',
    };

    const pnlColor = data.pnlPercentAtSignal >= 0 ? 0x00ff00 : 0xff0000;
    const pnlSign = data.pnlPercentAtSignal >= 0 ? '+' : '';

    const fields = [
      {
        name: '📊 Position Status',
        value: `Entry: $${Number(position.entryPriceUsd).toFixed(8)}\nCurrent: $${data.priceAtSignal.toFixed(8)}\nP&L: ${pnlSign}${data.pnlPercentAtSignal.toFixed(2)}%`,
        inline: true,
      },
      {
        name: `${typeEmoji[data.type] || '❓'} Signal Type`,
        value: `**${data.type.toUpperCase().replace('_', ' ')}**\nStrength: ${data.strength.toUpperCase()}`,
        inline: true,
      },
      {
        name: `${recommendationEmoji[data.recommendation] || '❓'} Recommendation`,
        value: `**${data.recommendation.toUpperCase().replace('_', ' ')}**`,
        inline: true,
      },
    ];

    if (data.walletsExitedCount !== undefined) {
      fields.push({
        name: '👛 Wallet Status',
        value: `Exited: ${data.walletsExitedCount}\nHolding: ${data.walletsHoldingCount}`,
        inline: true,
      });
    }

    fields.push({
      name: '💡 Reason',
      value: data.triggerReason.substring(0, 200),
      inline: false,
    });

    if (data.aiReasoning) {
      fields.push({
        name: '🤖 AI Analysis',
        value: data.aiReasoning.substring(0, 300),
        inline: false,
      });
    }

    const payload = {
      username: 'Tradooor Exit Monitor',
      embeds: [
        {
          title: `🚨 EXIT SIGNAL: ${data.token.symbol}`,
          url: `https://birdeye.so/token/${data.token.mintAddress}?chain=solana`,
          color: strengthColor[data.strength] || 0xffa500,
          fields,
          timestamp: new Date().toISOString(),
          footer: {
            text: `Position opened ${this.formatHoldTime(position.entryTime)}`,
          },
        },
      ],
    };

    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error: any) {
      console.warn(`Failed to send Discord exit notification: ${error.message}`);
    }
  }

  /**
   * Formátuje hold time
   */
  private formatHoldTime(entryTime: Date | string): string {
    const minutes = (Date.now() - new Date(entryTime).getTime()) / (1000 * 60);
    if (minutes < 60) return `${Math.round(minutes)}m ago`;
    if (minutes < 24 * 60) return `${(minutes / 60).toFixed(1)}h ago`;
    return `${(minutes / (24 * 60)).toFixed(1)}d ago`;
  }
}

