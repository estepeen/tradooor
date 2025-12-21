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
 * - Buy/Sell tax
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
  
  // 🍯 HONEYPOT DETECTION
  isHoneypot: boolean;      // CRITICAL: Can't sell!
  honeypotReason?: string;  // Why it's a honeypot
  
  // 💸 BUY/SELL TAX
  buyTax?: number;          // % tax on buy (0-100)
  sellTax?: number;         // % tax on sell (0-100)
  transferTax?: number;     // % tax on transfer
  hasDangerousTax: boolean; // Tax > 10%
  
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
   * DISABLED: Smart wallets don't get rugged, so RugCheck is not needed
   */
  async getReport(mintAddress: string): Promise<RugCheckReport | null> {
    // RugCheck disabled - smart wallets don't get rugged
    return null;
    
    /* DISABLED - Smart wallets don't get rugged
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
    */
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

    // 🍯 HONEYPOT DETECTION
    let isHoneypot = false;
    let honeypotReason: string | undefined;
    
    // Check various honeypot indicators
    if (data.isHoneypot === true || data.honeypot === true) {
      isHoneypot = true;
      honeypotReason = 'Detected as honeypot';
    }
    
    // Check if selling is disabled/blocked
    if (data.canSell === false || data.sellable === false) {
      isHoneypot = true;
      honeypotReason = 'Selling is disabled';
    }
    
    // Check risks array for honeypot indicators
    if (data.risks && Array.isArray(data.risks)) {
      for (const risk of data.risks) {
        const riskName = (risk.name || risk.type || risk.description || '').toLowerCase();
        if (riskName.includes('honeypot') || 
            riskName.includes('honey pot') ||
            riskName.includes('cannot sell') ||
            riskName.includes('can\'t sell') ||
            riskName.includes('sell blocked') ||
            riskName.includes('no sell')) {
          isHoneypot = true;
          honeypotReason = risk.name || risk.description || 'Honeypot detected in risks';
        }
      }
    }
    
    // Check fileMeta for honeypot flags (some APIs use this)
    if (data.fileMeta?.honeypot || data.tokenMeta?.honeypot) {
      isHoneypot = true;
      honeypotReason = 'Token metadata indicates honeypot';
    }

    if (isHoneypot) {
      risks.unshift('🍯 HONEYPOT - CANNOT SELL!');
      riskLevel = 'critical';
      riskScore = Math.max(riskScore, 95);
    }

    // 💸 BUY/SELL TAX
    let buyTax: number | undefined;
    let sellTax: number | undefined;
    let transferTax: number | undefined;
    let hasDangerousTax = false;

    // Parse tax from various API response formats
    if (data.tax) {
      buyTax = Number(data.tax.buy || data.tax.buyTax || 0);
      sellTax = Number(data.tax.sell || data.tax.sellTax || 0);
      transferTax = Number(data.tax.transfer || data.tax.transferTax || 0);
    } else if (data.taxes) {
      buyTax = Number(data.taxes.buy || data.taxes.buyTax || 0);
      sellTax = Number(data.taxes.sell || data.taxes.sellTax || 0);
      transferTax = Number(data.taxes.transfer || 0);
    } else {
      // Try direct fields
      buyTax = data.buyTax !== undefined ? Number(data.buyTax) : undefined;
      sellTax = data.sellTax !== undefined ? Number(data.sellTax) : undefined;
      transferTax = data.transferTax !== undefined ? Number(data.transferTax) : undefined;
    }

    // Check markets for tax info
    if (data.markets && Array.isArray(data.markets)) {
      for (const market of data.markets) {
        if (market.buyTax !== undefined && (buyTax === undefined || market.buyTax > buyTax)) {
          buyTax = Number(market.buyTax);
        }
        if (market.sellTax !== undefined && (sellTax === undefined || market.sellTax > sellTax)) {
          sellTax = Number(market.sellTax);
        }
      }
    }

    // Check for dangerous tax levels
    const TAX_DANGER_THRESHOLD = 10; // 10% is considered dangerous
    if ((buyTax && buyTax > TAX_DANGER_THRESHOLD) || 
        (sellTax && sellTax > TAX_DANGER_THRESHOLD)) {
      hasDangerousTax = true;
    }

    // Very high tax might indicate honeypot
    if (sellTax && sellTax >= 90) {
      isHoneypot = true;
      honeypotReason = `Sell tax is ${sellTax}% - effectively a honeypot`;
      risks.unshift(`🍯 SELL TAX ${sellTax}% = HONEYPOT`);
    } else if (sellTax && sellTax > TAX_DANGER_THRESHOLD) {
      risks.unshift(`💸 High sell tax: ${sellTax}%`);
    }

    if (buyTax && buyTax > TAX_DANGER_THRESHOLD) {
      risks.unshift(`💸 High buy tax: ${buyTax}%`);
    }

    // Collect all warnings from API
    if (data.risks && Array.isArray(data.risks)) {
      for (const risk of data.risks) {
        const riskName = risk.name || risk.type || risk.description;
        if (riskName && !risks.some(r => r.includes(riskName))) {
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
      isHoneypot,
      honeypotReason,
      buyTax,
      sellTax,
      transferTax,
      hasDangerousTax,
      isDexPaid,
      topHolderPercent,
      top10HoldersPercent,
      holderCount,
      risks: risks.slice(0, 7), // Max 7 risks (increased for honeypot/tax)
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
    isHoneypot: boolean;
    hasDangerousTax: boolean;
  }> {
    const report = await this.getReport(mintAddress);
    
    if (!report) {
      return { 
        safe: false, 
        riskLevel: 'unknown', 
        mainRisk: 'Could not fetch security data',
        isHoneypot: false,
        hasDangerousTax: false,
      };
    }

    // CRITICAL: Honeypot = never safe
    if (report.isHoneypot) {
      return {
        safe: false,
        riskLevel: 'critical',
        mainRisk: report.honeypotReason || '🍯 HONEYPOT',
        isHoneypot: true,
        hasDangerousTax: report.hasDangerousTax,
      };
    }

    return {
      safe: (report.riskLevel === 'safe' || report.riskLevel === 'low') && !report.hasDangerousTax,
      riskLevel: report.riskLevel,
      mainRisk: report.risks[0],
      isHoneypot: false,
      hasDangerousTax: report.hasDangerousTax,
    };
  }

  /**
   * Formátuje report pro Discord notifikaci
   */
  formatForDiscord(report: RugCheckReport): string {
    const lines: string[] = [];
    
    // 🍯 HONEYPOT WARNING FIRST
    if (report.isHoneypot) {
      lines.push('🚨🍯 **HONEYPOT DETECTED - DO NOT BUY!** 🍯🚨');
      if (report.honeypotReason) {
        lines.push(`Reason: ${report.honeypotReason}`);
      }
      return lines.join('\n');
    }
    
    // Risk level emoji
    const riskEmoji = {
      'safe': '✅',
      'low': '🟢',
      'medium': '🟡',
      'high': '🟠',
      'critical': '🔴',
    }[report.riskLevel] || '❓';

    lines.push(`${riskEmoji} **Risk:** ${report.riskLevel.toUpperCase()} (${report.riskScore}/100)`);

    // 💸 TAX INFO
    if (report.buyTax !== undefined || report.sellTax !== undefined) {
      const taxInfo: string[] = [];
      if (report.buyTax !== undefined) {
        const buyEmoji = report.buyTax > 10 ? '⚠️' : '✓';
        taxInfo.push(`${buyEmoji} Buy: ${report.buyTax}%`);
      }
      if (report.sellTax !== undefined) {
        const sellEmoji = report.sellTax > 10 ? '⚠️' : '✓';
        taxInfo.push(`${sellEmoji} Sell: ${report.sellTax}%`);
      }
      lines.push(`💸 Tax: ${taxInfo.join(' | ')}`);
    }

    // Security flags
    const flags: string[] = [];
    if (report.isLpLocked) flags.push(`🔒 LP ${report.lpLockedPercent ? `${report.lpLockedPercent.toFixed(0)}%` : 'Locked'}`);
    if (report.isDexPaid) flags.push('💰 DEX Paid');
    if (!report.isMintable) flags.push('✅ Mint Off');
    if (!report.isFreezable) flags.push('✅ No Freeze');
    
    if (flags.length > 0) {
      lines.push(flags.join(' • '));
    }

    // Top risks (excluding honeypot/tax which are shown above)
    const otherRisks = report.risks.filter(r => 
      !r.includes('HONEYPOT') && !r.includes('tax')
    );
    if (otherRisks.length > 0) {
      lines.push(`⚠️ ${otherRisks.slice(0, 2).join(', ')}`);
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

