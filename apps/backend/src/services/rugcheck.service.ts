/**
 * RugCheck Service
 * 
 * Integrace s RugCheck.xyz API pro kontrolu bezpečnosti tokenů.
 * 
 * Kontroluje:
 * - Risk score (0-100)
 * - LP lock status
 * - Mint authority (renounced?)
 * - Freeze authority
 * - Top holders distribution
 * - Honeypot detection
 * - DEX Paid status
 */

export interface RugCheckReport {
  // Basic info
  mint: string;
  tokenSymbol?: string;
  tokenName?: string;
  
  // Risk assessment
  riskScore: number; // 0-100, lower = safer
  riskLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  
  // Security flags
  isRugged: boolean;
  isMintable: boolean;    // Can mint more tokens?
  isFreezable: boolean;   // Can freeze accounts?
  isLpLocked: boolean;
  lpLockedPercent?: number;
  lpLockDuration?: string; // e.g. "30 days", "forever"
  
  // DEX info
  isDexPaid: boolean;
  
  // Holder distribution
  topHolderPercent?: number; // Top holder's % of supply
  top10HoldersPercent?: number;
  holderCount?: number;
  
  // Warnings/Risks detected
  risks: string[];
  
  // Raw response for debugging
  raw?: any;
}

// Cache to avoid repeated API calls
const cache = new Map<string, { data: RugCheckReport; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class RugCheckService {
  private baseUrl = 'https://api.rugcheck.xyz/v1';
  private rateLimitDelay = 1000; // 1 second between requests
  private lastRequestTime = 0;

  /**
   * Získá RugCheck report pro token
   */
  async getReport(mintAddress: string): Promise<RugCheckReport | null> {
    try {
      // Check cache first
      const cached = cache.get(mintAddress);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
      }

      // Rate limiting
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.rateLimitDelay) {
        await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - timeSinceLastRequest));
      }
      this.lastRequestTime = Date.now();

      // Fetch from API
      const response = await fetch(`${this.baseUrl}/tokens/${mintAddress}/report`, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.log(`RugCheck: Token ${mintAddress.substring(0, 8)}... not found`);
          return null;
        }
        throw new Error(`RugCheck API error: ${response.status}`);
      }

      const data = await response.json();
      const report = this.parseReport(mintAddress, data);

      // Cache the result
      cache.set(mintAddress, { data: report, timestamp: Date.now() });

      return report;
    } catch (error: any) {
      console.error(`RugCheck error for ${mintAddress.substring(0, 8)}...: ${error.message}`);
      return null;
    }
  }

  /**
   * Parsuje raw API response do našeho formátu
   */
  private parseReport(mintAddress: string, data: any): RugCheckReport {
    const risks: string[] = [];
    
    // Extract basic info
    const tokenMeta = data.tokenMeta || data.token || {};
    
    // Parse risk score (RugCheck uses different formats)
    let riskScore = 0;
    if (data.score !== undefined) {
      riskScore = Number(data.score) || 0;
    } else if (data.riskScore !== undefined) {
      riskScore = Number(data.riskScore) || 0;
    } else if (data.risks && Array.isArray(data.risks)) {
      // Calculate from individual risks
      riskScore = data.risks.reduce((sum: number, r: any) => sum + (r.score || r.level || 10), 0);
    }

    // Determine risk level
    let riskLevel: RugCheckReport['riskLevel'] = 'safe';
    if (riskScore >= 80) riskLevel = 'critical';
    else if (riskScore >= 60) riskLevel = 'high';
    else if (riskScore >= 40) riskLevel = 'medium';
    else if (riskScore >= 20) riskLevel = 'low';

    // Check mint authority
    const isMintable = data.mintAuthority !== null && 
                       data.mintAuthority !== undefined &&
                       data.mintAuthority !== '' &&
                       !data.mintAuthorityDisabled;
    if (isMintable) {
      risks.push('⚠️ Mint authority NOT renounced');
    }

    // Check freeze authority
    const isFreezable = data.freezeAuthority !== null && 
                        data.freezeAuthority !== undefined &&
                        data.freezeAuthority !== '' &&
                        !data.freezeAuthorityDisabled;
    if (isFreezable) {
      risks.push('🥶 Freeze authority enabled');
    }

    // LP Lock status
    let isLpLocked = false;
    let lpLockedPercent = 0;
    let lpLockDuration: string | undefined;
    
    if (data.markets && Array.isArray(data.markets)) {
      for (const market of data.markets) {
        if (market.lp) {
          const lpLocked = market.lp.lpLockedPct || market.lp.lockedPct || 0;
          if (lpLocked > lpLockedPercent) {
            lpLockedPercent = lpLocked;
          }
          if (lpLocked > 50) {
            isLpLocked = true;
          }
          if (market.lp.lockExpiry) {
            lpLockDuration = this.formatLockDuration(market.lp.lockExpiry);
          }
        }
      }
    }
    
    if (!isLpLocked) {
      risks.push('🔓 LP not locked');
    } else if (lpLockedPercent > 0) {
      // This is actually positive, not a risk
    }

    // DEX Paid
    const isDexPaid = data.dexPaid === true || 
                      data.isDexPaid === true ||
                      (data.markets && data.markets.some((m: any) => m.dexPaid));

    // Top holders
    let topHolderPercent = 0;
    let top10HoldersPercent = 0;
    let holderCount = 0;
    
    if (data.topHolders && Array.isArray(data.topHolders)) {
      holderCount = data.topHolders.length;
      if (data.topHolders[0]) {
        topHolderPercent = Number(data.topHolders[0].pct || data.topHolders[0].percentage || 0);
      }
      top10HoldersPercent = data.topHolders
        .slice(0, 10)
        .reduce((sum: number, h: any) => sum + Number(h.pct || h.percentage || 0), 0);
    }

    if (topHolderPercent > 50) {
      risks.push(`🐋 Top holder owns ${topHolderPercent.toFixed(1)}%`);
    }
    if (top10HoldersPercent > 80) {
      risks.push(`📊 Top 10 own ${top10HoldersPercent.toFixed(1)}%`);
    }

    // Is rugged?
    const isRugged = data.rugged === true || 
                     data.isRugged === true ||
                     riskLevel === 'critical';

    // Collect all warnings from API
    if (data.risks && Array.isArray(data.risks)) {
      for (const risk of data.risks) {
        const riskName = risk.name || risk.type || risk.description;
        if (riskName && !risks.includes(riskName)) {
          risks.push(riskName);
        }
      }
    }

    return {
      mint: mintAddress,
      tokenSymbol: tokenMeta.symbol,
      tokenName: tokenMeta.name,
      riskScore,
      riskLevel,
      isRugged,
      isMintable,
      isFreezable,
      isLpLocked,
      lpLockedPercent,
      lpLockDuration,
      isDexPaid,
      topHolderPercent,
      top10HoldersPercent,
      holderCount,
      risks: risks.slice(0, 5), // Max 5 risks
      raw: data,
    };
  }

  /**
   * Formátuje LP lock duration
   */
  private formatLockDuration(expiryTimestamp: number): string {
    if (!expiryTimestamp) return 'unknown';
    
    const now = Date.now();
    const expiry = expiryTimestamp * 1000; // Convert to ms if in seconds
    
    if (expiry < now) return 'expired';
    
    const diff = expiry - now;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days > 365 * 10) return 'forever';
    if (days > 365) return `${Math.floor(days / 365)} years`;
    if (days > 30) return `${Math.floor(days / 30)} months`;
    return `${days} days`;
  }

  /**
   * Quick security check - vrací jednoduchý boolean
   */
  async isTokenSafe(mintAddress: string): Promise<{
    safe: boolean;
    riskLevel: string;
    mainRisk?: string;
  }> {
    const report = await this.getReport(mintAddress);
    
    if (!report) {
      return { safe: false, riskLevel: 'unknown', mainRisk: 'Could not fetch security data' };
    }

    return {
      safe: report.riskLevel === 'safe' || report.riskLevel === 'low',
      riskLevel: report.riskLevel,
      mainRisk: report.risks[0],
    };
  }

  /**
   * Formátuje report pro Discord notifikaci
   */
  formatForDiscord(report: RugCheckReport): string {
    const lines: string[] = [];
    
    // Risk level emoji
    const riskEmoji = {
      'safe': '✅',
      'low': '🟢',
      'medium': '🟡',
      'high': '🟠',
      'critical': '🔴',
    }[report.riskLevel] || '❓';

    lines.push(`${riskEmoji} **Risk:** ${report.riskLevel.toUpperCase()} (${report.riskScore}/100)`);

    // Security flags
    const flags: string[] = [];
    if (report.isLpLocked) flags.push(`🔒 LP Locked ${report.lpLockedPercent ? `(${report.lpLockedPercent.toFixed(0)}%)` : ''}`);
    if (report.isDexPaid) flags.push('💰 DEX Paid');
    if (!report.isMintable) flags.push('✅ Mint Renounced');
    if (!report.isFreezable) flags.push('✅ No Freeze');
    
    if (flags.length > 0) {
      lines.push(flags.join(' • '));
    }

    // Top risks
    if (report.risks.length > 0) {
      lines.push(`⚠️ ${report.risks.slice(0, 3).join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Vrátí krátký summary pro UI
   */
  getSummary(report: RugCheckReport): {
    emoji: string;
    label: string;
    color: string;
  } {
    switch (report.riskLevel) {
      case 'safe':
        return { emoji: '✅', label: 'SAFE', color: 'text-green-400' };
      case 'low':
        return { emoji: '🟢', label: 'LOW RISK', color: 'text-green-300' };
      case 'medium':
        return { emoji: '🟡', label: 'MEDIUM', color: 'text-yellow-400' };
      case 'high':
        return { emoji: '🟠', label: 'HIGH RISK', color: 'text-orange-400' };
      case 'critical':
        return { emoji: '🔴', label: 'DANGER', color: 'text-red-500' };
      default:
        return { emoji: '❓', label: 'UNKNOWN', color: 'text-gray-400' };
    }
  }
}

