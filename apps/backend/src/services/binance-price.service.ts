/**
 * Service pro získání historické ceny SOL/USDT z Binance API
 * 
 * Používá Binance API pro získání historické ceny SOL/USDT páru
 */

const BINANCE_API_URL = 'https://api.binance.com/api/v3';

export class BinancePriceService {
  private cachedPrices: Map<number, number> = new Map(); // timestamp -> price cache
  private readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minut cache

  /**
   * Získá aktuální cenu SOL/USDT z Binance
   */
  async getCurrentSolPrice(): Promise<number> {
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

      const data = await response.json();
      const price = parseFloat(data.price);

      if (!price || isNaN(price) || price <= 0) {
        throw new Error('Invalid price data from Binance');
      }

      return price;
    } catch (error: any) {
      console.error('Error fetching SOL price from Binance:', error.message);
      throw error;
    }
  }

  /**
   * Získá historickou cenu SOL/USDT pro konkrétní timestamp
   * 
   * @param timestamp Unix timestamp v sekundách nebo Date objekt
   * @returns Cena SOL v USDT
   */
  async getSolPriceAtTimestamp(timestamp: Date | number): Promise<number> {
    const timestampMs = timestamp instanceof Date ? timestamp.getTime() : timestamp * 1000;
    const timestampSec = Math.floor(timestampMs / 1000);
    
    // Zaokrouhli na minutu (Binance klines jsou po minutách)
    const minuteTimestamp = Math.floor(timestampSec / 60) * 60;
    
    // Zkontroluj cache
    if (this.cachedPrices.has(minuteTimestamp)) {
      return this.cachedPrices.get(minuteTimestamp)!;
    }

    try {
      // Binance klines API - vrací OHLCV data
      // interval: 1m = 1 minuta
      // limit: 1 = jen jeden kline
      // endTime: timestamp v ms
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
          console.warn(`Binance: No historical data for timestamp ${new Date(timestampMs).toISOString()}, using current price`);
          return await this.getCurrentSolPrice();
        }
        throw new Error(`Binance API error: ${response.status}`);
      }

      const data = await response.json();
      
      if (!Array.isArray(data) || data.length === 0) {
        // Pokud není data, použij aktuální cenu
        console.warn(`Binance: No klines data for timestamp ${new Date(timestampMs).toISOString()}, using current price`);
        return await this.getCurrentSolPrice();
      }

      // Kline format: [openTime, open, high, low, close, volume, ...]
      // Použijeme close price (index 4)
      const closePrice = parseFloat(data[0][4]);
      
      if (!closePrice || isNaN(closePrice) || closePrice <= 0) {
        throw new Error('Invalid price data from Binance klines');
      }

      // Ulož do cache
      this.cachedPrices.set(minuteTimestamp, closePrice);
      
      // Omezení cache - smaž staré záznamy (starší než 1 hodina)
      const oneHourAgo = Math.floor(Date.now() / 1000 / 60) * 60 - 3600;
      for (const [ts, _] of this.cachedPrices.entries()) {
        if (ts < oneHourAgo) {
          this.cachedPrices.delete(ts);
        }
      }

      return closePrice;
    } catch (error: any) {
      console.error(`Error fetching historical SOL price from Binance for ${new Date(timestampMs).toISOString()}:`, error.message);
      
      // Fallback: zkus aktuální cenu
      try {
        return await this.getCurrentSolPrice();
      } catch (fallbackError: any) {
        console.error('Fallback to current price also failed:', fallbackError.message);
        throw new Error(`Failed to fetch SOL price: ${error.message}`);
      }
    }
  }

  /**
   * Převod SOL na USD pomocí historické ceny SOL/USDT z Binance
   * 
   * @param solAmount Množství SOL
   * @param timestamp Timestamp transakce (Date nebo Unix timestamp v sekundách)
   * @returns Hodnota v USD
   */
  async solToUsdAtTimestamp(solAmount: number, timestamp: Date | number): Promise<number> {
    const price = await this.getSolPriceAtTimestamp(timestamp);
    return solAmount * price;
  }
}


