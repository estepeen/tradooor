import { prisma } from '../lib/prisma.js';
import { BinancePriceService } from './binance-price.service.js';

/**
 * Service pro získání aktuální SOL ceny z cache (aktualizováno každých 10 minut)
 * Fallback na Binance API, pokud cache není k dispozici nebo je starší než 15 minut
 */
export class SolPriceCacheService {
  private binancePriceService: BinancePriceService;
  private readonly CACHE_MAX_AGE_MS = 15 * 60 * 1000; // 15 minut

  constructor() {
    this.binancePriceService = new BinancePriceService();
  }

  /**
   * Získá aktuální SOL cenu z cache nebo Binance API
   * @returns Cena SOL v USD
   */
  async getCurrentSolPrice(): Promise<number> {
    try {
      // Zkus načíst z cache
      const cache = await prisma.solPriceCache.findUnique({
        where: { id: 'current' },
      });

      if (cache) {
        const cacheAge = Date.now() - cache.updatedAt.getTime();
        
        // Pokud je cache čerstvá (méně než 15 minut), použij ji
        if (cacheAge < this.CACHE_MAX_AGE_MS) {
          return cache.priceUsd;
        }
        
        // Pokud je cache stará, aktualizuj ji na pozadí (neblokuj request)
        this.updatePriceInBackground().catch(err => {
          console.warn('⚠️  Background SOL price update failed:', err?.message);
        });
        
        // Vrať starou cenu (lepší než nic)
        return cache.priceUsd;
      }

      // Pokud není cache, získej z Binance a ulož do cache
      const price = await this.binancePriceService.getCurrentSolPrice();
      
      await prisma.solPriceCache.upsert({
        where: { id: 'current' },
        update: {
          priceUsd: price,
          updatedAt: new Date(),
          source: 'binance',
        },
        create: {
          id: 'current',
          priceUsd: price,
          source: 'binance',
        },
      });

      return price;
    } catch (error: any) {
      console.error('❌ Error getting SOL price from cache:', error?.message);
      
      // Fallback: zkus Binance API přímo
      try {
        return await this.binancePriceService.getCurrentSolPrice();
      } catch (fallbackError: any) {
        console.error('❌ Fallback to Binance API also failed:', fallbackError?.message);
        // Poslední fallback: použij defaultní cenu
        return 150.0;
      }
    }
  }

  /**
   * Aktualizuje cenu na pozadí (neblokuje request)
   */
  private async updatePriceInBackground(): Promise<void> {
    try {
      const price = await this.binancePriceService.getCurrentSolPrice();
      
      await prisma.solPriceCache.update({
        where: { id: 'current' },
        data: {
          priceUsd: price,
          updatedAt: new Date(),
          source: 'binance',
        },
      });
    } catch (error: any) {
      // Tichá chyba - jen loguj, nevyhazuj error
      console.warn('⚠️  Background SOL price update failed:', error?.message);
    }
  }
}

