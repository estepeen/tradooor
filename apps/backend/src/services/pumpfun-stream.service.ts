import WebSocket from 'ws';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { PumpfunClient, type PumpfunTrade } from './pumpfun-client.service.js';

/**
 * Service pro realtime tracking Pump.fun trades přes WebSocket
 * 
 * Připojí se na wss://pumpportal.fun/api/data a sleduje:
 * - subscribeAccountTrade pro všechny smart wallets z DB
 * - subscribeTokenTrade pro zajímavé tokeny (volitelné)
 * 
 * Trades se ukládají přímo do Trade tabulky bez složité heuristiky.
 */
export class PumpfunStreamService {
  private ws: WebSocket | null = null;
  private isRunning = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000; // 5 seconds
  private pumpfunClient: PumpfunClient;
  private walletTimestamps = new Map<string, Date>(); // Cache pro tracking timestampů

  constructor(
    private smartWalletRepo: SmartWalletRepository,
    private tradeRepo: TradeRepository,
    private tokenRepo: TokenRepository
  ) {
    this.pumpfunClient = new PumpfunClient();
  }

  /**
   * Spuštění WebSocket streamu
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️  PumpfunStreamService is already running');
      return;
    }

    this.isRunning = true;
    await this.connect();
  }

  /**
   * Připojení na WebSocket
   */
  private async connect(): Promise<void> {
    try {
      console.log('🔌 Connecting to Pump.fun WebSocket...');
      this.ws = new WebSocket('wss://pumpportal.fun/api/data');

      this.ws.on('open', async () => {
        console.log('✅ Connected to Pump.fun WebSocket');
        this.reconnectAttempts = 0;
        await this.subscribeToWallets();
      });

      this.ws.on('message', async (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          await this.handleMessage(message);
        } catch (error: any) {
          console.error('❌ Error parsing WebSocket message:', error.message);
          console.error('Raw message:', data.toString().substring(0, 200));
        }
      });

      this.ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
      });

      this.ws.on('close', () => {
        console.log('🔌 WebSocket connection closed');
        this.ws = null;
        
        if (this.isRunning && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`🔄 Reconnecting in ${this.reconnectDelay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          setTimeout(() => this.connect(), this.reconnectDelay);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error('❌ Max reconnection attempts reached. Stopping PumpfunStreamService.');
          this.isRunning = false;
        }
      });

    } catch (error: any) {
      console.error('❌ Error connecting to WebSocket:', error.message);
      if (this.isRunning && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        setTimeout(() => this.connect(), this.reconnectDelay);
      }
    }
  }

  /**
   * Přihlášení k odběru tradeů pro všechny smart wallets z DB
   */
  private async subscribeToWallets(): Promise<void> {
    try {
      const wallets = await this.smartWalletRepo.getAll();
      
      if (wallets.length === 0) {
        console.log('⚠️  No wallets to subscribe to');
        return;
      }

      // Cache timestampů pro tracking
      for (const wallet of wallets) {
        if (wallet.lastPumpfunTradeTimestamp) {
          this.walletTimestamps.set(wallet.address, wallet.lastPumpfunTradeTimestamp);
        }
      }

      const addresses = wallets.map(w => w.address);
      console.log(`📡 Subscribing to ${addresses.length} wallets...`);

      const payload = {
        method: 'subscribeAccountTrade',
        keys: addresses,
      };

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(payload));
        console.log(`✅ Subscribed to ${addresses.length} wallets`);
      } else {
        console.error('❌ WebSocket is not open, cannot subscribe');
      }
    } catch (error: any) {
      console.error('❌ Error subscribing to wallets:', error.message);
    }
  }

  /**
   * Zpracování zprávy z WebSocketu
   */
  private async handleMessage(message: any): Promise<void> {
    // Debug: log první zprávy, abychom viděli formát
    if (Math.random() < 0.1) { // 10% chance
      console.log('📨 WebSocket message sample:', JSON.stringify(message, null, 2).substring(0, 500));
    }

    // Zkus různé formáty zpráv
    // Formát 1: { type: 'accountTrade', data: { ... } }
    if (message.type === 'accountTrade' || message.method === 'accountTrade') {
      await this.handleAccountTrade(message.data || message);
      return;
    }

    // Formát 2: { account: '...', mint: '...', ... } (přímý objekt)
    if (message.account || message.wallet || message.buyer || message.seller) {
      await this.handleAccountTrade(message);
      return;
    }

    // Formát 3: { event: 'trade', ... }
    if (message.event === 'trade' || message.event === 'accountTrade') {
      await this.handleAccountTrade(message);
      return;
    }

    // Pokud nevíme, co to je, zaloguj to pro debugging
    console.log('⚠️  Unknown message format:', JSON.stringify(message, null, 2).substring(0, 500));
  }

  /**
   * Zpracování account trade zprávy
   */
  private async handleAccountTrade(data: any): Promise<void> {
    try {
      // Extrahuj wallet address
      const walletAddress = data.account || data.wallet || data.buyer || data.seller || data.user;
      if (!walletAddress) {
        return;
      }

      // Normalizuj trade pomocí PumpfunClient
      const trade = this.pumpfunClient.normalizeTradeMessage(data, walletAddress);
      if (!trade) {
        return;
      }

      // Zkontroluj, jestli trade už existuje
      const existingTrade = await this.tradeRepo.findBySignature(trade.txSignature);
      if (existingTrade) {
        return; // Trade už existuje
      }

      // Najdi wallet v DB
      const wallet = await this.smartWalletRepo.findByAddress(walletAddress);
      if (!wallet) {
        // Wallet není v našem seznamu (možná byla přidána později)
        return;
      }

      // Najdi nebo vytvoř token
      const token = await this.tokenRepo.findOrCreate({
        mintAddress: trade.tokenMint,
        symbol: undefined,
      });

      // Výpočet % změny pozice (kolik % tokenů přidal/odebral)
      let positionChangePercent: number | undefined = undefined;
      
      // Najdi všechny předchozí trendy pro tento token od této walletky (před aktuálním trade)
      const allTrades = await this.tradeRepo.findAllForMetrics(wallet.id);
      const tokenTrades = allTrades
        .filter(t => t.tokenId === token.id)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()); // Seřaď chronologicky
      
      // Vypočti aktuální pozici před tímto trade
      let currentPosition = 0;
      for (const prevTrade of tokenTrades) {
        if (prevTrade.txSignature === trade.txSignature) {
          break; // Zastav před aktuálním trade
        }
        if (prevTrade.side === 'buy') {
          currentPosition += Number(prevTrade.amountToken);
        } else if (prevTrade.side === 'sell') {
          currentPosition -= Number(prevTrade.amountToken);
        }
      }
      
      // Vypočti % změnu pozice
      // Omezení: pokud je currentPosition velmi malé (méně než 1% z amountToken),
      // považujeme to za novou pozici (100%) nebo prodej celé pozice (-100%)
      const MIN_POSITION_THRESHOLD = trade.amountToken * 0.01; // 1% z amountToken
      
      if (trade.side === 'buy') {
        // Koupil tokeny - přidal k pozici
        if (currentPosition > MIN_POSITION_THRESHOLD) {
          // Normální výpočet
          positionChangePercent = (trade.amountToken / currentPosition) * 100;
          // Omez na maximálně 1000% (10x) - pokud je více, je to pravděpodobně chyba
          if (positionChangePercent > 1000) {
            positionChangePercent = 100; // Považuj za novou pozici
          }
        } else {
          // První koupě nebo velmi malá pozice - 100% nová pozice
          positionChangePercent = 100;
        }
      } else if (trade.side === 'sell') {
        // Prodal tokeny - odebral z pozice
        if (currentPosition > MIN_POSITION_THRESHOLD) {
          // Normální výpočet
          positionChangePercent = -(trade.amountToken / currentPosition) * 100;
          // Omez na maximálně -100% (celý prodej pozice)
          if (positionChangePercent < -100) {
            positionChangePercent = -100; // Považuj za prodej celé pozice
          }
          // Pokud je abs(positionChangePercent) velmi velké (více než 1000%), je to pravděpodobně chyba
          if (Math.abs(positionChangePercent) > 1000) {
            positionChangePercent = -100; // Považuj za prodej celé pozice
          }
        } else {
          // Prodal, ale neměl pozici nebo velmi malou pozici
          // Pokud prodává víc, než má, je to chyba - označíme jako -100%
          if (trade.amountToken > currentPosition) {
            positionChangePercent = -100; // Prodej celé (malé) pozice
          } else {
            positionChangePercent = currentPosition > 0 
              ? -(trade.amountToken / currentPosition) * 100 
              : 0;
          }
        }
      }

      // Vytvoř trade záznam
      console.log(`💾 Saving Pump.fun trade: ${trade.txSignature.substring(0, 8)}... (${trade.side}, ${trade.amountToken.toFixed(4)} tokens, position change: ${positionChangePercent?.toFixed(2)}%)`);
      
      await this.tradeRepo.create({
        txSignature: trade.txSignature,
        walletId: wallet.id,
        tokenId: token.id,
        side: trade.side,
        amountToken: trade.amountToken,
        amountBase: trade.amountBase,
        priceBasePerToken: trade.priceBasePerToken,
        timestamp: trade.timestamp,
        dex: 'pumpfun',
        positionChangePercent,
        meta: trade.meta,
      });

      // Aktualizuj lastPumpfunTradeTimestamp
      const currentTimestamp = this.walletTimestamps.get(walletAddress);
      if (!currentTimestamp || trade.timestamp > currentTimestamp) {
        await this.smartWalletRepo.updateLastPumpfunTimestamp(wallet.id, trade.timestamp);
        this.walletTimestamps.set(walletAddress, trade.timestamp);
      }

      console.log(`✅ Pump.fun trade saved: ${trade.txSignature.substring(0, 8)}...`);

    } catch (error: any) {
      console.error('❌ Error handling account trade:', error.message);
      console.error('Trade data:', JSON.stringify(data, null, 2).substring(0, 500));
    }
  }

  /**
   * Zastavení WebSocket streamu
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    console.log('🛑 PumpfunStreamService stopped');
  }

  /**
   * Aktualizace seznamu sledovaných wallets (např. po přidání nové)
   */
  async refreshSubscriptions(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      await this.subscribeToWallets();
    }
  }
}

