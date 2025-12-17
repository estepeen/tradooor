/**
 * Token Risk Scoring Service
 * 
 * Level 2.3: Detekce rizikových tokenů
 * - Honeypot detection
 * - LP lock check
 * - Holder distribution analysis
 * - Contract analysis
 */

import { generateId } from '../lib/prisma.js';
import { supabase, TABLES } from '../lib/supabase.js';
import { TokenMarketDataService } from './token-market-data.service.js';

export interface TokenRiskAnalysis {
  tokenId: string;
  mintAddress: string;
  
  // Overall risk score (0-100, higher = more risky)
  overallRiskScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'extreme';
  
  // Component scores
  liquidityRiskScore: number;
  holderRiskScore: number;
  contractRiskScore: number;
  volumeRiskScore: number;
  ageRiskScore: number;
  
  // Contract analysis
  isRenounced?: boolean;
  isMintable?: boolean;
  isFreezable?: boolean;
  hasHoneypotRisk: boolean;
  lpLocked?: boolean;
  lpLockDays?: number;
  
  // Holder analysis
  topHolderPercent?: number;
  top10HolderPercent?: number;
  uniqueHolders?: number;
  holderGrowthRate?: number;
  
  // Trading patterns
  buyToSellRatio?: number;
  avgTradeSize?: number;
  suspiciousTradingPattern: boolean;
  
  // Social
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
  
  // Warnings
  warnings: string[];
  
  // Timestamps
  analyzedAt: Date;
  expiresAt: Date;
}

export class TokenRiskService {
  private tokenMarketData: TokenMarketDataService;
  private readonly CACHE_TTL_MINUTES = 30;

  constructor() {
    this.tokenMarketData = new TokenMarketDataService();
  }

  /**
   * Analyzuj token a vrať risk score
   */
  async analyzeToken(tokenId: string, mintAddress: string): Promise<TokenRiskAnalysis> {
    console.log(`🔍 Analyzing token risk: ${mintAddress.substring(0, 8)}...`);
    
    try {
      // Check cache first
      const cached = await this.getCachedAnalysis(tokenId);
      if (cached && new Date(cached.expiresAt) > new Date()) {
        return cached;
      }

      // Načti data
      const marketData = await this.getMarketData(mintAddress);
      const tradingData = await this.getTradingData(tokenId);
      
      // Calculate component scores
      const liquidityRiskScore = this.calculateLiquidityRisk(marketData);
      const holderRiskScore = this.calculateHolderRisk(marketData);
      const contractRiskScore = await this.calculateContractRisk(mintAddress);
      const volumeRiskScore = this.calculateVolumeRisk(marketData, tradingData);
      const ageRiskScore = this.calculateAgeRisk(marketData);
      
      // Check for honeypot indicators
      const honeypotCheck = this.checkHoneypotIndicators(marketData, tradingData);
      
      // Check social presence
      const socialCheck = await this.checkSocialPresence(mintAddress);
      
      // Calculate overall score (weighted average)
      const overallRiskScore = Math.round(
        liquidityRiskScore * 0.25 +
        holderRiskScore * 0.20 +
        contractRiskScore * 0.25 +
        volumeRiskScore * 0.15 +
        ageRiskScore * 0.15
      );

      // Adjust for honeypot risk
      const finalRiskScore = honeypotCheck.hasRisk
        ? Math.min(100, overallRiskScore + 30)
        : overallRiskScore;

      // Determine risk level
      let riskLevel: TokenRiskAnalysis['riskLevel'];
      if (finalRiskScore >= 80) {
        riskLevel = 'extreme';
      } else if (finalRiskScore >= 60) {
        riskLevel = 'high';
      } else if (finalRiskScore >= 40) {
        riskLevel = 'medium';
      } else {
        riskLevel = 'low';
      }

      // Compile warnings
      const warnings: string[] = [];
      
      if (liquidityRiskScore >= 70) {
        warnings.push('⚠️ Low liquidity - high slippage risk');
      }
      if (holderRiskScore >= 70) {
        warnings.push('⚠️ Concentrated holdings - whale dump risk');
      }
      if (contractRiskScore >= 70) {
        warnings.push('⚠️ Contract concerns - potential rug risk');
      }
      if (honeypotCheck.hasRisk) {
        warnings.push('🚨 HONEYPOT INDICATORS DETECTED');
      }
      if (ageRiskScore >= 80) {
        warnings.push('⚠️ Very new token - high volatility');
      }
      if (!socialCheck.hasTwitter && !socialCheck.hasTelegram) {
        warnings.push('⚠️ No social presence - low trust');
      }

      const analysis: TokenRiskAnalysis = {
        tokenId,
        mintAddress,
        overallRiskScore: finalRiskScore,
        riskLevel,
        liquidityRiskScore,
        holderRiskScore,
        contractRiskScore,
        volumeRiskScore,
        ageRiskScore,
        hasHoneypotRisk: honeypotCheck.hasRisk,
        suspiciousTradingPattern: honeypotCheck.suspiciousPattern,
        topHolderPercent: marketData?.topHolderPercent,
        top10HolderPercent: marketData?.top10HolderPercent,
        uniqueHolders: marketData?.holders,
        buyToSellRatio: tradingData?.buyToSellRatio,
        hasTwitter: socialCheck.hasTwitter,
        hasTelegram: socialCheck.hasTelegram,
        hasWebsite: socialCheck.hasWebsite,
        warnings,
        analyzedAt: new Date(),
        expiresAt: new Date(Date.now() + this.CACHE_TTL_MINUTES * 60 * 1000),
      };

      // Save to DB
      await this.saveAnalysis(analysis);

      console.log(`   Risk: ${riskLevel.toUpperCase()} (${finalRiskScore}/100) - ${warnings.length} warnings`);

      return analysis;
    } catch (error: any) {
      console.error(`Error analyzing token risk: ${error.message}`);
      
      // Return conservative high-risk analysis on error
      return {
        tokenId,
        mintAddress,
        overallRiskScore: 75,
        riskLevel: 'high',
        liquidityRiskScore: 75,
        holderRiskScore: 75,
        contractRiskScore: 75,
        volumeRiskScore: 75,
        ageRiskScore: 75,
        hasHoneypotRisk: false,
        suspiciousTradingPattern: false,
        hasTwitter: false,
        hasTelegram: false,
        hasWebsite: false,
        warnings: ['⚠️ Could not complete full analysis'],
        analyzedAt: new Date(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // Short cache on error
      };
    }
  }

  /**
   * Get market data
   */
  private async getMarketData(mintAddress: string): Promise<any> {
    try {
      return await this.tokenMarketData.getMarketData(mintAddress);
    } catch (error) {
      return null;
    }
  }

  /**
   * Get trading data from our DB
   */
  private async getTradingData(tokenId: string): Promise<any> {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      const { data: trades } = await supabase
        .from(TABLES.TRADE)
        .select('side, amountBase')
        .eq('tokenId', tokenId)
        .gte('timestamp', since.toISOString());

      if (!trades || trades.length === 0) {
        return null;
      }

      const buys = trades.filter(t => t.side === 'buy');
      const sells = trades.filter(t => t.side === 'sell');
      
      return {
        totalTrades: trades.length,
        buyCount: buys.length,
        sellCount: sells.length,
        buyToSellRatio: sells.length > 0 ? buys.length / sells.length : buys.length,
        avgBuySize: buys.length > 0
          ? buys.reduce((sum, t) => sum + Number(t.amountBase || 0), 0) / buys.length
          : 0,
        avgSellSize: sells.length > 0
          ? sells.reduce((sum, t) => sum + Number(t.amountBase || 0), 0) / sells.length
          : 0,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate liquidity risk (0-100)
   */
  private calculateLiquidityRisk(marketData: any): number {
    if (!marketData?.liquidity) return 80;
    
    const liquidity = marketData.liquidity;
    
    if (liquidity >= 100000) return 10;
    if (liquidity >= 50000) return 25;
    if (liquidity >= 20000) return 40;
    if (liquidity >= 10000) return 55;
    if (liquidity >= 5000) return 70;
    return 85;
  }

  /**
   * Calculate holder risk (0-100)
   */
  private calculateHolderRisk(marketData: any): number {
    let risk = 50; // Base risk
    
    // Top holder concentration
    if (marketData?.topHolderPercent) {
      if (marketData.topHolderPercent > 50) risk += 30;
      else if (marketData.topHolderPercent > 30) risk += 20;
      else if (marketData.topHolderPercent > 15) risk += 10;
      else if (marketData.topHolderPercent < 5) risk -= 10;
    }
    
    // Total holders
    if (marketData?.holders) {
      if (marketData.holders < 50) risk += 20;
      else if (marketData.holders < 100) risk += 10;
      else if (marketData.holders > 1000) risk -= 15;
      else if (marketData.holders > 500) risk -= 10;
    }
    
    return Math.max(0, Math.min(100, risk));
  }

  /**
   * Calculate contract risk (0-100)
   */
  private async calculateContractRisk(mintAddress: string): Promise<number> {
    // V ideálním případě bychom zde volali Solana RPC pro analýzu kontraktu
    // Pro teď použijeme zjednodušenou verzi
    
    let risk = 50; // Base risk
    
    // Check if it's a known good token (simplified)
    const knownTokens = [
      'So11111111111111111111111111111111111111112', // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    ];
    
    if (knownTokens.includes(mintAddress)) {
      return 5;
    }
    
    // Check for pump.fun tokens (often higher risk)
    if (mintAddress.endsWith('pump')) {
      risk += 15;
    }
    
    return risk;
  }

  /**
   * Calculate volume risk (0-100)
   */
  private calculateVolumeRisk(marketData: any, tradingData: any): number {
    let risk = 50;
    
    // 24h volume vs market cap ratio
    if (marketData?.volume24h && marketData?.marketCap) {
      const volumeRatio = marketData.volume24h / marketData.marketCap;
      
      if (volumeRatio < 0.01) risk += 20; // Very low activity
      else if (volumeRatio > 1) risk += 15; // Suspiciously high
      else if (volumeRatio > 0.1) risk -= 10; // Healthy
    }
    
    // Buy to sell ratio
    if (tradingData?.buyToSellRatio) {
      if (tradingData.buyToSellRatio > 10) risk += 15; // Mostly buys, no sells = potential trap
      else if (tradingData.buyToSellRatio < 0.5) risk += 10; // Heavy selling
      else if (tradingData.buyToSellRatio > 1 && tradingData.buyToSellRatio < 3) risk -= 10; // Healthy
    }
    
    return Math.max(0, Math.min(100, risk));
  }

  /**
   * Calculate age risk (0-100)
   */
  private calculateAgeRisk(marketData: any): number {
    if (!marketData?.ageMinutes && marketData?.ageMinutes !== 0) return 70;
    
    const ageMinutes = marketData.ageMinutes;
    
    if (ageMinutes < 10) return 95; // Very new
    if (ageMinutes < 30) return 85;
    if (ageMinutes < 60) return 70;
    if (ageMinutes < 180) return 55;
    if (ageMinutes < 720) return 40; // 12h
    if (ageMinutes < 1440) return 30; // 24h
    if (ageMinutes < 10080) return 20; // 1 week
    return 10;
  }

  /**
   * Check honeypot indicators
   */
  private checkHoneypotIndicators(marketData: any, tradingData: any): {
    hasRisk: boolean;
    suspiciousPattern: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];
    let suspiciousPattern = false;
    
    // Check for sell inability indicators
    if (tradingData) {
      // Many buys, no sells
      if (tradingData.buyCount > 10 && tradingData.sellCount === 0) {
        reasons.push('No sells recorded despite many buys');
        suspiciousPattern = true;
      }
      
      // Abnormal buy/sell size ratio
      if (tradingData.avgBuySize > 0 && tradingData.avgSellSize > 0) {
        const sizeRatio = tradingData.avgSellSize / tradingData.avgBuySize;
        if (sizeRatio < 0.1) {
          reasons.push('Sell sizes much smaller than buys');
          suspiciousPattern = true;
        }
      }
    }
    
    // Very low liquidity compared to market cap
    if (marketData?.liquidity && marketData?.marketCap) {
      const liquidityRatio = marketData.liquidity / marketData.marketCap;
      if (liquidityRatio < 0.01) {
        reasons.push('Extremely low liquidity vs market cap');
      }
    }
    
    return {
      hasRisk: reasons.length >= 2 || suspiciousPattern,
      suspiciousPattern,
      reasons,
    };
  }

  /**
   * Check social presence
   */
  private async checkSocialPresence(mintAddress: string): Promise<{
    hasTwitter: boolean;
    hasTelegram: boolean;
    hasWebsite: boolean;
  }> {
    // V ideálním případě bychom fetchovali metadata z on-chain nebo API
    // Pro teď vracíme konzervativní defaults
    return {
      hasTwitter: false,
      hasTelegram: false,
      hasWebsite: false,
    };
  }

  /**
   * Get cached analysis
   */
  private async getCachedAnalysis(tokenId: string): Promise<TokenRiskAnalysis | null> {
    try {
      const { data, error } = await supabase
        .from('TokenRiskAnalysis')
        .select('*')
        .eq('tokenId', tokenId)
        .single();

      if (error || !data) return null;

      return {
        ...data,
        analyzedAt: new Date(data.analyzedAt),
        expiresAt: new Date(data.expiresAt),
        warnings: data.warnings || [],
      } as TokenRiskAnalysis;
    } catch (error) {
      return null;
    }
  }

  /**
   * Save analysis to DB
   */
  private async saveAnalysis(analysis: TokenRiskAnalysis): Promise<void> {
    try {
      await supabase
        .from('TokenRiskAnalysis')
        .upsert({
          id: generateId(),
          tokenId: analysis.tokenId,
          mintAddress: analysis.mintAddress,
          overallRiskScore: analysis.overallRiskScore,
          liquidityRiskScore: analysis.liquidityRiskScore,
          holderRiskScore: analysis.holderRiskScore,
          contractRiskScore: analysis.contractRiskScore,
          volumeRiskScore: analysis.volumeRiskScore,
          ageRiskScore: analysis.ageRiskScore,
          isRenounced: analysis.isRenounced,
          isMintable: analysis.isMintable,
          isFreezable: analysis.isFreezable,
          hasHoneypotRisk: analysis.hasHoneypotRisk,
          lpLocked: analysis.lpLocked,
          lpLockDays: analysis.lpLockDays,
          topHolderPercent: analysis.topHolderPercent,
          top10HolderPercent: analysis.top10HolderPercent,
          uniqueHolders: analysis.uniqueHolders,
          holderGrowthRate: analysis.holderGrowthRate,
          buyToSellRatio: analysis.buyToSellRatio,
          avgTradeSize: analysis.avgTradeSize,
          suspiciousTradingPattern: analysis.suspiciousTradingPattern,
          hasTwitter: analysis.hasTwitter,
          hasTelegram: analysis.hasTelegram,
          hasWebsite: analysis.hasWebsite,
          analyzedAt: analysis.analyzedAt.toISOString(),
          expiresAt: analysis.expiresAt.toISOString(),
        }, {
          onConflict: 'tokenId',
        });
    } catch (error: any) {
      console.warn('Failed to save token risk analysis:', error.message);
    }
  }

  /**
   * Get risk for signal evaluation
   */
  async getRiskForSignal(tokenId: string, mintAddress: string): Promise<{
    riskScore: number;
    riskLevel: string;
    warnings: string[];
    shouldSkip: boolean;
  }> {
    const analysis = await this.analyzeToken(tokenId, mintAddress);
    
    return {
      riskScore: analysis.overallRiskScore,
      riskLevel: analysis.riskLevel,
      warnings: analysis.warnings,
      shouldSkip: analysis.riskLevel === 'extreme' || analysis.hasHoneypotRisk,
    };
  }
}

