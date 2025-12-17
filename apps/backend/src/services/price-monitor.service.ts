/**
 * Price Monitor Service
 * 
 * Level 1.2: Real-time monitoring cen tokenů
 * - Sleduje aktivní signály
 * - Kontroluje SL/TP triggery
 * - Vytváří price alerts
 * - Cachuje ceny
 */

import { generateId } from '../lib/prisma.js';
import { supabase, TABLES } from '../lib/supabase.js';
import { TokenMarketDataService } from './token-market-data.service.js';

export interface PriceAlert {
  id: string;
  signalId?: string;
  tokenId: string;
  mintAddress: string;
  alertType: 'stop_loss' | 'take_profit' | 'price_above' | 'price_below';
  triggerPrice: number;
  currentPrice?: number;
  entryPrice?: number;
  status: 'active' | 'triggered' | 'cancelled' | 'expired';
  triggeredAt?: Date;
  notificationSent: boolean;
}

export interface PriceUpdate {
  mintAddress: string;
  tokenId: string;
  symbol: string;
  price: number;
  priceChange24h?: number;
  marketCap?: number;
  liquidity?: number;
  volume24h?: number;
  timestamp: Date;
}

export class PriceMonitorService {
  private tokenMarketData: TokenMarketDataService;
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 30 * 1000; // 30 seconds

  constructor() {
    this.tokenMarketData = new TokenMarketDataService();
  }

  /**
   * Získá aktuální cenu tokenu (s cache)
   */
  async getPrice(mintAddress: string): Promise<number | null> {
    try {
      // Check cache
      const cached = this.priceCache.get(mintAddress);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        return cached.price;
      }

      // Fetch fresh price
      const marketData = await this.tokenMarketData.getMarketData(mintAddress);
      if (!marketData?.price) {
        return null;
      }

      // Update cache
      this.priceCache.set(mintAddress, {
        price: marketData.price,
        timestamp: Date.now(),
      });

      return marketData.price;
    } catch (error) {
      return null;
    }
  }

  /**
   * Vytvoří SL/TP alerty pro signál
   */
  async createAlertsForSignal(signalId: string): Promise<PriceAlert[]> {
    try {
      // Načti signál
      const { data: signal, error } = await supabase
        .from(TABLES.SIGNAL)
        .select(`
          *,
          token:Token(id, mintAddress, symbol)
        `)
        .eq('id', signalId)
        .single();

      if (error || !signal || !signal.token) {
        return [];
      }

      const alerts: PriceAlert[] = [];
      const entryPrice = Number(signal.entryPriceUsd || signal.priceBasePerToken || 0);

      // Stop Loss alert
      if (signal.stopLossPriceUsd) {
        const slAlert = await this.createAlert({
          signalId,
          tokenId: signal.token.id,
          mintAddress: signal.token.mintAddress,
          alertType: 'stop_loss',
          triggerPrice: Number(signal.stopLossPriceUsd),
          entryPrice,
        });
        if (slAlert) alerts.push(slAlert);
      }

      // Take Profit alert
      if (signal.takeProfitPriceUsd) {
        const tpAlert = await this.createAlert({
          signalId,
          tokenId: signal.token.id,
          mintAddress: signal.token.mintAddress,
          alertType: 'take_profit',
          triggerPrice: Number(signal.takeProfitPriceUsd),
          entryPrice,
        });
        if (tpAlert) alerts.push(tpAlert);
      }

      console.log(`🔔 Created ${alerts.length} price alerts for signal ${signalId.substring(0, 8)}...`);
      return alerts;
    } catch (error: any) {
      console.error(`Error creating alerts for signal ${signalId}:`, error.message);
      return [];
    }
  }

  /**
   * Vytvoří price alert
   */
  async createAlert(data: {
    signalId?: string;
    tokenId: string;
    mintAddress: string;
    alertType: PriceAlert['alertType'];
    triggerPrice: number;
    entryPrice?: number;
    expiresAt?: Date;
  }): Promise<PriceAlert | null> {
    try {
      const id = generateId();
      const expiresAt = data.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h default

      const { data: result, error } = await supabase
        .from('PriceAlert')
        .insert({
          id,
          signalId: data.signalId,
          tokenId: data.tokenId,
          mintAddress: data.mintAddress,
          alertType: data.alertType,
          triggerPrice: data.triggerPrice,
          entryPrice: data.entryPrice,
          status: 'active',
          notificationSent: false,
          createdAt: new Date().toISOString(),
          expiresAt: expiresAt.toISOString(),
        })
        .select()
        .single();

      if (error) {
        console.warn(`Failed to create alert: ${error.message}`);
        return null;
      }

      return result as PriceAlert;
    } catch (error: any) {
      console.error('Error creating alert:', error.message);
      return null;
    }
  }

  /**
   * Zkontroluje všechny aktivní alerty
   */
  async checkAllAlerts(): Promise<{ checked: number; triggered: number }> {
    try {
      // Načti aktivní alerty
      const { data: alerts, error } = await supabase
        .from('PriceAlert')
        .select('*')
        .eq('status', 'active')
        .limit(100);

      if (error || !alerts || alerts.length === 0) {
        return { checked: 0, triggered: 0 };
      }

      // Seskup podle mintAddress pro batch fetching
      const mintAddresses = [...new Set(alerts.map(a => a.mintAddress as string))];
      
      // Fetch ceny pro všechny tokeny
      const prices = new Map<string, number>();
      for (const mint of mintAddresses) {
        const price = await this.getPrice(mint as string);
        if (price !== null) {
          prices.set(mint as string, price);
        }
        await new Promise(r => setTimeout(r, 100)); // Rate limit
      }

      let triggered = 0;
      for (const alert of alerts) {
        const currentPrice = prices.get(alert.mintAddress);
        if (!currentPrice) continue;

        // Check if alert should trigger
        let shouldTrigger = false;
        switch (alert.alertType) {
          case 'stop_loss':
          case 'price_below':
            shouldTrigger = currentPrice <= alert.triggerPrice;
            break;
          case 'take_profit':
          case 'price_above':
            shouldTrigger = currentPrice >= alert.triggerPrice;
            break;
        }

        if (shouldTrigger) {
          await this.triggerAlert(alert.id, currentPrice);
          triggered++;
        } else {
          // Update current price
          await supabase
            .from('PriceAlert')
            .update({ currentPrice })
            .eq('id', alert.id);
        }
      }

      // Expire old alerts
      await this.expireOldAlerts();

      return { checked: alerts.length, triggered };
    } catch (error: any) {
      console.error('Error checking alerts:', error.message);
      return { checked: 0, triggered: 0 };
    }
  }

  /**
   * Trigger alert
   */
  async triggerAlert(alertId: string, currentPrice: number): Promise<void> {
    try {
      await supabase
        .from('PriceAlert')
        .update({
          status: 'triggered',
          currentPrice,
          triggeredAt: new Date().toISOString(),
        })
        .eq('id', alertId);

      // Načti alert pro notification
      const { data: alert } = await supabase
        .from('PriceAlert')
        .select(`
          *,
          signal:Signal(
            id,
            aiDecision,
            aiConfidence,
            entryPriceUsd
          )
        `)
        .eq('id', alertId)
        .single();

      if (alert) {
        const entryPrice = alert.entryPrice || 0;
        const pnlPercent = entryPrice > 0 
          ? ((currentPrice - entryPrice) / entryPrice) * 100 
          : 0;

        console.log(`🚨 ALERT TRIGGERED: ${alert.alertType.toUpperCase()} @ $${currentPrice.toFixed(6)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
        
        // Create notification
        await this.createNotification(alert, currentPrice, pnlPercent);
      }
    } catch (error: any) {
      console.error(`Error triggering alert ${alertId}:`, error.message);
    }
  }

  /**
   * Vytvoří notifikaci pro triggered alert
   */
  private async createNotification(alert: any, currentPrice: number, pnlPercent: number): Promise<void> {
    try {
      const isWin = alert.alertType === 'take_profit' || pnlPercent > 0;
      const emoji = isWin ? '🎯' : '🛑';
      
      const message = `${emoji} ${alert.alertType.toUpperCase()} HIT!\n` +
        `Price: $${currentPrice.toFixed(6)}\n` +
        `Entry: $${(alert.entryPrice || 0).toFixed(6)}\n` +
        `PnL: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%`;

      await supabase
        .from('NotificationLog')
        .insert({
          id: generateId(),
          type: 'price_alert',
          channel: 'webhook', // Default channel
          alertId: alert.id,
          signalId: alert.signalId,
          title: `${alert.alertType.toUpperCase()} Alert`,
          message,
          metadata: {
            alertType: alert.alertType,
            currentPrice,
            triggerPrice: alert.triggerPrice,
            pnlPercent,
          },
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
    } catch (error: any) {
      console.error('Error creating notification:', error.message);
    }
  }

  /**
   * Expiruj staré alerty
   */
  async expireOldAlerts(): Promise<number> {
    try {
      const { data, error } = await supabase
        .from('PriceAlert')
        .update({ status: 'expired' })
        .eq('status', 'active')
        .lt('expiresAt', new Date().toISOString())
        .select();

      return data?.length || 0;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Získá aktivní alerty pro token
   */
  async getActiveAlerts(tokenId?: string): Promise<PriceAlert[]> {
    try {
      let query = supabase
        .from('PriceAlert')
        .select('*')
        .eq('status', 'active')
        .order('createdAt', { ascending: false });

      if (tokenId) {
        query = query.eq('tokenId', tokenId);
      }

      const { data, error } = await query.limit(100);

      if (error) {
        return [];
      }

      return data as PriceAlert[];
    } catch (error) {
      return [];
    }
  }

  /**
   * Uloží price history
   */
  async savePriceHistory(updates: PriceUpdate[]): Promise<void> {
    try {
      const records = updates.map(u => ({
        id: generateId(),
        tokenId: u.tokenId,
        mintAddress: u.mintAddress,
        priceUsd: u.price,
        marketCapUsd: u.marketCap,
        liquidityUsd: u.liquidity,
        volume24hUsd: u.volume24h,
        timestamp: u.timestamp.toISOString(),
        source: 'birdeye',
      }));

      await supabase
        .from('TokenPriceHistory')
        .insert(records);
    } catch (error: any) {
      console.error('Error saving price history:', error.message);
    }
  }

  /**
   * Načte price history pro token
   */
  async getPriceHistory(tokenId: string, hours: number = 24): Promise<{ timestamp: Date; price: number }[]> {
    try {
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);

      const { data, error } = await supabase
        .from('TokenPriceHistory')
        .select('timestamp, priceUsd')
        .eq('tokenId', tokenId)
        .gte('timestamp', since.toISOString())
        .order('timestamp', { ascending: true });

      if (error || !data) {
        return [];
      }

      return data.map(d => ({
        timestamp: new Date(d.timestamp),
        price: Number(d.priceUsd),
      }));
    } catch (error) {
      return [];
    }
  }
}

