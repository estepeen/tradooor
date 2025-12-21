/**
 * Discord Notification Service
 * 
 * Posílá bohaté notifikace o signálech do Discordu pomocí webhooků.
 */

export interface SignalNotificationData {
  // Token info
  tokenSymbol: string;
  tokenMint: string;
  
  // Signal info
  signalType: string;
  strength: 'weak' | 'medium' | 'strong';
  walletCount: number;
  avgWalletScore: number;
  
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

  constructor() {
    this.webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
    this.enabled = !!this.webhookUrl;
    
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
      
      const embed = this.buildSignalEmbed(data);
      
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
  private buildSignalEmbed(data: SignalNotificationData): DiscordEmbed {
    const birdeyeUrl = `https://birdeye.so/token/${data.tokenMint}?chain=solana`;
    
    // Determine color based on AI decision or strength
    let color = COLORS.medium;
    if (data.aiDecision) {
      color = COLORS[data.aiDecision] || COLORS.medium;
    } else {
      color = COLORS[data.strength] || COLORS.medium;
    }

    // Build title with emoji based on signal type
    const signalEmoji = this.getSignalEmoji(data.signalType);
    const strengthEmoji = data.strength === 'strong' ? '🔥' : data.strength === 'medium' ? '⚡' : '💨';
    
    const title = `${signalEmoji} ${data.tokenSymbol} - ${data.signalType.toUpperCase()} Signal ${strengthEmoji}`;

    // Build fields
    const fields: DiscordEmbed['fields'] = [];

    // Signal Info
    fields.push({
      name: '📊 Signal',
      value: `**Type:** ${data.signalType}\n**Strength:** ${data.strength.toUpperCase()}\n**Wallets:** ${data.walletCount}`,
      inline: true,
    });

    // Price Info - use base token instead of $
    const baseToken = (data.baseToken || 'SOL').toUpperCase();
    console.log(`📨 [Discord] Building embed for ${data.tokenSymbol} - baseToken: ${baseToken}, wallets: ${data.wallets?.length || 0}, walletIds: ${data.wallets?.map(w => w.walletId ? 'yes' : 'no').join(',') || 'none'}`);
    const priceInfo = [`**Entry:** ${this.formatNumber(data.entryPriceUsd, 8)} ${baseToken}`];
    if (data.marketCapUsd) priceInfo.push(`**MCap:** ${this.formatNumber(data.marketCapUsd, 0)} ${baseToken}`);
    if (data.liquidityUsd) priceInfo.push(`**Liq:** ${this.formatNumber(data.liquidityUsd, 0)} ${baseToken}`);
    
    fields.push({
      name: '💰 Price & Market',
      value: priceInfo.join('\n'),
      inline: true,
    });

    // Token Info
    const tokenInfo = [];
    if (data.tokenAgeMinutes !== undefined) {
      const ageStr = data.tokenAgeMinutes >= 60 
        ? `${Math.round(data.tokenAgeMinutes / 60)}h` 
        : `${data.tokenAgeMinutes}m`;
      tokenInfo.push(`**Age:** ${ageStr}`);
    }
    if (data.volume24hUsd) tokenInfo.push(`**24h Vol:** ${this.formatNumber(data.volume24hUsd, 0)} ${baseToken}`);
    tokenInfo.push(`**Avg Score:** ${data.avgWalletScore.toFixed(0)}/100`);
    
    fields.push({
      name: '🪙 Token Info',
      value: tokenInfo.join('\n'),
      inline: true,
    });

    // AI Decision (if available) - only show if we have real AI decision
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

    // SL/TP (if available) - use base token instead of $
    // Only show if we have real AI decision values
    if (data.stopLossPercent && data.stopLossPercent > 0 && data.takeProfitPercent && data.takeProfitPercent > 0) {
      const sltp = [];
      if (data.stopLossPriceUsd && data.stopLossPercent) {
        sltp.push(`🛑 **SL:** ${this.formatNumber(data.stopLossPriceUsd, 8)} ${baseToken} (-${data.stopLossPercent}%)`);
      }
      if (data.takeProfitPriceUsd && data.takeProfitPercent) {
        sltp.push(`🎯 **TP:** ${this.formatNumber(data.takeProfitPriceUsd, 8)} ${baseToken} (+${data.takeProfitPercent}%)`);
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

    // Wallets with trade details (show all) - add profile links and use base token
    if (data.wallets && data.wallets.length > 0) {
      const frontendUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_API_URL || 'https://tradooor.stepanpanek.cz';
      const walletDetails = data.wallets.map((w) => {
        const name = w.label || `${w.address.substring(0, 6)}...`;
        
        // Create profile link if walletId is available, otherwise use address
        const profileUrl = w.walletId 
          ? `${frontendUrl}/wallets/${w.walletId}`
          : `${frontendUrl}/wallet/${w.address}`;
        const nameWithLink = `[**${name}**](${profileUrl})`;
        
        const parts = [nameWithLink];
        
        if (w.tradeAmountUsd) {
          parts.push(`${this.formatNumber(w.tradeAmountUsd, 2)} ${baseToken}`);
        }
        if (w.tradePrice) {
          parts.push(`@ ${this.formatNumber(w.tradePrice, 8)} ${baseToken}`);
        }
        if (w.tradeTime) {
          const time = new Date(w.tradeTime);
          const timeStr = time.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
          parts.push(`• ${timeStr}`);
        }
        
        return parts.join(' ');
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
        text: 'Tradooor • Click title to view on Birdeye',
      },
      timestamp: new Date().toISOString(),
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

