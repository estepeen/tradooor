/**
 * Discord Notification Service
 * 
 * Posílá bohaté notifikace o signálech do Discordu pomocí webhooků.
 */

import { SolPriceCacheService } from './sol-price-cache.service.js';

export interface SignalNotificationData {
  // Token info
  tokenSymbol: string;
  tokenMint: string;
  
  // Signal info
  signalType: string;
  strength: 'weak' | 'medium' | 'strong';
  walletCount: number;
  avgWalletScore: number;

  // Cluster info (for cluster-consensus signals)
  clusterStrength?: number; // 0-100 cluster strength score
  clusterPerformance?: number; // Historical success rate %

  // Prices
  entryPriceUsd: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  tokenAgeMinutes?: number;
  baseToken?: string; // Base token (SOL, USDC, etc.) - defaults to SOL
  
  // AI Decision
  aiDecision?: 'buy' | 'sell' | 'skip' | 'hold';
  aiConfidence?: number;
  aiReasoning?: string;
  aiPositionPercent?: number;
  stopLossPercent?: number;
  takeProfitPercent?: number;
  stopLossPriceUsd?: number;
  takeProfitPriceUsd?: number;
  aiRiskScore?: number;
  
  // Security (RugCheck)
  security?: {
    riskLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
    riskScore: number;
    isLpLocked: boolean;
    lpLockedPercent?: number;
    isDexPaid: boolean;
    isMintable: boolean;
    isFreezable: boolean;
    isHoneypot: boolean;
    honeypotReason?: string;
    buyTax?: number;
    sellTax?: number;
    hasDangerousTax: boolean;
    risks: string[];
  };
  
  // Wallets with trade details
  wallets?: Array<{
    label?: string;
    address: string;
    walletId?: string; // Wallet ID for profile link
    score: number;
    tradeAmountUsd?: number;
    tradePrice?: number;
    tradeTime?: string;
    marketCapUsd?: number; // Market cap v době trade (pro consensus/conviction signals)
    // Pro accumulation signál: všechny nákupy tradera
    accumulationBuys?: Array<{
      amountBase: number;
      timestamp: string;
      marketCapUsd?: number; // Market cap v době nákupu
    }>;
  }>;
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  footer?: {
    text: string;
    icon_url?: string;
  };
  timestamp?: string;
  thumbnail?: {
    url: string;
  };
}

interface DiscordWebhookPayload {
  content?: string;
  username?: string;
  avatar_url?: string;
  embeds?: DiscordEmbed[];
}

// Colors for different signal types/decisions
const COLORS = {
  buy: 0x00ff00,      // Green
  sell: 0xff0000,     // Red  
  skip: 0x808080,     // Gray
  hold: 0xffff00,     // Yellow
  strong: 0x00ff00,   // Green
  medium: 0xffa500,   // Orange
  weak: 0xff6347,     // Tomato
};

export class DiscordNotificationService {
  private webhookUrl: string;
  private enabled: boolean;
  private solPriceCacheService: SolPriceCacheService;

  constructor() {
    this.webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
    this.enabled = !!this.webhookUrl;
    this.solPriceCacheService = new SolPriceCacheService();
    
    if (!this.enabled) {
      console.warn('⚠️  Discord notifications disabled: DISCORD_WEBHOOK_URL not set');
    }
  }

  /**
   * Pošle notifikaci o novém signálu
   */
  async sendSignalNotification(data: SignalNotificationData): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      // Debug: Log what we're sending
      console.log(`📨 [Discord] sendSignalNotification called - baseToken: ${data.baseToken || 'MISSING'}, walletIds: ${data.wallets?.map(w => w.walletId ? 'yes' : 'no').join(',') || 'none'}, aiDecision: ${data.aiDecision || 'undefined'}, aiConfidence: ${data.aiConfidence || 'undefined'}`);
      
      const embed = await this.buildSignalEmbed(data);
      
      // Debug: Log embed content
      const tradersField = embed.fields?.find(f => f.name.includes('Traders'));
      console.log(`📨 [Discord] Embed built - title: ${embed.title}, fields: ${embed.fields?.length || 0}, traders field: ${tradersField ? tradersField.value.substring(0, 100) + '...' : 'none'}`);
      
      const payload: DiscordWebhookPayload = {
        username: 'Tradooor Signals',
        embeds: [embed],
      };

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Discord webhook error: ${response.status} - ${errorText}`);
        return false;
      }

      console.log(`📨 Discord notification sent for ${data.tokenSymbol}`);
      return true;
    } catch (error: any) {
      console.error(`❌ Failed to send Discord notification: ${error.message}`);
      return false;
    }
  }

  /**
   * Vytvoří embed pro signál
   */
  private async buildSignalEmbed(data: SignalNotificationData): Promise<DiscordEmbed> {
    const birdeyeUrl = `https://birdeye.so/token/${data.tokenMint}?chain=solana`;
    const baseToken = (data.baseToken || 'SOL').toUpperCase();

    // Entry MCap label for title / trader line
    const entryMcapLabel = data.marketCapUsd
      ? `$${this.formatNumber(data.marketCapUsd, 0)}`
      : 'n/a';

    // Determine color based on high-level signal type (bar color on the left)
    let color: number;
    if (data.signalType === 'accumulation') {
      // Accumulation → oranžovo-žlutá čára (méně křiklavá než čistá žlutá)
      color = 0xffc107;
    } else if (data.signalType === 'cluster-consensus') {
      // 💎💎 CLUSTER → modrá čára (stejná jako consensus)
      color = 0x0099ff;
    } else if (data.signalType === 'consensus' || data.signalType === 'consensus-update') {
      // Consensus → modrá čára
      color = 0x0099ff;
    } else if (
      data.signalType === 'whale-entry' ||
      data.signalType === 'conviction-buy' ||
      data.signalType === 'large-position'
    ) {
      // Conviction / whale → červená čára
      color = 0xff0000;
    } else if (data.aiDecision) {
      // Fallback: podle AI rozhodnutí
      color = COLORS[data.aiDecision] || COLORS[data.strength] || COLORS.medium;
    } else {
      // Fallback: podle síly signálu
      color = COLORS[data.strength] || COLORS.medium;
    }

    // Build title podle typu signálu
    let title: string;
    if (data.signalType === 'accumulation') {
      title = `⚡ ACCUMULATION Signal – ${data.tokenSymbol} @ ${entryMcapLabel}`;
    } else if (data.signalType === 'cluster-consensus') {
      title = `💎💎 CLUSTER Signal – ${data.tokenSymbol} @ ${entryMcapLabel}`;
    } else if (data.signalType === 'consensus' || data.signalType === 'consensus-update') {
      title = `💎 CONSENSUS Signal – ${data.tokenSymbol} @ ${entryMcapLabel}`;
    } else if (
      data.signalType === 'whale-entry' ||
      data.signalType === 'conviction-buy' ||
      data.signalType === 'large-position'
    ) {
      title = `🔥 CONVICTION Signal – ${data.tokenSymbol} @ ${entryMcapLabel}`;
    } else {
      // Ostatní typy necháme v původním formátu
      const signalEmoji = this.getSignalEmoji(data.signalType);
      const strengthEmoji =
        data.strength === 'strong' ? '🔥' : data.strength === 'medium' ? '⚡' : '💨';
      title = `${signalEmoji} ${data.tokenSymbol} - ${data.signalType.toUpperCase()} Signal ${strengthEmoji}`;
    }

    // Build fields
    const fields: DiscordEmbed['fields'] = [];

    // Signal Info
    const signalInfo = [
      `**Type:** ${data.signalType}`,
      `**Strength:** ${data.strength.toUpperCase()}`,
      `**Wallets:** ${data.walletCount}`,
    ];

    // Add cluster info if this is a cluster signal
    if (data.signalType === 'cluster-consensus' && data.clusterStrength) {
      signalInfo.push(`**Cluster:** ${data.clusterStrength}/100`);
      if (data.clusterPerformance !== undefined) {
        signalInfo.push(`**Success:** ${data.clusterPerformance}%`);
      }
    }

    fields.push({
      name: '📊 Signal',
      value: signalInfo.join('\n'),
      inline: true,
    });

    // Token Info - sloučené Price & Market + Token Info do jedné sekce
    console.log(`📨 [Discord] Building embed for ${data.tokenSymbol} - baseToken: ${baseToken}, wallets: ${data.wallets?.length || 0}, walletIds: ${data.wallets?.map(w => w.walletId ? 'yes' : 'no').join(',') || 'none'}`);
    const tokenInfo = [];

    // Market Cap (Entry)
    if (data.marketCapUsd) {
      tokenInfo.push(`**MCap:** $${this.formatNumber(data.marketCapUsd, 0)}`);
    }

    // Liquidity
    if (data.liquidityUsd) {
      tokenInfo.push(`**Liq:** $${this.formatNumber(data.liquidityUsd, 0)}`);
    }

    // 24h Volume
    if (data.volume24hUsd) {
      tokenInfo.push(`**24h Vol:** $${this.formatNumber(data.volume24hUsd, 0)}`);
    }

    // Token Age
    if (data.tokenAgeMinutes !== undefined) {
      const ageStr = data.tokenAgeMinutes >= 60
        ? `${Math.round(data.tokenAgeMinutes / 60)}h`
        : `${data.tokenAgeMinutes}m`;
      tokenInfo.push(`**Age:** ${ageStr}`);
    }

    fields.push({
      name: '🪙 Token Info',
      value: tokenInfo.join('\n'),
      inline: true,
    });

    // AI Decision (if available) - show if we have AI decision (including fallback when rate limited)
    if (data.aiDecision && data.aiConfidence !== undefined && data.aiConfidence > 0) {
      const aiEmoji = data.aiDecision === 'buy' ? '✅' : data.aiDecision === 'skip' ? '⏭️' : '❌';
      const aiInfo = [
        `${aiEmoji} **Decision:** ${data.aiDecision.toUpperCase()}`,
        `**Confidence:** ${data.aiConfidence.toFixed(0)}%`,
      ];
      
      if (data.aiPositionPercent) {
        aiInfo.push(`**Position:** ${data.aiPositionPercent}%`);
      }
      if (data.aiRiskScore) {
        const riskEmoji = data.aiRiskScore <= 3 ? '🟢' : data.aiRiskScore <= 6 ? '🟡' : '🔴';
        aiInfo.push(`${riskEmoji} **Risk:** ${data.aiRiskScore}/10`);
      }

      fields.push({
        name: '🤖 AI Analysis',
        value: aiInfo.join('\n'),
        inline: true,
      });
    } else {
      // Show "-" if AI is not available
      fields.push({
        name: '🤖 AI Analysis',
        value: `**Decision:** -\n**Confidence:** -\n**Position:** -\n**Risk:** -`,
        inline: true,
      });
    }

    // SL/TP (if available) - show in USD
    // Only show if we have real AI decision values
    if (data.stopLossPercent && data.stopLossPercent > 0 && data.takeProfitPercent && data.takeProfitPercent > 0) {
      const sltp = [];
      if (data.stopLossPriceUsd && data.stopLossPercent) {
        sltp.push(`🛑 **SL:** $${this.formatNumber(data.stopLossPriceUsd, 8)} (-${data.stopLossPercent}%)`);
      }
      if (data.takeProfitPriceUsd && data.takeProfitPercent) {
        sltp.push(`🎯 **TP:** $${this.formatNumber(data.takeProfitPriceUsd, 8)} (+${data.takeProfitPercent}%)`);
      }
      
      if (sltp.length > 0) {
        fields.push({
          name: '📈 Exit Strategy',
          value: sltp.join('\n'),
          inline: true,
        });
      }
    } else {
      // Show "-" if AI is not available
      fields.push({
        name: '📈 Exit Strategy',
        value: `🛑 **SL:** -\n🎯 **TP:** -`,
        inline: true,
      });
    }

    // Security (RugCheck)
    if (data.security) {
      const sec = data.security;
      
      // 🍯 HONEYPOT CHECK FIRST - CRITICAL!
      if (sec.isHoneypot) {
        fields.push({
          name: '🚨🍯 HONEYPOT DETECTED',
          value: `**⛔ DO NOT BUY!**\n${sec.honeypotReason || 'Cannot sell this token'}`,
          inline: false,
        });
        // Don't show other security info for honeypot
      } else {
        const riskEmoji = {
          'safe': '✅',
          'low': '🟢',
          'medium': '🟡',
          'high': '🟠',
          'critical': '🔴',
        }[sec.riskLevel] || '❓';

        const securityLines = [
          `${riskEmoji} **Risk:** ${sec.riskLevel.toUpperCase()} (${sec.riskScore}/100)`,
        ];

        // 💸 TAX INFO
        if (sec.buyTax !== undefined || sec.sellTax !== undefined) {
          const taxParts = [];
          if (sec.buyTax !== undefined) {
            const buyEmoji = sec.buyTax > 10 ? '⚠️' : '';
            taxParts.push(`Buy: ${buyEmoji}${sec.buyTax}%`);
          }
          if (sec.sellTax !== undefined) {
            const sellEmoji = sec.sellTax > 10 ? '⚠️' : '';
            taxParts.push(`Sell: ${sellEmoji}${sec.sellTax}%`);
          }
          securityLines.push(`💸 Tax: ${taxParts.join(' | ')}`);
        }

        // Flags
        const flags = [];
        if (sec.isLpLocked) flags.push(`🔒 LP ${sec.lpLockedPercent ? `${sec.lpLockedPercent.toFixed(0)}%` : 'Locked'}`);
        if (sec.isDexPaid) flags.push('💰 DEX Paid');
        if (!sec.isMintable) flags.push('✅ Mint Off');
        if (!sec.isFreezable) flags.push('✅ No Freeze');
        
        if (flags.length > 0) {
          securityLines.push(flags.join(' • '));
        }

        // Top risks (excluding tax which is shown above)
        const otherRisks = (sec.risks || []).filter((r: string) => !r.toLowerCase().includes('tax'));
        if (otherRisks.length > 0) {
          securityLines.push(`⚠️ ${otherRisks.slice(0, 2).join(', ')}`);
        }

        fields.push({
          name: '🛡️ Security',
          value: securityLines.join('\n'),
          inline: true,
        });
      }
    }

    // Wallets with trade details (show all) - add profile links
    if (data.wallets && data.wallets.length > 0) {
      const frontendUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_API_URL || 'https://tradooor.stepanpanek.cz';
      
      // Získej SOL cenu pro přepočet na USD
      let solPriceUsd = 150.0; // Fallback
      try {
        solPriceUsd = await this.solPriceCacheService.getCurrentSolPrice();
      } catch (error: any) {
        console.warn(`⚠️  Failed to fetch SOL price for Discord notification, using fallback: $${solPriceUsd}`);
      }
      
      // Sort wallets by trade time (oldest first)
      const sortedWallets = [...data.wallets].sort((a, b) => {
        const timeA = a.tradeTime ? new Date(a.tradeTime).getTime() : 0;
        const timeB = b.tradeTime ? new Date(b.tradeTime).getTime() : 0;
        return timeA - timeB;
      });

      const walletDetails = sortedWallets.map((w) => {
        const name = w.label || `${w.address.substring(0, 6)}...`;
        
        // Prefer URL s reálnou wallet address (přehlednější než interní ID)
        const profileUrl = `${frontendUrl}/wallet/${w.address}`;
        const nameWithLink = `[**${name}**](${profileUrl})`;
        
        // Pro accumulation signál: zobraz jméno a pod ním všechny nákupy (jako u consensus)
        if (data.signalType === 'accumulation' && w.accumulationBuys && w.accumulationBuys.length > 0) {
          const buys = w.accumulationBuys;
          const buyLines = buys.map(buy => {
            const amountBase = buy.amountBase;
            const amountUsd = amountBase * solPriceUsd;
            const parts = [`${this.formatNumber(amountBase, 2)} ${baseToken} ($${this.formatNumber(amountUsd, 0)})`];
            
            // Market cap a čas pro každý nákup - použij market cap z doby nákupu, pokud je k dispozici
            // Pokud není k dispozici, nezobrazujeme ho (ne fallback na globální)
            if (buy.marketCapUsd) {
              parts.push(`@ $${this.formatNumber(buy.marketCapUsd, 0)} MCap`);
            } else {
              parts.push(`@ - MCap`); // Zobraz mínus, pokud data nejsou k dispozici
            }
            if (buy.timestamp) {
              const time = new Date(buy.timestamp);
              const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
              parts.push(`• ${timeStr}`);
            }
            
            return parts.join(' ');
          });
          
          // Jméno na prvním řádku, pak všechny nákupy pod sebou
          return [nameWithLink, ...buyLines].join('\n');
        } else {
          // Pro ostatní signály: zobraz jen aktuální trade (stejný formát jako consensus)
        const parts = [nameWithLink];
        
          // Velikost obchodu v base tokenu (např. SOL) + USD hodnota
          // POZOR: tradeAmountUsd je ve skutečnosti v SOL (název je zavádějící)
        if (w.tradeAmountUsd) {
            const amountBase = w.tradeAmountUsd; // Ve skutečnosti v SOL
            const amountUsd = amountBase * solPriceUsd; // Přepočet na USD
            parts.push(`${this.formatNumber(amountBase, 2)} ${baseToken} ($${this.formatNumber(amountUsd, 0)})`);
        }
          
          // Za @ chceme zobrazit MarketCap - použij market cap z doby trade, pokud je k dispozici
          // Pokud není k dispozici, zobrazíme mínus (ne fallback na globální)
          if (w.marketCapUsd) {
            parts.push(`@ $${this.formatNumber(w.marketCapUsd, 0)} MCap`);
          } else {
            parts.push(`@ - MCap`); // Zobraz mínus, pokud data nejsou k dispozici
          }
        if (w.tradeTime) {
          const time = new Date(w.tradeTime);
            const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
          parts.push(`• ${timeStr}`);
        }
        
        return parts.join(' ');
        }
      }).join('\n');
      
      fields.push({
        name: '👛 Traders',
        value: walletDetails || 'No wallet data',
        inline: false,
      });
    }

    // AI Reasoning (if available)
    if (data.aiReasoning) {
      fields.push({
        name: '💭 AI Reasoning',
        value: data.aiReasoning.length > 200 
          ? data.aiReasoning.substring(0, 200) + '...' 
          : data.aiReasoning,
        inline: false,
      });
    }

    return {
      title,
      url: birdeyeUrl,
      color,
      fields,
      footer: {
        text: (() => {
          const now = new Date();
          const day = String(now.getDate()).padStart(2, '0');
          const month = String(now.getMonth() + 1).padStart(2, '0');
          const year = now.getFullYear();
          const hours = String(now.getHours()).padStart(2, '0');
          const minutes = String(now.getMinutes()).padStart(2, '0');
          return `⚡ Powered by STPNGPT • ${day}/${month}/${year}, ${hours}:${minutes}`;
        })(),
      },
    };
  }

  /**
   * Emoji pro typ signálu
   */
  private getSignalEmoji(signalType: string): string {
    const emojis: Record<string, string> = {
      'consensus': '🤝',
      'consensus-update': '📈',
      'whale-entry': '🐋',
      'early-sniper': '🎯',
      'hot-token': '🔥',
      're-entry': '🔄',
      'momentum': '📈',
      'accumulation': '📦',
      'exit-warning': '⚠️',
      'conviction-buy': '💪',
      'volume-spike': '📊',
      'large-position': '💰',
    };
    return emojis[signalType] || '📊';
  }

  /**
   * Formátuje číslo
   */
  private formatNumber(value: number, decimals: number): string {
    if (value >= 1_000_000) {
      return (value / 1_000_000).toFixed(2) + 'M';
    }
    if (value >= 1_000) {
      return (value / 1_000).toFixed(2) + 'K';
    }
    return value.toFixed(decimals);
  }

  /**
   * Pošle testovací notifikaci
   */
  async sendTestNotification(): Promise<boolean> {
    if (!this.enabled) {
      console.error('Discord notifications not enabled');
      return false;
    }

    const testData: SignalNotificationData = {
      tokenSymbol: 'TEST',
      tokenMint: 'So11111111111111111111111111111111111111112',
      signalType: 'consensus',
      strength: 'strong',
      walletCount: 3,
      avgWalletScore: 85,
      entryPriceUsd: 0.000001234,
      marketCapUsd: 150000,
      liquidityUsd: 25000,
      volume24hUsd: 50000,
      tokenAgeMinutes: 45,
      aiDecision: 'buy',
      aiConfidence: 78,
      aiReasoning: 'Strong consensus from 3 high-quality wallets with good track records. Token has healthy liquidity and reasonable market cap.',
      aiPositionPercent: 10,
      stopLossPercent: 20,
      takeProfitPercent: 100,
      stopLossPriceUsd: 0.000000987,
      takeProfitPriceUsd: 0.000002468,
      aiRiskScore: 4,
      wallets: [
        { label: 'Whale1', address: 'ABC123...', score: 92, tradeAmountUsd: 520, tradePrice: 0.000001234, tradeTime: new Date(Date.now() - 5 * 60000).toISOString() },
        { label: 'Sniper', address: 'DEF456...', score: 85, tradeAmountUsd: 380, tradePrice: 0.000001156, tradeTime: new Date(Date.now() - 15 * 60000).toISOString() },
        { address: 'GHI789...', score: 78, tradeAmountUsd: 210, tradePrice: 0.000001089, tradeTime: new Date(Date.now() - 25 * 60000).toISOString() },
      ],
    };

    return this.sendSignalNotification(testData);
  }
}

