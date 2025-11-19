/**
 * Service pro získání aktuální ceny SOL v USD
 * 
 * Používá CoinGecko API (free tier) pro získání ceny SOL
 */

const COINGECKO_API_URL = 'https://api.coingecko.com/api/v3';

export class SolPriceService {
  private cachedPrice: number | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minut

  /**
   * Získá aktuální cenu SOL v USD
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
        `${COINGECKO_API_URL}/simple/price?ids=solana&vs_currencies=usd`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status}`);
      }

      const data = await response.json();
      const price = data.solana?.usd;

      if (!price || typeof price !== 'number') {
        throw new Error('Invalid price data from CoinGecko');
      }

      // Ulož do cache
      this.cachedPrice = price;
      this.cacheTimestamp = now;

      return price;
    } catch (error: any) {
      console.error('Error fetching SOL price:', error.message);
      
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
      // Formátuj datum jako DD-MM-YYYY pro CoinGecko API
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      const dateStr = `${day}-${month}-${year}`;

      const response = await fetch(
        `${COINGECKO_API_URL}/coins/solana/history?date=${dateStr}`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) {
        // Pokud API vrátí chybu (např. pro velmi staré datum), použij aktuální cenu
        console.warn(`CoinGecko historical price API error for ${dateStr}: ${response.status}, using current price`);
        return await this.getSolPriceUsd();
      }

      const data = await response.json();
      const price = data.market_data?.current_price?.usd;

      if (!price || typeof price !== 'number') {
        // Pokud nemáme historickou cenu, použij aktuální cenu
        console.warn(`No historical price data for ${dateStr}, using current price`);
        return await this.getSolPriceUsd();
      }

      return price;
    } catch (error: any) {
      console.error(`Error fetching historical SOL price for ${date.toISOString()}:`, error.message);
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

