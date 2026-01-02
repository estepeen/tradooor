/**
 * Pump.fun Holder Analysis Service
 *
 * Fetches and analyzes holder data from pump.fun API:
 * - Top holder concentration check
 * - Dev/creator wallet detection
 * - Insider selling detection
 */

const PUMP_FUN_API_BASE = 'https://frontend-api.pump.fun';
const PUMP_FUN_TOTAL_SUPPLY = 1_000_000_000; // 1B tokens for pump.fun

// Cache for holder data (reduces API calls)
const holderCache = new Map<string, { data: HolderAnalysisResult; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache

export interface HolderInfo {
  address: string;
  balance: number;
  percentOfSupply: number;
  isCreator?: boolean;
  isBondingCurve?: boolean;
}

export interface HolderAnalysisResult {
  tokenMint: string;
  creatorAddress: string | null;
  bondingCurveAddress: string | null;

  // Concentration metrics
  top10HolderPercent: number;
  top5HolderPercent: number;
  topHolderPercent: number;

  // Risk flags
  isConcentrated: boolean;       // Top 10 > 50%
  isHighlyConcentrated: boolean; // Top 10 > 70%

  // Dev/Creator analysis
  creatorBalance: number;
  creatorPercentOfSupply: number;
  creatorHasSold: boolean;
  creatorSellPercent: number;    // % of their original allocation sold

  // Top holders list
  topHolders: HolderInfo[];

  // Metadata
  fetchedAt: Date;
  totalHolders: number;
}

export interface DevSellInfo {
  hasSold: boolean;
  soldPercent: number;
  soldAmount: number;
  recentSells: {
    amount: number;
    timestamp: Date;
    percentOfSupply: number;
  }[];
}

export interface InsiderAnalysisResult {
  // Early buyers (first 5 minutes after launch)
  earlyBuyerCount: number;
  earlyBuyerAddresses: string[];

  // Insider selling detection
  insidersSelling: boolean;
  insiderSellCount: number;
  insiderSellPercent: number;  // % of supply sold by insiders recently

  // Bundled transaction detection (same slot = coordinated)
  hasBundledBuys: boolean;
  bundledBuyCount: number;     // Number of buys in same slot
  bundledBuyAddresses: string[];

  // Risk assessment
  insiderRiskLevel: 'low' | 'medium' | 'high';
  riskReasons: string[];
}

export class PumpFunHolderService {
  /**
   * Get holder analysis for a pump.fun token
   */
  async getHolderAnalysis(tokenMint: string): Promise<HolderAnalysisResult | null> {
    try {
      // Check cache first
      const cached = holderCache.get(tokenMint);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
      }

      // Fetch token info (includes creator)
      const tokenInfo = await this.fetchTokenInfo(tokenMint);
      if (!tokenInfo) {
        console.log(`   ⚠️  [PumpFun] Token not found on pump.fun: ${tokenMint.substring(0, 8)}...`);
        return null;
      }

      // Fetch holder list
      const holders = await this.fetchHolders(tokenMint);
      if (!holders || holders.length === 0) {
        console.log(`   ⚠️  [PumpFun] No holder data available for: ${tokenMint.substring(0, 8)}...`);
        return null;
      }

      // Extract creator and bonding curve addresses
      const creatorAddress = tokenInfo.creator || null;
      const bondingCurveAddress = tokenInfo.bonding_curve || null;

      // Filter out bonding curve from holder analysis
      const realHolders = holders.filter(h => h.address !== bondingCurveAddress);

      // Calculate concentration metrics
      const sortedByBalance = [...realHolders].sort((a, b) => b.balance - a.balance);

      const top10 = sortedByBalance.slice(0, 10);
      const top5 = sortedByBalance.slice(0, 5);
      const topHolder = sortedByBalance[0];

      const top10Balance = top10.reduce((sum, h) => sum + h.balance, 0);
      const top5Balance = top5.reduce((sum, h) => sum + h.balance, 0);
      const topHolderBalance = topHolder?.balance || 0;

      const top10Percent = (top10Balance / PUMP_FUN_TOTAL_SUPPLY) * 100;
      const top5Percent = (top5Balance / PUMP_FUN_TOTAL_SUPPLY) * 100;
      const topHolderPercent = (topHolderBalance / PUMP_FUN_TOTAL_SUPPLY) * 100;

      // Find creator's current balance
      const creatorHolder = creatorAddress
        ? realHolders.find(h => h.address === creatorAddress)
        : null;
      const creatorBalance = creatorHolder?.balance || 0;
      const creatorPercentOfSupply = (creatorBalance / PUMP_FUN_TOTAL_SUPPLY) * 100;

      // Check if creator has sold (compare to initial allocation)
      // On pump.fun, creator typically gets tokens from bonding curve
      // If their current balance is less than they received, they sold
      const creatorInitialAllocation = tokenInfo.creator_token_amount || 0;
      const creatorSoldAmount = Math.max(0, creatorInitialAllocation - creatorBalance);
      const creatorSellPercent = creatorInitialAllocation > 0
        ? (creatorSoldAmount / creatorInitialAllocation) * 100
        : 0;
      const creatorHasSold = creatorSellPercent > 5; // More than 5% sold

      // Build top holders list with metadata
      const topHolders: HolderInfo[] = top10.map(h => ({
        address: h.address,
        balance: h.balance,
        percentOfSupply: (h.balance / PUMP_FUN_TOTAL_SUPPLY) * 100,
        isCreator: h.address === creatorAddress,
        isBondingCurve: false, // Already filtered out
      }));

      const result: HolderAnalysisResult = {
        tokenMint,
        creatorAddress,
        bondingCurveAddress,
        top10HolderPercent: top10Percent,
        top5HolderPercent: top5Percent,
        topHolderPercent,
        isConcentrated: top10Percent > 50,
        isHighlyConcentrated: top10Percent > 70,
        creatorBalance,
        creatorPercentOfSupply,
        creatorHasSold,
        creatorSellPercent,
        topHolders,
        fetchedAt: new Date(),
        totalHolders: realHolders.length,
      };

      // Cache the result
      holderCache.set(tokenMint, {
        data: result,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return result;
    } catch (error: any) {
      console.error(`   ❌ [PumpFun] Holder analysis failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if creator/dev is selling
   * Returns detailed sell info from recent trades
   */
  async checkDevSelling(tokenMint: string, lookbackMinutes: number = 15): Promise<DevSellInfo | null> {
    try {
      // Get holder analysis first (to get creator address)
      const holderAnalysis = await this.getHolderAnalysis(tokenMint);
      if (!holderAnalysis || !holderAnalysis.creatorAddress) {
        return null;
      }

      // Fetch recent trades for the token
      const trades = await this.fetchRecentTrades(tokenMint, 100);
      if (!trades || trades.length === 0) {
        return {
          hasSold: false,
          soldPercent: 0,
          soldAmount: 0,
          recentSells: [],
        };
      }

      const cutoffTime = Date.now() - (lookbackMinutes * 60 * 1000);

      // Filter for creator's sells in the lookback window
      const creatorSells = trades.filter(t =>
        t.user === holderAnalysis.creatorAddress &&
        t.is_buy === false &&
        new Date(t.timestamp).getTime() >= cutoffTime
      );

      if (creatorSells.length === 0) {
        return {
          hasSold: false,
          soldPercent: 0,
          soldAmount: 0,
          recentSells: [],
        };
      }

      // Calculate total sold amount
      const totalSoldAmount = creatorSells.reduce((sum, t) => sum + (t.token_amount || 0), 0);
      const soldPercentOfSupply = (totalSoldAmount / PUMP_FUN_TOTAL_SUPPLY) * 100;

      const recentSells = creatorSells.map(t => ({
        amount: t.token_amount || 0,
        timestamp: new Date(t.timestamp),
        percentOfSupply: ((t.token_amount || 0) / PUMP_FUN_TOTAL_SUPPLY) * 100,
      }));

      return {
        hasSold: true,
        soldPercent: soldPercentOfSupply,
        soldAmount: totalSoldAmount,
        recentSells,
      };
    } catch (error: any) {
      console.error(`   ❌ [PumpFun] Dev sell check failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Quick check: Should we block this signal based on holder data?
   * Used as a gate in consensus-webhook.service.ts
   */
  async shouldBlockSignal(tokenMint: string): Promise<{
    shouldBlock: boolean;
    reason: string | null;
    details: {
      top10Percent?: number;
      creatorSelling?: boolean;
      creatorSellPercent?: number;
    };
  }> {
    try {
      const holderAnalysis = await this.getHolderAnalysis(tokenMint);

      if (!holderAnalysis) {
        // Can't analyze = don't block, but warn
        return {
          shouldBlock: false,
          reason: null,
          details: {},
        };
      }

      // BLOCK: Top 10 holders control > 70% (highly concentrated)
      if (holderAnalysis.isHighlyConcentrated) {
        return {
          shouldBlock: true,
          reason: `Top 10 holders control ${holderAnalysis.top10HolderPercent.toFixed(1)}% (>70%)`,
          details: {
            top10Percent: holderAnalysis.top10HolderPercent,
          },
        };
      }

      // BLOCK: Creator sold > 50% of their allocation recently
      if (holderAnalysis.creatorHasSold && holderAnalysis.creatorSellPercent > 50) {
        return {
          shouldBlock: true,
          reason: `Creator sold ${holderAnalysis.creatorSellPercent.toFixed(1)}% of allocation`,
          details: {
            creatorSelling: true,
            creatorSellPercent: holderAnalysis.creatorSellPercent,
          },
        };
      }

      // Check for recent dev selling activity
      const devSellInfo = await this.checkDevSelling(tokenMint, 15); // Last 15 minutes

      if (devSellInfo && devSellInfo.hasSold && devSellInfo.soldPercent > 1) {
        // BLOCK: Dev sold > 1% of supply in last 15 min
        return {
          shouldBlock: true,
          reason: `Creator sold ${devSellInfo.soldPercent.toFixed(2)}% of supply in last 15min`,
          details: {
            creatorSelling: true,
            creatorSellPercent: devSellInfo.soldPercent,
          },
        };
      }

      // WARN (no block): Top 10 > 50% (concentrated but not extreme)
      if (holderAnalysis.isConcentrated) {
        console.log(`   ⚠️  [PumpFun] Concentrated: Top 10 hold ${holderAnalysis.top10HolderPercent.toFixed(1)}%`);
      }

      return {
        shouldBlock: false,
        reason: null,
        details: {
          top10Percent: holderAnalysis.top10HolderPercent,
          creatorSelling: holderAnalysis.creatorHasSold,
          creatorSellPercent: holderAnalysis.creatorSellPercent,
        },
      };
    } catch (error: any) {
      console.error(`   ❌ [PumpFun] shouldBlockSignal failed: ${error.message}`);
      return {
        shouldBlock: false,
        reason: null,
        details: {},
      };
    }
  }

  /**
   * Fetch token info from pump.fun API
   */
  private async fetchTokenInfo(tokenMint: string): Promise<any> {
    try {
      const response = await fetch(`${PUMP_FUN_API_BASE}/coins/${tokenMint}`);

      if (!response.ok) {
        if (response.status === 404) {
          return null; // Token not found on pump.fun
        }
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error: any) {
      console.warn(`   ⚠️  [PumpFun] fetchTokenInfo failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch holder list from pump.fun API
   */
  private async fetchHolders(tokenMint: string): Promise<{ address: string; balance: number }[] | null> {
    try {
      const response = await fetch(`${PUMP_FUN_API_BASE}/coins/${tokenMint}/holders?limit=50&offset=0`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as any;

      // API returns array of holder objects
      if (Array.isArray(data)) {
        return data.map((h: any) => ({
          address: h.address || h.holder,
          balance: Number(h.balance || h.amount || 0),
        }));
      }

      // Or might be wrapped in a holders property
      if (data && data.holders && Array.isArray(data.holders)) {
        return data.holders.map((h: any) => ({
          address: h.address || h.holder,
          balance: Number(h.balance || h.amount || 0),
        }));
      }

      return null;
    } catch (error: any) {
      console.warn(`   ⚠️  [PumpFun] fetchHolders failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch recent trades from pump.fun API
   */
  private async fetchRecentTrades(tokenMint: string, limit: number = 100): Promise<any[] | null> {
    try {
      const response = await fetch(`${PUMP_FUN_API_BASE}/trades/latest/${tokenMint}?limit=${limit}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as any;

      if (Array.isArray(data)) {
        return data;
      }

      if (data && data.trades && Array.isArray(data.trades)) {
        return data.trades;
      }

      return null;
    } catch (error: any) {
      console.warn(`   ⚠️  [PumpFun] fetchRecentTrades failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Analyze insider activity for a token
   * Detects early buyers, insider selling, and bundled transactions
   */
  async analyzeInsiders(tokenMint: string): Promise<InsiderAnalysisResult | null> {
    try {
      // Fetch token info for creation timestamp
      const tokenInfo = await this.fetchTokenInfo(tokenMint);
      if (!tokenInfo) {
        return null;
      }

      // Fetch all trades (we need early ones for insider detection)
      const allTrades = await this.fetchAllTrades(tokenMint, 500);
      if (!allTrades || allTrades.length === 0) {
        return null;
      }

      // Token creation time
      const createdAt = tokenInfo.created_timestamp
        ? new Date(tokenInfo.created_timestamp).getTime()
        : null;

      if (!createdAt) {
        console.warn(`   ⚠️  [PumpFun] No creation timestamp for ${tokenMint.substring(0, 8)}...`);
        return null;
      }

      // 1. Find early buyers (first 5 minutes after launch)
      const EARLY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
      const earlyBuys = allTrades.filter(t => {
        const tradeTime = new Date(t.timestamp).getTime();
        return t.is_buy === true && (tradeTime - createdAt) <= EARLY_WINDOW_MS;
      });

      const earlyBuyerAddresses = [...new Set(earlyBuys.map(t => t.user))];
      const earlyBuyerCount = earlyBuyerAddresses.length;

      // 2. Check if early buyers (insiders) are selling recently
      const RECENT_WINDOW_MS = 30 * 60 * 1000; // Last 30 minutes
      const now = Date.now();
      const recentSells = allTrades.filter(t => {
        const tradeTime = new Date(t.timestamp).getTime();
        return t.is_buy === false && (now - tradeTime) <= RECENT_WINDOW_MS;
      });

      // Check if any early buyer is in recent sellers
      const insiderSells = recentSells.filter(t => earlyBuyerAddresses.includes(t.user));
      const insidersSelling = insiderSells.length > 0;
      const insiderSellCount = insiderSells.length;

      // Calculate % of supply sold by insiders
      const insiderSellAmount = insiderSells.reduce((sum, t) => sum + (t.token_amount || 0), 0);
      const insiderSellPercent = (insiderSellAmount / PUMP_FUN_TOTAL_SUPPLY) * 100;

      // 3. Detect bundled transactions (multiple buys in same slot = coordinated)
      const buysBySlot = new Map<number, any[]>();
      const recentBuys = allTrades.filter(t => {
        const tradeTime = new Date(t.timestamp).getTime();
        return t.is_buy === true && (now - tradeTime) <= RECENT_WINDOW_MS;
      });

      for (const trade of recentBuys) {
        const slot = trade.slot;
        if (slot) {
          if (!buysBySlot.has(slot)) {
            buysBySlot.set(slot, []);
          }
          buysBySlot.get(slot)!.push(trade);
        }
      }

      // Find slots with multiple buys (bundled)
      let bundledBuyCount = 0;
      const bundledBuyAddresses: string[] = [];

      for (const [_slot, trades] of buysBySlot) {
        if (trades.length >= 2) {
          bundledBuyCount += trades.length;
          for (const t of trades) {
            if (!bundledBuyAddresses.includes(t.user)) {
              bundledBuyAddresses.push(t.user);
            }
          }
        }
      }

      const hasBundledBuys = bundledBuyCount >= 3; // 3+ bundled buys is suspicious

      // 4. Calculate risk level
      const riskReasons: string[] = [];
      let riskScore = 0;

      if (insidersSelling && insiderSellPercent > 0.5) {
        riskReasons.push(`Early buyers selling ${insiderSellPercent.toFixed(2)}% of supply`);
        riskScore += 3;
      }

      if (hasBundledBuys && bundledBuyCount >= 5) {
        riskReasons.push(`${bundledBuyCount} bundled buys detected (coordinated network)`);
        riskScore += 2;
      }

      if (earlyBuyerCount >= 10 && earlyBuyerCount <= 20) {
        // Many early buyers could be insider network
        riskReasons.push(`${earlyBuyerCount} early buyers in first 5min`);
        riskScore += 1;
      }

      let insiderRiskLevel: 'low' | 'medium' | 'high' = 'low';
      if (riskScore >= 4) {
        insiderRiskLevel = 'high';
      } else if (riskScore >= 2) {
        insiderRiskLevel = 'medium';
      }

      return {
        earlyBuyerCount,
        earlyBuyerAddresses,
        insidersSelling,
        insiderSellCount,
        insiderSellPercent,
        hasBundledBuys,
        bundledBuyCount,
        bundledBuyAddresses,
        insiderRiskLevel,
        riskReasons,
      };
    } catch (error: any) {
      console.error(`   ❌ [PumpFun] analyzeInsiders failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Quick insider risk check for signal gating
   * Returns true if insider risk is HIGH and should block
   */
  async shouldBlockForInsiderRisk(tokenMint: string): Promise<{
    shouldBlock: boolean;
    reason: string | null;
    insiderRiskLevel: 'low' | 'medium' | 'high' | null;
  }> {
    try {
      const insiderAnalysis = await this.analyzeInsiders(tokenMint);

      if (!insiderAnalysis) {
        return { shouldBlock: false, reason: null, insiderRiskLevel: null };
      }

      // BLOCK if high insider risk
      if (insiderAnalysis.insiderRiskLevel === 'high') {
        return {
          shouldBlock: true,
          reason: insiderAnalysis.riskReasons.join('; '),
          insiderRiskLevel: 'high',
        };
      }

      // BLOCK if insiders sold > 2% of supply recently
      if (insiderAnalysis.insidersSelling && insiderAnalysis.insiderSellPercent > 2) {
        return {
          shouldBlock: true,
          reason: `Early buyers dumping: ${insiderAnalysis.insiderSellPercent.toFixed(2)}% sold`,
          insiderRiskLevel: insiderAnalysis.insiderRiskLevel,
        };
      }

      return {
        shouldBlock: false,
        reason: null,
        insiderRiskLevel: insiderAnalysis.insiderRiskLevel,
      };
    } catch (error: any) {
      console.error(`   ❌ [PumpFun] shouldBlockForInsiderRisk failed: ${error.message}`);
      return { shouldBlock: false, reason: null, insiderRiskLevel: null };
    }
  }

  /**
   * Fetch all trades from pump.fun API (for insider analysis)
   */
  private async fetchAllTrades(tokenMint: string, limit: number = 500): Promise<any[] | null> {
    try {
      // Use /trades/all endpoint for historical data
      const response = await fetch(`${PUMP_FUN_API_BASE}/trades/all/${tokenMint}?limit=${limit}`);

      if (!response.ok) {
        // Fallback to /trades/latest if /trades/all doesn't exist
        return this.fetchRecentTrades(tokenMint, limit);
      }

      const data = await response.json() as any;

      if (Array.isArray(data)) {
        return data;
      }

      if (data && data.trades && Array.isArray(data.trades)) {
        return data.trades;
      }

      // Fallback
      return this.fetchRecentTrades(tokenMint, limit);
    } catch (error: any) {
      console.warn(`   ⚠️  [PumpFun] fetchAllTrades failed, trying fallback: ${error.message}`);
      return this.fetchRecentTrades(tokenMint, limit);
    }
  }

  /**
   * Clear cache for a specific token or all tokens
   */
  clearCache(tokenMint?: string): void {
    if (tokenMint) {
      holderCache.delete(tokenMint);
    } else {
      holderCache.clear();
    }
  }
}

// Export singleton instance
export const pumpFunHolderService = new PumpFunHolderService();
