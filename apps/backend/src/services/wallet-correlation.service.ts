/**
 * Wallet Correlation Service
 * 
 * Level 2.2: Analýza korelací mezi wallety
 * - Detekuje skupiny walletů co tradují společně
 * - Identifikuje "shill networks" vs "smart money"
 * - Weighted consensus scoring
 */

import { generateId, prisma } from '../lib/prisma.js';
import { supabase, TABLES } from '../lib/supabase.js';

// Helper to check if Supabase is available
const isSupabaseAvailable = () => supabase && typeof supabase.from === 'function';

export interface WalletCorrelation {
  walletId1: string;
  walletId2: string;
  correlationScore: number; // -1 to 1
  sharedTokensCount: number;
  sameDirectionPercent: number;
  avgTimeDifferenceMinutes: number;
  suspectedGroup?: string;
}

export interface WalletGroup {
  id: string;
  name?: string;
  groupType: 'smart_money' | 'shill_network' | 'neutral' | 'unknown';
  walletIds: string[];
  avgCorrelation: number;
  avgWalletScore: number;
  avgWinRate: number;
  totalTrades: number;
  trustMultiplier: number; // 0.5 - 1.5 for weighted consensus
}

export class WalletCorrelationService {
  private readonly MIN_SHARED_TOKENS = 3;
  private readonly HIGH_CORRELATION_THRESHOLD = 0.7;
  private readonly SHILL_DETECTION_THRESHOLD = 0.85;
  private readonly TIME_WINDOW_MINUTES = 30; // Max time diff for "same trade"

  /**
   * Analyzuj korelace pro všechny aktivní wallety
   */
  async analyzeAllCorrelations(): Promise<{ correlationsFound: number; groupsDetected: number }> {
    console.log('🔍 Analyzing wallet correlations...');
    
    try {
      // Check if Supabase is available
      if (!isSupabaseAvailable()) {
        console.warn('⚠️  Supabase not available for analyzeAllCorrelations, using Prisma');
        // Use Prisma instead
        const wallets = await prisma.smartWallet.findMany({
          take: 100,
          select: { id: true, address: true, score: true, winRate: true },
        });
        
        if (wallets.length < 2) {
          return { correlationsFound: 0, groupsDetected: 0 };
        }
        // Continue with Prisma wallets...
        console.log(`   Found ${wallets.length} active wallets (via Prisma)`);
        return { correlationsFound: 0, groupsDetected: 0 }; // TODO: Implement full Prisma version
      }
      
      // 1. Načti všechny aktivní wallety (použij Prisma)
      const wallets = await prisma.smartWallet.findMany({
        where: {
          // Note: isActive field doesn't exist in Prisma schema, so we'll get all wallets
          // You can add filtering later if needed
        },
        select: {
          id: true,
          address: true,
          score: true,
          winRate: true,
        },
        take: 100,
      });

      if (!wallets || wallets.length < 2) {
        return { correlationsFound: 0, groupsDetected: 0 };
      }

      console.log(`   Found ${wallets.length} active wallets`);

      // 2. Pro každý pár walletů spočítej korelaci
      const correlations: WalletCorrelation[] = [];
      
      for (let i = 0; i < wallets.length; i++) {
        for (let j = i + 1; j < wallets.length; j++) {
          const correlation = await this.calculateCorrelation(
            wallets[i].id,
            wallets[j].id
          );
          
          if (correlation && correlation.sharedTokensCount >= this.MIN_SHARED_TOKENS) {
            correlations.push(correlation);
          }
        }
        
        // Progress log
        if (i % 10 === 0) {
          console.log(`   Progress: ${i + 1}/${wallets.length} wallets analyzed`);
        }
      }

      // 3. Ulož korelace
      await this.saveCorrelations(correlations);

      // 4. Detekuj skupiny
      const groups = await this.detectGroups(correlations, wallets);
      
      // 5. Ulož skupiny a aktualizuj wallety
      await this.saveGroups(groups);
      
      console.log(`✅ Correlation analysis complete: ${correlations.length} correlations, ${groups.length} groups`);
      
      return {
        correlationsFound: correlations.length,
        groupsDetected: groups.length,
      };
    } catch (error: any) {
      console.error('Error analyzing correlations:', error.message);
      return { correlationsFound: 0, groupsDetected: 0 };
    }
  }

  /**
   * Spočítej korelaci mezi dvěma wallety
   */
  async calculateCorrelation(walletId1: string, walletId2: string): Promise<WalletCorrelation | null> {
    try {
      // Načti trades obou walletů za posledních 30 dní
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      
      const [trades1, trades2] = await Promise.all([
        prisma.trade.findMany({
          where: {
            walletId: walletId1,
            timestamp: { gte: since },
          },
          select: {
            tokenId: true,
            side: true,
            timestamp: true,
          },
        }),
        prisma.trade.findMany({
          where: {
            walletId: walletId2,
            timestamp: { gte: since },
          },
          select: {
            tokenId: true,
            side: true,
            timestamp: true,
          },
        }),
      ]);

      if (trades1.length === 0 || trades2.length === 0) {
        return null;
      }

      // Najdi sdílené tokeny
      const tokens1 = new Set(trades1.map(t => t.tokenId));
      const tokens2 = new Set(trades2.map(t => t.tokenId));
      const sharedTokens = [...tokens1].filter(t => tokens2.has(t));

      if (sharedTokens.length < this.MIN_SHARED_TOKENS) {
        return null;
      }

      // Analyzuj trades na sdílených tokenech
      let sameDirectionCount = 0;
      let totalComparisons = 0;
      let totalTimeDiff = 0;
      let timeDiffCount = 0;

      for (const tokenId of sharedTokens) {
        const token1Trades = trades1.filter(t => t.tokenId === tokenId);
        const token2Trades = trades2.filter(t => t.tokenId === tokenId);

        for (const t1 of token1Trades) {
          for (const t2 of token2Trades) {
            totalComparisons++;
            
            // Same direction?
            if (t1.side === t2.side) {
              sameDirectionCount++;
            }

            // Time difference
            const timeDiff = Math.abs(
              new Date(t1.timestamp).getTime() - new Date(t2.timestamp).getTime()
            );
            const timeDiffMinutes = timeDiff / (60 * 1000);
            
            if (timeDiffMinutes <= this.TIME_WINDOW_MINUTES * 2) {
              totalTimeDiff += timeDiffMinutes;
              timeDiffCount++;
            }
          }
        }
      }

      const sameDirectionPercent = totalComparisons > 0
        ? (sameDirectionCount / totalComparisons) * 100
        : 0;

      const avgTimeDiff = timeDiffCount > 0
        ? totalTimeDiff / timeDiffCount
        : 999;

      // Spočítej correlation score
      // High score = trade similar tokens, same direction, close in time
      let correlationScore = 0;
      
      // Base: shared tokens ratio
      correlationScore += Math.min(sharedTokens.length / 10, 0.3);
      
      // Same direction bonus
      correlationScore += (sameDirectionPercent / 100) * 0.4;
      
      // Time proximity bonus
      if (avgTimeDiff < 5) {
        correlationScore += 0.3;
      } else if (avgTimeDiff < 15) {
        correlationScore += 0.2;
      } else if (avgTimeDiff < 30) {
        correlationScore += 0.1;
      }

      return {
        walletId1,
        walletId2,
        correlationScore: Math.min(correlationScore, 1),
        sharedTokensCount: sharedTokens.length,
        sameDirectionPercent,
        avgTimeDifferenceMinutes: avgTimeDiff,
      };
    } catch (error: any) {
      console.warn(`Error calculating correlation: ${error.message}`);
      return null;
    }
  }

  /**
   * Detekuj skupiny walletů
   */
  private async detectGroups(
    correlations: WalletCorrelation[],
    wallets: any[]
  ): Promise<WalletGroup[]> {
    const groups: WalletGroup[] = [];
    const assignedWallets = new Set<string>();
    const walletMap = new Map(wallets.map(w => [w.id, w]));

    // Sort by correlation score descending
    const sortedCorrelations = correlations
      .filter(c => c.correlationScore >= this.HIGH_CORRELATION_THRESHOLD)
      .sort((a, b) => b.correlationScore - a.correlationScore);

    for (const corr of sortedCorrelations) {
      const { walletId1, walletId2 } = corr;
      
      // Skip if both already assigned
      if (assignedWallets.has(walletId1) && assignedWallets.has(walletId2)) {
        continue;
      }

      // Find or create group
      let group = groups.find(g => 
        g.walletIds.includes(walletId1) || g.walletIds.includes(walletId2)
      );

      if (!group) {
        group = {
          id: generateId(),
          groupType: 'unknown',
          walletIds: [],
          avgCorrelation: 0,
          avgWalletScore: 0,
          avgWinRate: 0,
          totalTrades: 0,
          trustMultiplier: 1.0,
        };
        groups.push(group);
      }

      // Add wallets to group
      if (!group.walletIds.includes(walletId1)) {
        group.walletIds.push(walletId1);
        assignedWallets.add(walletId1);
      }
      if (!group.walletIds.includes(walletId2)) {
        group.walletIds.push(walletId2);
        assignedWallets.add(walletId2);
      }
    }

    // Calculate group stats and determine type
    for (const group of groups) {
      const groupWallets = group.walletIds
        .map(id => walletMap.get(id))
        .filter(w => w);

      group.avgWalletScore = groupWallets.length > 0
        ? groupWallets.reduce((sum, w) => sum + (w.score || 0), 0) / groupWallets.length
        : 0;

      group.avgWinRate = groupWallets.length > 0
        ? groupWallets.reduce((sum, w) => sum + (w.winRate || 0), 0) / groupWallets.length
        : 0;

      // Calculate avg correlation within group
      const groupCorrelations = correlations.filter(c =>
        group.walletIds.includes(c.walletId1) && group.walletIds.includes(c.walletId2)
      );
      group.avgCorrelation = groupCorrelations.length > 0
        ? groupCorrelations.reduce((sum, c) => sum + c.correlationScore, 0) / groupCorrelations.length
        : 0;

      // Determine group type
      if (group.avgCorrelation >= this.SHILL_DETECTION_THRESHOLD && group.avgWinRate < 0.4) {
        group.groupType = 'shill_network';
        group.trustMultiplier = 0.5;
        group.name = `Shill Network #${groups.indexOf(group) + 1}`;
      } else if (group.avgWalletScore >= 70 && group.avgWinRate >= 0.5) {
        group.groupType = 'smart_money';
        group.trustMultiplier = 1.2;
        group.name = `Smart Money Group #${groups.indexOf(group) + 1}`;
      } else {
        group.groupType = 'neutral';
        group.trustMultiplier = 1.0;
        group.name = `Correlated Group #${groups.indexOf(group) + 1}`;
      }
    }

    return groups;
  }

  /**
   * Ulož korelace do DB
   */
  private async saveCorrelations(correlations: WalletCorrelation[]): Promise<void> {
    // Skip if no correlations
    if (correlations.length === 0) {
      return;
    }

    // Note: WalletCorrelation table doesn't exist in Prisma schema yet
    // For now, skip saving correlations until table is added
    console.warn(`⚠️  [WalletCorrelation] Skipping saveCorrelations - table not in Prisma schema yet`);
    return;
  }

  /**
   * Ulož skupiny a aktualizuj wallety
   */
  private async saveGroups(groups: WalletGroup[]): Promise<void> {
    // Skip if no groups
    if (groups.length === 0) {
      return;
    }

    // Note: WalletGroup table doesn't exist in Prisma schema yet
    // For now, skip saving groups until table is added
    console.warn(`⚠️  [WalletCorrelation] Skipping saveGroups - table not in Prisma schema yet`);
    return;

    // Insert new groups
    for (const group of groups) {
      await supabase
        .from('WalletGroup')
        .insert({
          id: group.id,
          name: group.name,
          groupType: group.groupType,
          walletIds: group.walletIds,
          avgCorrelation: group.avgCorrelation,
          avgWalletScore: group.avgWalletScore,
          avgWinRate: group.avgWinRate,
          totalTrades: group.totalTrades,
          metadata: { trustMultiplier: group.trustMultiplier },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

      // Update wallets in group (skip - fields don't exist in Prisma schema yet)
      // Note: correlationGroupId, isSuspectedShill, trustScore fields don't exist in Prisma schema
      // For now, skip updating wallets until schema is updated
      console.warn(`⚠️  [WalletCorrelation] Skipping wallet update - fields not in Prisma schema yet`);
    }
  }

  /**
   * Získej weighted consensus score
   * Bere v úvahu korelace - shill networks mají nižší váhu
   */
  async getWeightedConsensusScore(tokenId: string, walletIds: string[]): Promise<{
    rawCount: number;
    weightedCount: number;
    trustMultiplier: number;
    hasShillRisk: boolean;
  }> {
    try {
      // Načti wallet info s trust scores (použij Prisma)
      const wallets = await prisma.smartWallet.findMany({
        where: {
          id: { in: walletIds },
        },
        select: {
          id: true,
          score: true,
          winRate: true,
          // Note: trustScore, correlationGroupId, isSuspectedShill don't exist in Prisma schema yet
        },
      });
      
      // For now, return default values since trustScore doesn't exist
      if (!wallets || wallets.length === 0) {

      if (!wallets || wallets.length === 0) {
        return {
          rawCount: walletIds.length,
          weightedCount: walletIds.length,
          trustMultiplier: 1.0,
          hasShillRisk: false,
        };
      }

      // Calculate weighted count
      let weightedSum = 0;
      let shillCount = 0;

      for (const wallet of wallets) {
        const weight = wallet.trustScore
          ? wallet.trustScore / 100
          : (wallet.score || 50) / 100;
        
        weightedSum += weight;
        
        if (wallet.isSuspectedShill) {
          shillCount++;
        }
      }

      const hasShillRisk = shillCount >= wallets.length * 0.5;
      const trustMultiplier = hasShillRisk ? 0.7 : 1.0;

      return {
        rawCount: walletIds.length,
        weightedCount: weightedSum * trustMultiplier,
        trustMultiplier,
        hasShillRisk,
      };
    } catch (error) {
      return {
        rawCount: walletIds.length,
        weightedCount: walletIds.length,
        trustMultiplier: 1.0,
        hasShillRisk: false,
      };
    }
  }

  /**
   * Získej skupiny
   */
  async getGroups(): Promise<WalletGroup[]> {
    const { data, error } = await supabase
      .from('WalletGroup')
      .select('*')
      .order('avgWalletScore', { ascending: false });

    if (error) return [];
    return data as WalletGroup[];
  }

  /**
   * Získej korelace pro wallet
   */
  async getCorrelationsForWallet(walletId: string): Promise<WalletCorrelation[]> {
    const { data, error } = await supabase
      .from('WalletCorrelation')
      .select('*')
      .or(`walletId1.eq.${walletId},walletId2.eq.${walletId}`)
      .order('correlationScore', { ascending: false });

    if (error) return [];
    return data as WalletCorrelation[];
  }
}

