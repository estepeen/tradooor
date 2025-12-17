/**
 * Notification Service
 * 
 * Level 1.3: Enhanced notifications
 * - Discord webhooks s rich embeds
 * - Telegram bot integration
 * - Different urgency levels
 * - Notification queue
 */

import { generateId } from '../lib/prisma.js';
import { supabase, TABLES } from '../lib/supabase.js';

export type NotificationType = 'signal' | 'price_alert' | 'outcome' | 'daily_summary' | 'error';
export type NotificationChannel = 'discord' | 'telegram' | 'webhook';
export type NotificationUrgency = 'low' | 'medium' | 'high' | 'critical';

export interface NotificationPayload {
  type: NotificationType;
  channel?: NotificationChannel;
  urgency?: NotificationUrgency;
  title: string;
  message: string;
  signalId?: string;
  alertId?: string;
  metadata?: Record<string, any>;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
  thumbnail?: { url: string };
}

export class NotificationService {
  private discordWebhookUrl?: string;
  private telegramBotToken?: string;
  private telegramChatId?: string;

  constructor() {
    this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    this.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = process.env.TELEGRAM_CHAT_ID;
  }

  /**
   * Odešle notifikaci
   */
  async send(payload: NotificationPayload): Promise<boolean> {
    try {
      const channel = payload.channel || 'discord';
      
      // Log notification
      const logId = await this.logNotification(payload, 'pending');

      let success = false;
      switch (channel) {
        case 'discord':
          success = await this.sendDiscord(payload);
          break;
        case 'telegram':
          success = await this.sendTelegram(payload);
          break;
        case 'webhook':
          // Generic webhook - can be extended
          success = await this.sendDiscord(payload);
          break;
      }

      // Update log status
      await this.updateNotificationStatus(logId, success ? 'sent' : 'failed');

      return success;
    } catch (error: any) {
      console.error('Notification error:', error.message);
      return false;
    }
  }

  /**
   * Odešle signál notifikaci
   */
  async sendSignalNotification(signal: any, aiDecision?: any): Promise<boolean> {
    try {
      const isHighConfidence = (aiDecision?.confidence || 0) >= 70;
      const urgency: NotificationUrgency = isHighConfidence ? 'high' : 'medium';
      
      const emoji = this.getSignalEmoji(signal.model, aiDecision?.decision);
      const color = this.getColorForUrgency(urgency);

      // Discord embed
      const embed: DiscordEmbed = {
        title: `${emoji} ${signal.model?.toUpperCase() || 'SIGNAL'}: ${signal.token?.symbol || 'Unknown'}`,
        description: aiDecision?.reasoning || signal.reasoning || 'New trading signal detected',
        color,
        fields: [
          {
            name: '📊 Signal Type',
            value: signal.model || 'consensus',
            inline: true,
          },
          {
            name: '👛 Wallets',
            value: `${signal.meta?.walletCount || 1}`,
            inline: true,
          },
          {
            name: '💰 Entry Price',
            value: `$${Number(signal.entryPriceUsd || signal.priceBasePerToken || 0).toFixed(6)}`,
            inline: true,
          },
        ],
        footer: { text: 'Tradooor Bot' },
        timestamp: new Date().toISOString(),
      };

      // Add AI decision fields if available
      if (aiDecision) {
        embed.fields?.push(
          {
            name: '🤖 AI Decision',
            value: `${aiDecision.decision?.toUpperCase()} (${aiDecision.confidence}%)`,
            inline: true,
          },
          {
            name: '📈 Position Size',
            value: `${aiDecision.suggestedPositionPercent || 10}%`,
            inline: true,
          },
          {
            name: '⚠️ Risk',
            value: `${aiDecision.riskScore || 5}/10`,
            inline: true,
          }
        );

        // SL/TP
        if (aiDecision.stopLossPercent || aiDecision.takeProfitPercent) {
          embed.fields?.push({
            name: '🎯 SL / TP',
            value: `SL: -${aiDecision.stopLossPercent || 15}% | TP: +${aiDecision.takeProfitPercent || 50}%`,
            inline: false,
          });
        }
      }

      // Market data
      if (signal.tokenMarketCapUsd || signal.tokenLiquidityUsd) {
        embed.fields?.push({
          name: '📈 Market Data',
          value: `MCap: $${this.formatNumber(signal.tokenMarketCapUsd)} | Liq: $${this.formatNumber(signal.tokenLiquidityUsd)}`,
          inline: false,
        });
      }

      return await this.sendDiscordEmbed(embed, urgency);
    } catch (error: any) {
      console.error('Error sending signal notification:', error.message);
      return false;
    }
  }

  /**
   * Odešle price alert notifikaci
   */
  async sendPriceAlertNotification(alert: any, currentPrice: number, pnlPercent: number): Promise<boolean> {
    try {
      const isWin = alert.alertType === 'take_profit' || pnlPercent > 0;
      const urgency: NotificationUrgency = isWin ? 'high' : 'critical';
      const emoji = isWin ? '🎯' : '🛑';
      const color = isWin ? 0x00ff00 : 0xff0000;

      const embed: DiscordEmbed = {
        title: `${emoji} ${alert.alertType.toUpperCase()} TRIGGERED!`,
        description: `Price alert has been triggered for your position`,
        color,
        fields: [
          {
            name: '💵 Current Price',
            value: `$${currentPrice.toFixed(6)}`,
            inline: true,
          },
          {
            name: '📊 Entry Price',
            value: `$${(alert.entryPrice || 0).toFixed(6)}`,
            inline: true,
          },
          {
            name: '📈 PnL',
            value: `${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%`,
            inline: true,
          },
          {
            name: '🎯 Trigger Price',
            value: `$${Number(alert.triggerPrice).toFixed(6)}`,
            inline: true,
          },
        ],
        footer: { text: 'Tradooor Bot' },
        timestamp: new Date().toISOString(),
      };

      return await this.sendDiscordEmbed(embed, urgency);
    } catch (error: any) {
      console.error('Error sending price alert notification:', error.message);
      return false;
    }
  }

  /**
   * Odešle daily summary
   */
  async sendDailySummary(stats: any): Promise<boolean> {
    try {
      const winRateColor = stats.winRate >= 60 ? 0x00ff00 : stats.winRate >= 40 ? 0xffff00 : 0xff0000;

      const embed: DiscordEmbed = {
        title: '📊 Daily Trading Summary',
        description: `Performance summary for ${new Date().toLocaleDateString()}`,
        color: winRateColor,
        fields: [
          {
            name: '📈 Total Signals',
            value: `${stats.totalSignals || 0}`,
            inline: true,
          },
          {
            name: '✅ Win Rate',
            value: `${(stats.winRate || 0).toFixed(1)}%`,
            inline: true,
          },
          {
            name: '💰 Avg PnL',
            value: `${(stats.avgPnlPercent || 0) >= 0 ? '+' : ''}${(stats.avgPnlPercent || 0).toFixed(1)}%`,
            inline: true,
          },
          {
            name: '🏆 Wins / Losses',
            value: `${stats.winCount || 0} / ${stats.lossCount || 0}`,
            inline: true,
          },
          {
            name: '📊 Best Trade',
            value: `+${(stats.bestPnlPercent || 0).toFixed(1)}%`,
            inline: true,
          },
          {
            name: '📉 Worst Trade',
            value: `${(stats.worstPnlPercent || 0).toFixed(1)}%`,
            inline: true,
          },
          {
            name: '🤖 AI Accuracy',
            value: `${(stats.aiAccuracy || 0).toFixed(1)}%`,
            inline: true,
          },
        ],
        footer: { text: 'Tradooor Bot - Daily Report' },
        timestamp: new Date().toISOString(),
      };

      return await this.sendDiscordEmbed(embed, 'low');
    } catch (error: any) {
      console.error('Error sending daily summary:', error.message);
      return false;
    }
  }

  /**
   * Discord webhook s embed
   */
  private async sendDiscordEmbed(embed: DiscordEmbed, urgency: NotificationUrgency): Promise<boolean> {
    if (!this.discordWebhookUrl) {
      console.warn('Discord webhook URL not configured');
      return false;
    }

    try {
      // Add mention for high urgency
      let content = '';
      if (urgency === 'critical') {
        content = '@everyone 🚨';
      } else if (urgency === 'high') {
        content = '📢';
      }

      const response = await fetch(this.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content || undefined,
          embeds: [embed],
        }),
      });

      if (!response.ok) {
        console.error('Discord webhook failed:', response.status);
        return false;
      }

      return true;
    } catch (error: any) {
      console.error('Discord error:', error.message);
      return false;
    }
  }

  /**
   * Simple Discord message
   */
  private async sendDiscord(payload: NotificationPayload): Promise<boolean> {
    if (!this.discordWebhookUrl) {
      console.warn('Discord webhook URL not configured');
      return false;
    }

    const embed: DiscordEmbed = {
      title: payload.title,
      description: payload.message,
      color: this.getColorForUrgency(payload.urgency || 'medium'),
      timestamp: new Date().toISOString(),
    };

    return await this.sendDiscordEmbed(embed, payload.urgency || 'medium');
  }

  /**
   * Telegram message
   */
  private async sendTelegram(payload: NotificationPayload): Promise<boolean> {
    if (!this.telegramBotToken || !this.telegramChatId) {
      console.warn('Telegram not configured');
      return false;
    }

    try {
      const text = `*${payload.title}*\n\n${payload.message}`;
      
      const response = await fetch(
        `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.telegramChatId,
            text,
            parse_mode: 'Markdown',
          }),
        }
      );

      if (!response.ok) {
        console.error('Telegram failed:', response.status);
        return false;
      }

      return true;
    } catch (error: any) {
      console.error('Telegram error:', error.message);
      return false;
    }
  }

  /**
   * Log notification to database
   */
  private async logNotification(payload: NotificationPayload, status: string): Promise<string> {
    const id = generateId();
    
    try {
      await supabase
        .from('NotificationLog')
        .insert({
          id,
          type: payload.type,
          channel: payload.channel || 'discord',
          signalId: payload.signalId,
          alertId: payload.alertId,
          title: payload.title,
          message: payload.message,
          metadata: payload.metadata,
          status,
          createdAt: new Date().toISOString(),
        });
    } catch (error) {
      // Non-critical
    }

    return id;
  }

  /**
   * Update notification status
   */
  private async updateNotificationStatus(id: string, status: 'sent' | 'failed', error?: string): Promise<void> {
    try {
      await supabase
        .from('NotificationLog')
        .update({
          status,
          errorMessage: error,
          sentAt: status === 'sent' ? new Date().toISOString() : null,
        })
        .eq('id', id);
    } catch (error) {
      // Non-critical
    }
  }

  /**
   * Pomocné funkce
   */
  private getSignalEmoji(signalType: string, aiDecision?: string): string {
    if (aiDecision === 'skip') return '⏭️';
    if (aiDecision === 'sell') return '📉';
    
    const emojis: Record<string, string> = {
      'consensus': '🤝',
      'whale-entry': '🐋',
      'early-sniper': '🎯',
      'hot-token': '🔥',
      're-entry': '🔄',
      'momentum': '📈',
      'accumulation': '📦',
    };
    return emojis[signalType] || '📊';
  }

  private getColorForUrgency(urgency: NotificationUrgency): number {
    const colors = {
      low: 0x808080,      // Gray
      medium: 0x0099ff,   // Blue
      high: 0x00ff00,     // Green
      critical: 0xff0000, // Red
    };
    return colors[urgency] || colors.medium;
  }

  private formatNumber(num: number | null | undefined): string {
    if (!num) return '-';
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toFixed(0);
  }

  /**
   * Odešle pending notifikace z queue
   */
  async processPendingNotifications(): Promise<number> {
    try {
      const { data: pending, error } = await supabase
        .from('NotificationLog')
        .select('*')
        .eq('status', 'pending')
        .limit(10);

      if (error || !pending) return 0;

      let sent = 0;
      for (const notification of pending) {
        const success = await this.send({
          type: notification.type,
          channel: notification.channel,
          title: notification.title,
          message: notification.message,
          metadata: notification.metadata,
        });

        if (success) sent++;
      }

      return sent;
    } catch (error) {
      return 0;
    }
  }
}

