/**
 * PumpfunClient - Wrapper pro Pump.fun API
 * 
 * Zatím podporuje WebSocket realtime stream.
 * Pokud Pump.fun přidá REST API pro historii, můžeme přidat metody typu:
 * - getWalletTrades(address, since)
 * - getTokenTrades(mint, since)
 */

export type PumpfunTrade = {
  txSignature: string;
  tokenMint: string;
  side: 'buy' | 'sell';
  amountToken: number;
  amountBase: number; // v SOL
  priceBasePerToken: number;
  timestamp: Date;
  dex: 'pumpfun';
  meta?: Record<string, any>;
};

export class PumpfunClient {
  constructor(
    private baseUrl: string = 'wss://pumpportal.fun/api/data',
    private apiKey?: string
  ) {}

  /**
   * Normalizace trade zprávy z WebSocket do PumpfunTrade
   * 
   * Podporuje různé formáty zpráv, které mohou přijít z Pump.fun API
   */
  normalizeTradeMessage(data: any, walletAddress: string): PumpfunTrade | null {
    try {
      // Extrahuj data - zkus různé možné názvy polí
      const txSignature = data.signature || data.tx || data.txSignature || data.transaction;
      const mint = data.mint || data.token || data.tokenMint || data.contract;
      const side = data.action || data.side || data.type; // 'buy' or 'sell'
      const amountToken = data.amount || data.tokenAmount || data.amountOut || data.amountIn;
      const amountBase = data.solAmount || data.amountIn || data.amountOut || data.baseAmount;
      const price = data.price || data.pricePerToken;
      const timestamp = data.timestamp || data.time || data.createdAt;

      if (!txSignature || !mint) {
        return null;
      }

      // Urči side
      let tradeSide: 'buy' | 'sell' = 'buy';
      if (side) {
        const sideLower = String(side).toLowerCase();
        if (sideLower === 'sell' || sideLower === 'sold') {
          tradeSide = 'sell';
        } else if (sideLower === 'buy' || sideLower === 'bought') {
          tradeSide = 'buy';
        }
      }

      // Parsuj amounty
      const parsedAmountToken = amountToken ? parseFloat(String(amountToken)) : 0;
      const parsedAmountBase = amountBase ? parseFloat(String(amountBase)) : 0;
      
      // Pokud nemáme amountBase, zkus spočítat z price
      let finalAmountBase = parsedAmountBase;
      let finalPriceBasePerToken = price ? parseFloat(String(price)) : 0;
      
      if (finalAmountBase === 0 && finalPriceBasePerToken > 0 && parsedAmountToken > 0) {
        finalAmountBase = finalPriceBasePerToken * parsedAmountToken;
      } else if (finalPriceBasePerToken === 0 && finalAmountBase > 0 && parsedAmountToken > 0) {
        finalPriceBasePerToken = finalAmountBase / parsedAmountToken;
      }

      if (parsedAmountToken === 0 || finalAmountBase === 0) {
        return null;
      }

      // Parsuj timestamp
      const tradeTimestamp = timestamp
        ? new Date(typeof timestamp === 'number' ? timestamp * 1000 : timestamp)
        : new Date();

      return {
        txSignature,
        tokenMint: mint,
        side: tradeSide,
        amountToken: parsedAmountToken,
        amountBase: finalAmountBase,
        priceBasePerToken: finalPriceBasePerToken,
        timestamp: tradeTimestamp,
        dex: 'pumpfun',
        meta: {
          source: 'pumpfun-websocket',
          rawData: data,
        },
      };
    } catch (error: any) {
      console.error('Error normalizing trade message:', error.message);
      return null;
    }
  }
}

