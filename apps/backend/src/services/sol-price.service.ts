/**
 * Service pro získání aktuální ceny SOL v USD
 * 
 * Používá Binance API pro získání ceny SOL/USDT páru
 */

const BINANCE_API_URL = 'https://api.binance.com/api/v3';

export class SolPriceService {
  private cachedPrice: number | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minut

  /**
   * Získá aktuální cenu SOL v USD (USDT)
   * Používá cache pro snížení API volání
   */
  async getSolPriceUsd(): Promise<number> {
    const now = Date.now();
    
    // Pokud máme cache a není starší než 5 minut, vrať ho
    if (this.cachedPrice && (now - this.cacheTimestamp) < this.CACHE_DURATION_MS) {
      return this.cachedPrice;
    }

    try {
      const response = await fetch(
        `${BINANCE_API_URL}/ticker/price?symbol=SOLUSDT`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Binance API error: ${response.status}`);
      }

      const data = await response.json() as { price: string };
      const price = parseFloat(data.price);

      if (!price || isNaN(price) || price <= 0) {
        throw new Error('Invalid price data from Binance');
      }

      // Ulož do cache
      this.cachedPrice = price;
      this.cacheTimestamp = now;

      return price;
    } catch (error: any) {
      console.error('Error fetching SOL price from Binance:', error.message);
      
      // Pokud máme starou cache, použij ji
      if (this.cachedPrice) {
        console.warn(`Using cached SOL price: $${this.cachedPrice}`);
        return this.cachedPrice;
      }

      // Fallback na přibližnou cenu (aktualizuj podle potřeby)
      console.warn('Using fallback SOL price: $150');
      return 150;
    }
  }

  /**
   * Převod SOL na USD
   */
  async solToUsd(solAmount: number): Promise<number> {
    const price = await this.getSolPriceUsd();
    return solAmount * price;
  }

  /**
   * Získá historickou cenu SOL v USD pro konkrétní datum
   * 
   * @param date Datum pro které chceme cenu (Date objekt)
   * @returns Cena SOL v USD
   */
  async getSolPriceUsdAtDate(date: Date): Promise<number> {
    try {
      const timestampMs = date.getTime();
      const timestampSec = Math.floor(timestampMs / 1000);
      
      // Zaokrouhli na minutu (Binance klines jsou po minutách)
      const minuteTimestamp = Math.floor(timestampSec / 60) * 60;
      const endTime = minuteTimestamp * 1000;

      const response = await fetch(
        `${BINANCE_API_URL}/klines?symbol=SOLUSDT&interval=1m&limit=1&endTime=${endTime}`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        // Pokud není historická data (příliš staré), použij aktuální cenu
        if (response.status === 400) {
          console.warn(`Binance: No historical data for ${date.toISOString()}, using current price`);
          return await this.getSolPriceUsd();
        }
        throw new Error(`Binance API error: ${response.status}`);
      }

      const data = await response.json();
      
      if (!Array.isArray(data) || data.length === 0) {
        // Pokud není data, použij aktuální cenu
        console.warn(`Binance: No klines data for ${date.toISOString()}, using current price`);
        return await this.getSolPriceUsd();
      }

      // Kline format: [openTime, open, high, low, close, volume, ...]
      // Použijeme close price (index 4)
      const closePrice = parseFloat(data[0][4]);
      
      if (!closePrice || isNaN(closePrice) || closePrice <= 0) {
        throw new Error('Invalid price data from Binance klines');
      }

      return closePrice;
    } catch (error: any) {
      console.error(`Error fetching historical SOL price from Binance for ${date.toISOString()}:`, error.message);
      // Fallback na aktuální cenu
      return await this.getSolPriceUsd();
    }
  }

  /**
   * Převod SOL na USD pomocí historické ceny SOL z doby transakce
   * 
   * @param solAmount Množství SOL
   * @param timestamp Timestamp transakce (Date nebo Unix timestamp v sekundách)
   * @returns Hodnota v USD
   */
  async solToUsdAtDate(solAmount: number, timestamp: Date | number): Promise<number> {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp * 1000);
    const price = await this.getSolPriceUsdAtDate(date);
    return solAmount * price;
  }
}

