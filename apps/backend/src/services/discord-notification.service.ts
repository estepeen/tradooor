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
  signalStrength?: string; // Detailed signal strength reasoning (wallet tiers + patterns)
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
  
  // Holder Analysis (pump.fun)
  holderAnalysis?: {
    top10HolderPercent: number;
    topHolderPercent: number;
    totalHolders: number;
    isConcentrated: boolean;
    creatorAddress?: string;
    creatorHasSold: boolean;
    creatorSellPercent: number;
  };

  // Learning Insights (historical performance)
  learningInsights?: {
    totalBonus: number;
    walletComboBonus: number;
    mcapRangeBonus: number;
    timeWindowBonus: number;
    reasoning: string[];
  };

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
    // Pro conviction signál: průměrná velikost nákupu a multiplier
    avgTradeSize?: number; // Průměrná velikost nákupu v base tokenu
    convictionMultiplier?: number; // Kolikrát větší je tento trade oproti průměru
    // Pro accumulation signál: všechny nákupy tradera
    accumulationBuys?: Array<{
      amountBase: number;
      timestamp: string;
      marketCapUsd?: number; // Market cap v době nákupu
    }>;
  }>;

}

/**
 * Data pro SPECTRE trade notifikaci
 */
export interface SpectreTradeNotificationData {
  action: 'buy' | 'sell';
  success: boolean;
  tokenSymbol: string;
  tokenMint: string;
  amountSol: number;
  amountTokens?: number;
  txSignature?: string;
  error?: string;
  // Signal context
  signalType?: string;
  signalStrength?: string;
  signalTimestamp: string; // ISO timestamp when signal was generated
  signalMarketCapUsd?: number;
  // Trade context
  tradeTimestamp: string; // ISO timestamp when trade was executed
  tradeMarketCapUsd?: number;
  latencyMs: number;
  // For BUY: entry price
  entryPriceUsd?: number;
  // For SELL: exit info
  exitPriceUsd?: number;
  exitReason?: 'stop_loss' | 'take_profit' | 'manual';
  pnlUsd?: number;
  pnlPercent?: number;
  // Position settings
  stopLossPercent?: number;
  takeProfitPercent?: number;
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
  private exitWebhookUrl: string;
  private enabled: boolean;
  private exitEnabled: boolean;
  private solPriceCacheService: SolPriceCacheService;

  constructor() {
    this.webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
    this.exitWebhookUrl = process.env.DISCORD_EXIT_WEBHOOK_URL || '';
    this.enabled = !!this.webhookUrl;
    this.exitEnabled = !!this.exitWebhookUrl;
    this.solPriceCacheService = new SolPriceCacheService();

    if (!this.enabled) {
      console.warn('⚠️  Discord notifications disabled: DISCORD_WEBHOOK_URL not set');
    }
    if (!this.exitEnabled) {
      console.warn('⚠️  Discord exit notifications disabled: DISCORD_EXIT_WEBHOOK_URL not set');
    }
  }

  /**
   * Pošle notifikaci o novém signálu
   * Returns message ID for later editing (async AI update)
   */
  async sendSignalNotification(data: SignalNotificationData): Promise<{ success: boolean; messageId?: string }> {
    if (!this.enabled) {
      return { success: false };
    }

    try {
      // Debug: Log what we're sending
      console.log(`📨 [Discord] sendSignalNotification called - baseToken: ${data.baseToken || 'MISSING'}, walletIds: ${data.wallets?.map(w => w.walletId ? 'yes' : 'no').join(',') || 'none'}, aiDecision: ${data.aiDecision || 'undefined'}, aiConfidence: ${data.aiConfidence || 'undefined'}`);

      const embed = await this.buildSignalEmbed(data);

      // Debug: Log embed content
      const tradersField = embed.fields?.find(f => f.name.includes('Traders'));
      console.log(`📨 [Discord] Embed built - title: ${embed.title}, fields: ${embed.fields?.length || 0}, traders field: ${tradersField ? tradersField.value.substring(0, 100) + '...' : 'none'}`);

      const payload: DiscordWebhookPayload = {
        username: 'Spectre',
        embeds: [embed],
      };

      // Use ?wait=true to get message ID for later editing
      const response = await fetch(`${this.webhookUrl}?wait=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Discord webhook error: ${response.status} - ${errorText}`);
        return { success: false };
      }

      // Parse response to get message ID
      const responseData = await response.json() as { id: string };
      const messageId = responseData.id;

      console.log(`📨 Discord notification sent for ${data.tokenSymbol} (messageId: ${messageId || 'none'})`);
      return { success: true, messageId };
    } catch (error: any) {
      console.error(`❌ Failed to send Discord notification: ${error.message}`);
      return { success: false };
    }
  }

  /**
   * Aktualizuje existující Discord zprávu s AI analýzou
   * Používá se pro asynchronní AI - signál se pošle hned, AI se doplní později
   */
  async updateSignalWithAI(
    messageId: string,
    originalData: SignalNotificationData,
    aiData: {
      aiDecision: string;
      aiConfidence: number;
      aiPositionPercent?: number;
      aiRiskScore?: number;
      stopLossPercent?: number;
      takeProfitPercent?: number;
      aiReasoning?: string;
    }
  ): Promise<boolean> {
    if (!this.enabled || !messageId) {
      return false;
    }

    try {
      // Merge AI data into original data
      const updatedData: SignalNotificationData = {
        ...originalData,
        aiDecision: aiData.aiDecision as any,
        aiConfidence: aiData.aiConfidence,
        aiPositionPercent: aiData.aiPositionPercent,
        aiRiskScore: aiData.aiRiskScore,
        stopLossPercent: aiData.stopLossPercent,
        takeProfitPercent: aiData.takeProfitPercent,
        aiReasoning: aiData.aiReasoning,
      };

      // Rebuild embed with AI data
      const embed = await this.buildSignalEmbed(updatedData);

      const payload: DiscordWebhookPayload = {
        embeds: [embed],
      };

      // Extract webhook ID and token from URL for PATCH request
      // URL format: https://discord.com/api/webhooks/{webhook_id}/{webhook_token}
      const urlParts = this.webhookUrl.match(/\/webhooks\/(\d+)\/([^/?]+)/);
      if (!urlParts) {
        console.error('❌ Could not parse webhook URL for message edit');
        return false;
      }

      const [, webhookId, webhookToken] = urlParts;
      const editUrl = `https://discord.com/api/webhooks/${webhookId}/${webhookToken}/messages/${messageId}`;

      const response = await fetch(editUrl, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Discord message edit error: ${response.status} - ${errorText}`);
        return false;
      }

      console.log(`📨 Discord message updated with AI for ${originalData.tokenSymbol} (messageId: ${messageId})`);
      return true;
    } catch (error: any) {
      console.error(`❌ Failed to update Discord message with AI: ${error.message}`);
      return false;
    }
  }


  /**
   * Vytvoří embed pro signál
   */
  private async buildSignalEmbed(data: SignalNotificationData): Promise<DiscordEmbed> {
    const gmgnUrl = `https://gmgn.ai/sol/token/${data.tokenMint}`;
    const baseToken = (data.baseToken || 'SOL').toUpperCase();

    // Entry MCap label for title / trader line
    const entryMcapLabel = data.marketCapUsd
      ? `$${this.formatNumber(data.marketCapUsd, 0)}`
      : 'n/a';

    // Determine color based on high-level signal type (bar color on the left)
    let color: number;
    if (data.signalType === 'ninja') {
      // 🥷 NINJA → fialová čára (micro-cap fast consensus)
      color = 0x8b5cf6;
    } else if (data.signalType === 'accumulation') {
      // Accumulation → zelená čára
      color = 0x00ff00;
    } else if (data.signalType === 'cluster') {
      // 💎 CLUSTER → tmavě modrá čára
      color = 0x1e3a8a;
    } else if (data.signalType === 'consensus' || data.signalType === 'consensus-update') {
      // Consensus → modrá čára
      color = 0x0099ff;
    } else if (
      data.signalType === 'whale-entry' ||
      data.signalType === 'conviction-buy' ||
      data.signalType === 'large-position'
    ) {
      // Conviction / whale → oranžová čára
      color = 0xff9500;
    } else if (data.aiDecision) {
      // Fallback: podle AI rozhodnutí
      color = COLORS[data.aiDecision] || COLORS[data.strength] || COLORS.medium;
    } else {
      // Fallback: podle síly signálu
      color = COLORS[data.strength] || COLORS.medium;
    }

    // Calculate entry MCap from the LATEST trader's buy (the one that triggered the signal)
    // Entry = MCap when signal was triggered (newest trade), not first trade
    let entryMcapFromTraders: number | null = null;
    if (data.wallets && data.wallets.length > 0) {
      // For accumulation signals, get MCap from LAST (newest) accumulationBuys entry
      if (data.signalType === 'accumulation') {
        for (const wallet of data.wallets) {
          if (wallet.accumulationBuys && wallet.accumulationBuys.length > 0) {
            // Sort by timestamp DESC and get last buy's MCap (the one that triggered signal)
            const sortedBuys = [...wallet.accumulationBuys]
              .filter(b => b.timestamp && b.marketCapUsd)
              .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            if (sortedBuys.length > 0 && sortedBuys[0].marketCapUsd) {
              entryMcapFromTraders = sortedBuys[0].marketCapUsd;
              break;
            }
          }
        }
      } else {
        // For other signals, sort by trade time DESC and get newest trader's MCap
        const sortedByTime = [...data.wallets]
          .filter(w => w.tradeTime && w.marketCapUsd)
          .sort((a, b) => new Date(b.tradeTime!).getTime() - new Date(a.tradeTime!).getTime());

        if (sortedByTime.length > 0) {
          entryMcapFromTraders = sortedByTime[0].marketCapUsd!;
        }
      }
    }

    // Use entry MCap from traders if available, otherwise fall back to data.marketCapUsd
    const displayMcap = entryMcapFromTraders || data.marketCapUsd;
    const entryMcapLabelForTitle = displayMcap
      ? `$${this.formatNumber(displayMcap, 0)}`
      : 'n/a';

    // Token symbol with $ prefix (like ticker)
    const tokenTicker = `$${data.tokenSymbol}`;

    // Build title podle typu signálu
    let title: string;
    if (data.signalType === 'ninja') {
      title = `🥷 NINJA Signal – ${tokenTicker} @ ${entryMcapLabelForTitle}`;
    } else if (data.signalType === 'accumulation') {
      title = `⚡ ACCUMULATION Signal – ${tokenTicker} @ ${entryMcapLabelForTitle}`;
    } else if (data.signalType === 'cluster') {
      title = `💎 CLUSTER Signal – ${tokenTicker} @ ${entryMcapLabelForTitle}`;
    } else if (data.signalType === 'consensus' || data.signalType === 'consensus-update') {
      title = `💎 CONSENSUS Signal – ${tokenTicker} @ ${entryMcapLabelForTitle}`;
    } else if (
      data.signalType === 'whale-entry' ||
      data.signalType === 'conviction-buy' ||
      data.signalType === 'large-position'
    ) {
      title = `🔥 CONVICTION Signal – ${tokenTicker} @ ${entryMcapLabelForTitle}`;
    } else {
      // Ostatní typy necháme v původním formátu
      const signalEmoji = this.getSignalEmoji(data.signalType);
      const strengthEmoji =
        data.strength === 'strong' ? '🔥' : data.strength === 'medium' ? '⚡' : '💨';
      title = `${signalEmoji} ${tokenTicker} - ${data.signalType.toUpperCase()} Signal ${strengthEmoji}`;
    }

    // Build fields
    const fields: DiscordEmbed['fields'] = [];

    // 1. Signal Info
    const signalInfo = [
      `**Type:** ${data.signalType}`,
      `**Strength:** ${data.strength.toUpperCase()}`,
      `**Wallets:** ${data.walletCount}`,
    ];

    // Add cluster info if this is a cluster signal
    if (data.signalType === 'cluster' && data.clusterStrength) {
      signalInfo.push(`**Cluster Strength:** ${data.clusterStrength}/100`);
      if (data.clusterPerformance !== undefined) {
        signalInfo.push(`**Historical Success:** ${data.clusterPerformance}%`);
      }
    }

    fields.push({
      name: '📊 Signal',
      value: signalInfo.join('\n'),
      inline: true,
    });

    // Add detailed signal strength breakdown if available (wallet tiers + patterns)
    if (data.signalStrength) {
      fields.push({
        name: '🎯 Signal Quality',
        value: data.signalStrength,
        inline: false,
      });
    }

    // 2. Token Info
    const tokenInfo = [];

    // Show entry MCap (from trader's buy) - this is what's in the title
    if (displayMcap) {
      tokenInfo.push(`**MCap (Entry):** $${this.formatNumber(displayMcap, 0)}`);
    }

    // Show current MCap if different from entry (helps judge if you're late)
    if (data.marketCapUsd && entryMcapFromTraders && data.marketCapUsd !== entryMcapFromTraders) {
      const pumpPercent = ((data.marketCapUsd - entryMcapFromTraders) / entryMcapFromTraders * 100).toFixed(0);
      tokenInfo.push(`**MCap (Now):** $${this.formatNumber(data.marketCapUsd, 0)} (${Number(pumpPercent) >= 0 ? '+' : ''}${pumpPercent}%)`);
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

    // 2b. Holder Analysis (if available from pump.fun)
    if (data.holderAnalysis) {
      const holderInfo: string[] = [];

      // Top 10 concentration with warning indicator
      const concentrationEmoji = data.holderAnalysis.isConcentrated ? '⚠️' : '✅';
      holderInfo.push(`${concentrationEmoji} **Top 10:** ${data.holderAnalysis.top10HolderPercent.toFixed(1)}%`);
      holderInfo.push(`**Top 1:** ${data.holderAnalysis.topHolderPercent.toFixed(1)}%`);
      holderInfo.push(`**Holders:** ${data.holderAnalysis.totalHolders}`);

      // Dev wallet status
      if (data.holderAnalysis.creatorHasSold) {
        holderInfo.push(`⚠️ **Dev Sold:** ${data.holderAnalysis.creatorSellPercent.toFixed(1)}%`);
      } else {
        holderInfo.push(`✅ **Dev:** Holding`);
      }

      fields.push({
        name: '👥 Holder Distribution',
        value: holderInfo.join('\n'),
        inline: true,
      });
    }

    // 2c. Learning Insights (if available and meaningful)
    if (data.learningInsights && data.learningInsights.totalBonus !== 0) {
      const learningInfo: string[] = [];

      const bonusEmoji = data.learningInsights.totalBonus > 0 ? '🧠' : '⚠️';
      const bonusSign = data.learningInsights.totalBonus > 0 ? '+' : '';
      learningInfo.push(`${bonusEmoji} **Adj:** ${bonusSign}${data.learningInsights.totalBonus} pts`);

      // Show breakdown if significant
      if (data.learningInsights.walletComboBonus !== 0) {
        learningInfo.push(`Wallet: ${data.learningInsights.walletComboBonus > 0 ? '+' : ''}${data.learningInsights.walletComboBonus}`);
      }
      if (data.learningInsights.mcapRangeBonus !== 0) {
        learningInfo.push(`MCap: ${data.learningInsights.mcapRangeBonus > 0 ? '+' : ''}${data.learningInsights.mcapRangeBonus}`);
      }

      fields.push({
        name: '📚 Historical',
        value: learningInfo.join('\n'),
        inline: true,
      });
    }

    // 3. Strategy - Use AI values if available, otherwise defaults
    // Calculate SL/TP based on entry MCap from traders (not current MCap)
    const slPercent = data.stopLossPercent && data.stopLossPercent > 0 ? data.stopLossPercent : 20;
    const tpPercent = data.takeProfitPercent && data.takeProfitPercent > 0 ? data.takeProfitPercent : 50;

    const strategyLines = [];
    if (displayMcap) {
      const slMcap = displayMcap * (1 - slPercent / 100);
      const tpMcap = displayMcap * (1 + tpPercent / 100);
      strategyLines.push(`**SL:** $${this.formatNumber(slMcap, 0)} (-${slPercent}%) 🛑`);
      strategyLines.push(`**TP:** $${this.formatNumber(tpMcap, 0)} (+${tpPercent}%) 🎯`);
    } else {
      strategyLines.push(`**SL:** -${slPercent}% 🛑`);
      strategyLines.push(`**TP:** +${tpPercent}% 🎯`);
    }

    fields.push({
      name: '📈 Strategy',
      value: strategyLines.join('\n'),
      inline: true,
    });

    // Separator before Traders section
    fields.push({
      name: '\u200B', // Zero-width space
      value: '───────────────────────────',
      inline: false,
    });

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
        // Add score after name, e.g. "Spuno [80]"
        const scoreStr = w.score ? ` [${Math.round(w.score)}]` : '';

        // Prefer URL s reálnou wallet address (přehlednější než interní ID)
        const profileUrl = `${frontendUrl}/wallet/${w.address}`;
        const nameWithLink = `[**${name}${scoreStr}**](${profileUrl})`;
        
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
              const formatter = new Intl.DateTimeFormat('cs-CZ', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
                timeZone: 'Europe/Prague',
              });
              const timeStr = formatter.format(time);
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

            // Pro conviction signál: zobraz kolikrát větší trade oproti průměru
            if (w.convictionMultiplier && w.avgTradeSize) {
              const avgUsd = w.avgTradeSize * solPriceUsd;
              parts.push(`(${w.convictionMultiplier.toFixed(1)}x avg ${this.formatNumber(w.avgTradeSize, 2)} ${baseToken})`);
            }
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
          // Format time in Prague timezone
          const formatter = new Intl.DateTimeFormat('cs-CZ', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZone: 'Europe/Prague',
          });
          const timeStr = formatter.format(time);
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

    // AI Reasoning (if available) - with separator line above
    if (data.aiReasoning) {
      fields.push({
        name: '───────────────────────────',
        value: `💭 **AI Reasoning**\n${data.aiReasoning}`,
        inline: false,
      });
    }

    return {
      title,
      url: gmgnUrl,
      color,
      fields,
      footer: {
        text: (() => {
          // Convert to Prague timezone (UTC+1, or UTC+2 during DST)
          const now = new Date();
          const pragueTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Prague' }));
          const day = String(pragueTime.getDate()).padStart(2, '0');
          const month = String(pragueTime.getMonth() + 1).padStart(2, '0');
          const year = pragueTime.getFullYear();
          const hours = String(pragueTime.getHours()).padStart(2, '0');
          const minutes = String(pragueTime.getMinutes()).padStart(2, '0');
          const seconds = String(pragueTime.getSeconds()).padStart(2, '0');
          return `⚡ Powered by STPNGPT • ${day}/${month}/${year}, ${hours}:${minutes}:${seconds}`;
        })(),
      },
    };
  }

  /**
   * Emoji pro typ signálu
   */
  private getSignalEmoji(signalType: string): string {
    const emojis: Record<string, string> = {
      'ninja': '🥷',
      'consensus': '🤝',
      'consensus-update': '📈',
      'cluster': '💎',
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
   * Pošle notifikaci o SPECTRE trade (buy/sell) do exit kanálu
   * Tracker pro sledování vlastních obchodů
   * Pro SELL: vyžaduje PnL data, jinak se nepošle (aby se zabránilo N/A embedům)
   */
  async sendSpectreTradeNotification(data: SpectreTradeNotificationData): Promise<boolean> {
    if (!this.exitEnabled) {
      console.warn('⚠️  SPECTRE trade notification skipped: DISCORD_EXIT_WEBHOOK_URL not set');
      return false;
    }

    // Pro SELL vyžadujeme PnL data - jinak neposlat (zabránit N/A embedům)
    if (data.action === 'sell' && data.pnlPercent === undefined) {
      console.warn(`⚠️  SPECTRE SELL notification skipped for ${data.tokenSymbol}: missing PnL data`);
      return false;
    }

    try {
      const embed = this.buildSpectreTradeEmbed(data);

      const payload: DiscordWebhookPayload = {
        username: 'Spectre Tracker',
        embeds: [embed],
      };

      const response = await fetch(this.exitWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Discord SPECTRE trade webhook error: ${response.status} - ${errorText}`);
        return false;
      }

      console.log(`📨 Discord SPECTRE ${data.action.toUpperCase()} notification sent for ${data.tokenSymbol}`);
      return true;
    } catch (error: any) {
      console.error(`❌ Failed to send Discord SPECTRE trade notification: ${error.message}`);
      return false;
    }
  }

  /**
   * Vytvoří embed pro SPECTRE trade - minimalistický design
   * BUY: zelený proužek, SELL: červený proužek
   */
  private buildSpectreTradeEmbed(data: SpectreTradeNotificationData): DiscordEmbed {
    const pumpfunUrl = `https://pump.fun/coin/${data.tokenMint}`;
    const gmgnUrl = `https://gmgn.ai/sol/token/${data.tokenMint}`;
    const isBuy = data.action === 'buy';

    // Barvy: zelená pro BUY, červená pro SELL
    const color = isBuy ? 0x22c55e : 0xef4444;

    // Formátuj čas (Praha timezone) - HH:MM:SS
    const formatTime = (dateStr: string) => {
      const date = new Date(dateStr);
      return new Intl.DateTimeFormat('cs-CZ', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Europe/Prague',
      }).format(date);
    };

    // Token symbol - fallback na zkrácený mint pokud Unknown
    const tokenSymbol = data.tokenSymbol && data.tokenSymbol !== 'Unknown'
      ? data.tokenSymbol
      : data.tokenMint.slice(0, 6);

    // MCap string
    const formatMcap = (mcap?: number) => {
      if (!mcap) return 'N/A';
      if (mcap >= 1000000) return `$${(mcap / 1000000).toFixed(2)}M`;
      return `$${(mcap / 1000).toFixed(1)}K`;
    };

    if (isBuy) {
      // ===== BUY EMBED =====
      // Pro BUY použij MCap v momentě nákupu (tradeMarketCapUsd), fallback na signalMarketCapUsd
      const mcapStr = formatMcap(data.tradeMarketCapUsd || data.signalMarketCapUsd);
      const title = `🟢 BUY $${tokenSymbol}`;

      // Simple description with key info
      const description = [
        `**MCap:** ${mcapStr}`,
        `**Amount:** ${data.amountSol.toFixed(4)} SOL`,
        `**Time:** ${formatTime(data.tradeTimestamp)}`,
        '',
        `[pump.fun](${pumpfunUrl}) • [gmgn](${gmgnUrl})${data.txSignature ? ` • [tx](https://solscan.io/tx/${data.txSignature})` : ''}`,
      ].join('\n');

      return {
        title,
        description,
        color,
        timestamp: new Date().toISOString(),
      };

    } else {
      // ===== SELL EMBED =====
      const mcapStr = formatMcap(data.tradeMarketCapUsd);

      // PnL info
      const pnlStr = data.pnlPercent !== undefined
        ? `${data.pnlPercent >= 0 ? '+' : ''}${data.pnlPercent.toFixed(1)}%`
        : 'N/A';
      const pnlUsdStr = data.pnlUsd !== undefined
        ? `${data.pnlUsd >= 0 ? '+' : ''}$${data.pnlUsd.toFixed(2)}`
        : '';

      const title = `🔴 SELL $${tokenSymbol}`;

      // Simple description with key info
      const description = [
        `**MCap:** ${mcapStr}`,
        `**PnL:** ${pnlStr}${pnlUsdStr ? ` (${pnlUsdStr})` : ''}`,
        `**Time:** ${formatTime(data.tradeTimestamp)}`,
        '',
        `[pump.fun](${pumpfunUrl}) • [gmgn](${gmgnUrl})${data.txSignature ? ` • [tx](https://solscan.io/tx/${data.txSignature})` : ''}`,
      ].join('\n');

      return {
        title,
        description,
        color,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Formátuje velmi malé ceny (např. 0.0000000409 -> 0.0₈409)
   */
  private formatSmallPrice(price: number): string {
    if (price >= 0.01) {
      return price.toFixed(4);
    }
    // Count zeros after decimal
    const str = price.toFixed(15);
    const match = str.match(/^0\.0*[1-9]/);
    if (!match) return price.toExponential(2);

    const zeros = match[0].length - 2; // počet nul
    const significantPart = price * Math.pow(10, zeros);
    const subscript = String(zeros).split('').map(d => '₀₁₂₃₄₅₆₇₈₉'[parseInt(d)]).join('');

    return `0.0${subscript}${significantPart.toFixed(3).replace('0.', '')}`;
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

    const result = await this.sendSignalNotification(testData);
    return result.success;
  }
}

