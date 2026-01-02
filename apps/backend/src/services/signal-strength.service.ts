/**
 * Signal Strength Service
 *
 * Calculates signal strength based on:
 * 1. Wallet tier composition (T1/T2/T3)
 * 2. Accumulation patterns
 * 3. Conviction buy patterns
 * 4. Momentum indicators
 *
 * Final classification: WEAK / MEDIUM / STRONG
 */

import { prisma } from '../lib/prisma.js';

// ============================================================================
// SIGNAL STRENGTH SCORING CONSTANTS
// ============================================================================

// Wallet Tier Points (max 50 points from wallets)
const WALLET_TIER_POINTS = {
  T1: 15,           // Best tier = 15 points
  T2: 10,           // Good tier = 10 points
  T3: 5,            // Decent tier = 5 points
  UNCLASSIFIED: 3,  // Unknown tier = 3 points
};

// Pattern Bonus Points (max 30 points from patterns)
const PATTERN_BONUS_POINTS = {
  ACCUMULATION: 15,    // Wallet is accumulating this token
  CONVICTION_BUY: 15,  // Wallet made conviction buy
};

// Momentum Bonus Points (max 20 points from momentum)
const MOMENTUM_BONUS_POINTS = {
  VERY_STRONG: 20,  // B/S ratio > 3.0
  STANDARD: 10,     // B/S ratio 1.5-3.0
  WEAK: 0,          // B/S ratio < 1.5
};

// Classification Thresholds
const STRENGTH_THRESHOLDS = {
  STRONG: 60,   // 60+ points = STRONG
  MEDIUM: 35,   // 35-59 points = MEDIUM
  // Below 35 = WEAK
};

// Accumulation Detection Thresholds (simplified for NINJA context)
const ACCUMULATION_THRESHOLDS = {
  TIME_WINDOW_HOURS: 6,     // Look back 6 hours
  MIN_BUYS: 2,              // At least 2 buys
  MIN_SOL_PER_BUY: 0.3,     // Min 0.3 SOL per buy
  MIN_TOTAL_SOL: 1.0,       // Min 1 SOL total
};

// Conviction Buy Detection Thresholds
const CONVICTION_THRESHOLDS = {
  MULTIPLIER: 2.0,          // At least 2x average trade size
  LOOKBACK_TRADES: 10,      // Compare to last 10 trades
};

export interface WalletPatternInfo {
  walletId: string;
  walletLabel: string | null;
  tier: number | null;  // 1, 2, 3 or null
  score: number;
  hasAccumulation: boolean;
  hasConvictionBuy: boolean;
  tradeAmountSol: number;
}

export interface SignalStrengthResult {
  strength: 'weak' | 'medium' | 'strong';
  totalPoints: number;
  breakdown: {
    walletTierPoints: number;
    patternBonusPoints: number;
    momentumBonusPoints: number;
  };
  walletDetails: WalletPatternInfo[];
  reasoning: string;
}

export class SignalStrengthService {
  /**
   * Calculate signal strength for a NINJA consensus signal
   *
   * @param tokenId - Token ID in database
   * @param walletIds - List of wallet IDs that participated in consensus
   * @param buySellVolumeRatio - Current buy/sell volume ratio (5min)
   * @param tradesBySolAmount - Map of walletId -> trade amount in SOL
   */
  async calculateStrength(
    tokenId: string,
    walletIds: string[],
    buySellVolumeRatio: number,
    tradesBySolAmount: Map<string, number>
  ): Promise<SignalStrengthResult> {
    // 1. Load wallet info with tiers
    const wallets = await prisma.smartWallet.findMany({
      where: { id: { in: walletIds } },
      select: {
        id: true,
        label: true,
        tier: true,
        score: true,
      },
    });

    // 2. Detect patterns for each wallet
    const walletDetails: WalletPatternInfo[] = await Promise.all(
      wallets.map(async (wallet) => {
        const [hasAccumulation, hasConvictionBuy] = await Promise.all([
          this.detectAccumulationForWallet(wallet.id, tokenId),
          this.detectConvictionBuyForWallet(wallet.id, tokenId, tradesBySolAmount.get(wallet.id) || 0),
        ]);

        return {
          walletId: wallet.id,
          walletLabel: wallet.label,
          tier: wallet.tier,
          score: wallet.score,
          hasAccumulation,
          hasConvictionBuy,
          tradeAmountSol: tradesBySolAmount.get(wallet.id) || 0,
        };
      })
    );

    // 3. Calculate wallet tier points
    let walletTierPoints = 0;
    for (const w of walletDetails) {
      if (w.tier === 1) {
        walletTierPoints += WALLET_TIER_POINTS.T1;
      } else if (w.tier === 2) {
        walletTierPoints += WALLET_TIER_POINTS.T2;
      } else if (w.tier === 3) {
        walletTierPoints += WALLET_TIER_POINTS.T3;
      } else {
        walletTierPoints += WALLET_TIER_POINTS.UNCLASSIFIED;
      }
    }

    // 4. Calculate pattern bonus points
    let patternBonusPoints = 0;
    const patternsDetected: string[] = [];

    for (const w of walletDetails) {
      if (w.hasAccumulation) {
        patternBonusPoints += PATTERN_BONUS_POINTS.ACCUMULATION;
        patternsDetected.push(`${w.walletLabel || 'Wallet'}:ACC`);
      }
      if (w.hasConvictionBuy) {
        patternBonusPoints += PATTERN_BONUS_POINTS.CONVICTION_BUY;
        patternsDetected.push(`${w.walletLabel || 'Wallet'}:CONV`);
      }
    }

    // 5. Calculate momentum bonus points
    let momentumBonusPoints = 0;
    let momentumLabel = '';

    if (buySellVolumeRatio >= 3.0) {
      momentumBonusPoints = MOMENTUM_BONUS_POINTS.VERY_STRONG;
      momentumLabel = 'very_strong';
    } else if (buySellVolumeRatio >= 1.5) {
      momentumBonusPoints = MOMENTUM_BONUS_POINTS.STANDARD;
      momentumLabel = 'standard';
    } else {
      momentumBonusPoints = MOMENTUM_BONUS_POINTS.WEAK;
      momentumLabel = 'weak';
    }

    // 6. Calculate total and determine strength
    const totalPoints = walletTierPoints + patternBonusPoints + momentumBonusPoints;

    // Check for auto-STRONG conditions:
    // - Has T1 wallet AND any pattern detected
    const hasT1Wallet = walletDetails.some(w => w.tier === 1);
    const hasAnyPattern = walletDetails.some(w => w.hasAccumulation || w.hasConvictionBuy);
    const autoStrong = hasT1Wallet && hasAnyPattern;

    let strength: 'weak' | 'medium' | 'strong';
    if (autoStrong || totalPoints >= STRENGTH_THRESHOLDS.STRONG) {
      strength = 'strong';
    } else if (totalPoints >= STRENGTH_THRESHOLDS.MEDIUM) {
      strength = 'medium';
    } else {
      strength = 'weak';
    }

    // 7. Build reasoning string
    const tierBreakdown = walletDetails.map(w => {
      const tierStr = w.tier ? `T${w.tier}` : '?';
      return `${w.walletLabel || 'W'}(${tierStr})`;
    }).join(', ');

    let reasoning = `Signal Strength: ${strength.toUpperCase()} (${totalPoints} pts)`;
    reasoning += ` | Wallets: [${tierBreakdown}] = ${walletTierPoints}pts`;

    if (patternsDetected.length > 0) {
      reasoning += ` | Patterns: [${patternsDetected.join(', ')}] = ${patternBonusPoints}pts`;
    }

    reasoning += ` | Momentum: ${momentumLabel} (B/S ${buySellVolumeRatio.toFixed(1)}x) = ${momentumBonusPoints}pts`;

    if (autoStrong) {
      reasoning += ' | 🔥 AUTO-STRONG: T1 + Pattern';
    }

    return {
      strength,
      totalPoints,
      breakdown: {
        walletTierPoints,
        patternBonusPoints,
        momentumBonusPoints,
      },
      walletDetails,
      reasoning,
    };
  }

  /**
   * Detect if wallet has been accumulating this token
   * Simplified version - checks for multiple buys in time window
   */
  private async detectAccumulationForWallet(walletId: string, tokenId: string): Promise<boolean> {
    const cutoffTime = new Date(Date.now() - ACCUMULATION_THRESHOLDS.TIME_WINDOW_HOURS * 60 * 60 * 1000);

    const recentBuys = await prisma.trade.findMany({
      where: {
        walletId,
        tokenId,
        side: 'buy',
        timestamp: { gte: cutoffTime },
      },
      select: {
        amountBase: true,
        meta: true,
      },
    });

    if (recentBuys.length < ACCUMULATION_THRESHOLDS.MIN_BUYS) {
      return false;
    }

    // Check minimum size per buy and total
    let validBuyCount = 0;
    let totalSol = 0;

    for (const buy of recentBuys) {
      const amountBase = Number(buy.amountBase) || 0;
      const meta = buy.meta as any;
      const baseToken = (meta?.baseToken || 'SOL').toUpperCase();

      // Convert to SOL if needed (rough estimate)
      let amountSol = amountBase;
      if (baseToken === 'USDC' || baseToken === 'USDT') {
        amountSol = amountBase / 125; // Rough SOL price estimate
      }

      if (amountSol >= ACCUMULATION_THRESHOLDS.MIN_SOL_PER_BUY) {
        validBuyCount++;
        totalSol += amountSol;
      }
    }

    return validBuyCount >= ACCUMULATION_THRESHOLDS.MIN_BUYS &&
           totalSol >= ACCUMULATION_THRESHOLDS.MIN_TOTAL_SOL;
  }

  /**
   * Detect if this trade is a conviction buy (significantly larger than average)
   */
  private async detectConvictionBuyForWallet(
    walletId: string,
    tokenId: string,
    currentTradeAmountSol: number
  ): Promise<boolean> {
    if (currentTradeAmountSol <= 0) {
      return false;
    }

    // Get wallet's recent trades (any token) to calculate average
    const recentTrades = await prisma.trade.findMany({
      where: {
        walletId,
        side: 'buy',
      },
      select: {
        amountBase: true,
        meta: true,
      },
      orderBy: { timestamp: 'desc' },
      take: CONVICTION_THRESHOLDS.LOOKBACK_TRADES,
    });

    if (recentTrades.length < 3) {
      // Not enough history to determine conviction
      return false;
    }

    // Calculate average trade size in SOL
    let totalSol = 0;
    for (const trade of recentTrades) {
      const amountBase = Number(trade.amountBase) || 0;
      const meta = trade.meta as any;
      const baseToken = (meta?.baseToken || 'SOL').toUpperCase();

      let amountSol = amountBase;
      if (baseToken === 'USDC' || baseToken === 'USDT') {
        amountSol = amountBase / 125;
      }
      totalSol += amountSol;
    }

    const avgTradeSol = totalSol / recentTrades.length;

    // Check if current trade is significantly larger
    return avgTradeSol > 0 && currentTradeAmountSol >= avgTradeSol * CONVICTION_THRESHOLDS.MULTIPLIER;
  }
}

// Export singleton instance
export const signalStrengthService = new SignalStrengthService();
