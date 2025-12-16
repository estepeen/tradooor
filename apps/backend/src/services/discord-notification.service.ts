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
  
  // Wallets
  wallets?: Array<{
    label?: string;
    address: string;
    score: number;
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
      const embed = this.buildSignalEmbed(data);
      
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

    // Price Info
    const priceInfo = [`**Entry:** $${this.formatNumber(data.entryPriceUsd, 8)}`];
    if (data.marketCapUsd) priceInfo.push(`**MCap:** $${this.formatNumber(data.marketCapUsd, 0)}`);
    if (data.liquidityUsd) priceInfo.push(`**Liq:** $${this.formatNumber(data.liquidityUsd, 0)}`);
    
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
    if (data.volume24hUsd) tokenInfo.push(`**24h Vol:** $${this.formatNumber(data.volume24hUsd, 0)}`);
    tokenInfo.push(`**Avg Score:** ${data.avgWalletScore.toFixed(0)}/100`);
    
    fields.push({
      name: '🪙 Token Info',
      value: tokenInfo.join('\n'),
      inline: true,
    });

    // AI Decision (if available)
    if (data.aiDecision) {
      const aiEmoji = data.aiDecision === 'buy' ? '✅' : data.aiDecision === 'skip' ? '⏭️' : '❌';
      const aiInfo = [
        `${aiEmoji} **Decision:** ${data.aiDecision.toUpperCase()}`,
        `**Confidence:** ${data.aiConfidence?.toFixed(0) || '-'}%`,
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
    }

    // SL/TP (if available)
    if (data.stopLossPercent || data.takeProfitPercent) {
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
    }

    // Wallets (if available, show top 3)
    if (data.wallets && data.wallets.length > 0) {
      const topWallets = data.wallets.slice(0, 3);
      const walletList = topWallets.map((w, i) => {
        const name = w.label || `${w.address.substring(0, 6)}...`;
        return `${i + 1}. **${name}** (${w.score}/100)`;
      }).join('\n');
      
      fields.push({
        name: '👛 Top Wallets',
        value: walletList,
        inline: true,
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
      'whale-entry': '🐋',
      'early-sniper': '🎯',
      'hot-token': '🔥',
      're-entry': '🔄',
      'momentum': '📈',
      'accumulation': '📦',
      'exit-warning': '⚠️',
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
        { label: 'Whale1', address: 'ABC123...', score: 92 },
        { label: 'Sniper', address: 'DEF456...', score: 85 },
        { address: 'GHI789...', score: 78 },
      ],
    };

    return this.sendSignalNotification(testData);
  }
}

