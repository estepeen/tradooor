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

import { prisma } from '../lib/prisma.js';
import { TokenMarketDataService } from './token-market-data.service.js';
import { AIDecisionService } from './ai-decision.service.js';
import { DiscordNotificationService } from './discord-notification.service.js';
import { RugCheckService } from './rugcheck.service.js';

// NOTE: VirtualPosition, PositionWalletActivity, and ExitSignal tables don't exist in Prisma schema yet
// All methods in this service will gracefully fail with console warnings until these models are added

// ============================================
// Helpers
// ============================================

function formatNumber(value: number, decimals: number = 2): string {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(decimals);
}

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
    // NOTE: VirtualPosition table doesn't exist in Prisma schema yet
    return null;
  }

  /**
   * Vytvoří záznam o wallet aktivitě v pozici (stubbed - table doesn't exist)
   */
  private async createWalletActivity(
    positionId: string,
    walletId: string,
    entryPriceUsd: number,
    entryTradeId?: string,
    entryAmountUsd?: number
  ): Promise<void> {
    return;
  }

  // ============================================
  // Position Monitoring
  // ============================================

  /**
   * Aktualizuje všechny otevřené pozice
   */
  async updateAllOpenPositions(): Promise<void> {
    // NOTE: Position monitoring not available (VirtualPosition table not in Prisma schema)
    return;
  }

  /**
   * Určí interval pro aktualizaci pozice na základě market capu
   */
  private getUpdateInterval(marketCapUsd: number): number {
    if (marketCapUsd < 300000) return 1 * 60 * 1000;      // < 300k: 1 min
    if (marketCapUsd < 500000) return 2 * 60 * 1000;      // 300k-500k: 2 min
    if (marketCapUsd < 1000000) return 2 * 60 * 1000;     // 500k-1M: 2 min
    return 5 * 60 * 1000;                                  // > 1M: 5 min
  }

  /**
   * Aktualizuje jednu pozici - cena, P&L, kontroluje exit podmínky
   */
  async updatePosition(position: VirtualPosition): Promise<{
    exitSignal?: ExitSignal;
    updated: boolean;
  }> {
    // NOTE: Position monitoring not available (VirtualPosition table not in Prisma schema)
    return { updated: false };
  }

  /**
   * Kontroluje podmínky pro exit (stubbed - table doesn't exist)
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
    return undefined;
  }

  /**
   * Vytvoří exit signál (stubbed - table doesn't exist)
   */
  private async createExitSignal(
    position: VirtualPosition,
    data: any
  ): Promise<ExitSignal> {
    // NOTE: Exit signal creation not available
    return {} as ExitSignal;
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
    // NOTE: Exit detection not available (VirtualPosition table not in Prisma schema)
    return undefined;
  }

  // ============================================
  // AI Exit Recommendation
  // ============================================

  /**
   * Získá AI doporučení pro exit - rule-based pro rychlost
   */
  private async getAiExitRecommendation(
    position: VirtualPosition,
    context: any
  ): Promise<{ decision: string; confidence: number; reasoning: string } | null> {
    return null;
  }

  /**
   * Vytvoří prompt pro AI exit evaluaci
   */
  private buildExitPrompt(position: VirtualPosition, context: any): string {
    return '';
  }

  // ============================================
  // Position Management
  // ============================================

  /**
   * Zavře pozici (stubbed - table doesn't exist)
   */
  async closePosition(
    positionId: string,
    exitReason: string,
    exitPriceUsd: number
  ): Promise<void> {
    // NOTE: Position monitoring not available
    return;
  }

  /**
   * Získá všechny otevřené pozice
   */
  async getOpenPositions(): Promise<VirtualPosition[]> {
    // NOTE: Position monitoring not available (VirtualPosition table not in Prisma schema)
    return [];
  }

  /**
   * Získá pozici s detaily (stubbed - table doesn't exist)
   */
  async getPositionWithDetails(positionId: string): Promise<{
    position: VirtualPosition;
    walletActivities: PositionWalletActivity[];
    exitSignals: ExitSignal[];
  } | null> {
    // NOTE: Position monitoring not available
    return null;
  }

  // ============================================
  // Discord Notifications
  // ============================================

  /**
   * Pošle Discord notifikaci o exit signálu
   */
  private async sendExitNotification(position: VirtualPosition, data: any): Promise<void> {
    // Stubbed for now
    return;
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
