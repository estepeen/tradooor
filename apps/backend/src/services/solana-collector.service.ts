import dotenv from 'dotenv';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { HeliusClient } from './helius-client.service.js';
import { SolPriceService } from './sol-price.service.js';

dotenv.config();

const MIN_NOTIONAL_USD = Number(process.env.MIN_NOTIONAL_USD || 0);

/**
 * Minimal Solana collector that only processes webhook payloads.
 * Historical backfills and manual collectors were removed to avoid runaway API usage.
 */
export class SolanaCollectorService {
  private heliusClient: HeliusClient;
  private solPriceService: SolPriceService;

  constructor(
    private smartWalletRepo: SmartWalletRepository,
    private tradeRepo: TradeRepository,
    private tokenRepo: TokenRepository,
    private walletQueueRepo: WalletProcessingQueueRepository = new WalletProcessingQueueRepository()
  ) {
    this.heliusClient = new HeliusClient(process.env.HELIUS_API_KEY);
    this.solPriceService = new SolPriceService();
  }

  /**
   * Process webhook transaction flow:
   * 1. Helius webhook normalizes swap data
   * 2. Binance provides SOL price
   * 3. Birdeye provides token name/symbol
   * 4. Determine TYPE (buy, sell, add, remove)
   * 5. Calculate POSITION (positionChangePercent)
   */
  async processWebhookTransaction(
    tx: any,
    walletAddress: string
  ): Promise<{ saved: boolean; reason?: string }> {
    try {
      // Step 0: Validate wallet and check for duplicates
      const wallet = await this.smartWalletRepo.findByAddress(walletAddress);
      if (!wallet) {
        return { saved: false, reason: 'Wallet not found in DB' };
      }

      const existing = await this.tradeRepo.findBySignature(tx.signature);
      if (existing) {
        return { saved: false, reason: 'Trade already exists' };
      }

      // Step 1: Helius webhook normalizes swap data
      const swap = this.heliusClient.normalizeSwap(tx, walletAddress);
      if (!swap) {
        return { saved: false, reason: 'Failed to normalize swap' };
      }

      // Step 2: Binance provides SOL price (for USD calculations)
      const { BinancePriceService } = await import('./binance-price.service.js');
      const binancePriceService = new BinancePriceService();
      const solPriceAtTimestamp = await binancePriceService.getSolPriceAtTimestamp(swap.timestamp);

      // Step 3: Birdeye provides token name/symbol (via TokenMetadataBatchService)
      const { TokenMetadataBatchService } = await import('./token-metadata-batch.service.js');
      const tokenMetadataBatchService = new TokenMetadataBatchService(
        this.heliusClient,
        this.tokenRepo
      );
      const tokenMetadata = await tokenMetadataBatchService.getTokenMetadataBatch([swap.tokenMint]);
      const metadata = tokenMetadata.get(swap.tokenMint) || {};

      // Save/update token with metadata
      const token = await this.tokenRepo.findOrCreate({
        mintAddress: swap.tokenMint,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals,
        forceUpdate: true, // Always try to update metadata if available
      });

      // Calculate USD value
      const { TokenPriceService } = await import('./token-price.service.js');
      const tokenPriceService = new TokenPriceService();
      
      let valueUsd = 0;
      const tokenPriceUsd = await tokenPriceService.getTokenPriceAtDate(
        swap.tokenMint,
        swap.timestamp
      );
      if (tokenPriceUsd !== null && tokenPriceUsd > 0) {
        valueUsd = swap.amountToken * tokenPriceUsd;
      } else {
        valueUsd = await this.solPriceService.solToUsdAtDate(swap.amountBase, swap.timestamp);
      }

      if (MIN_NOTIONAL_USD > 0 && valueUsd < MIN_NOTIONAL_USD) {
        return { saved: false, reason: `Value ${valueUsd.toFixed(2)} USD below threshold $${MIN_NOTIONAL_USD}` };
      }
      
      // Get all trades for this wallet and token to calculate position
      const allTrades = await this.tradeRepo.findAllForMetrics(wallet.id);
      const tokenTrades = allTrades
        .filter(t => t.tokenId === token.id)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // Calculate balance before this trade
      let balanceBefore = 0;
      let hasPreviousTrades = false;
      for (const prevTrade of tokenTrades) {
        if (prevTrade.txSignature === swap.txSignature) {
          break;
        }
        hasPreviousTrades = true;
        if (prevTrade.side === 'buy' || prevTrade.side === 'add') {
          balanceBefore += Number(prevTrade.amountToken);
        } else if (prevTrade.side === 'sell' || prevTrade.side === 'remove') {
          balanceBefore -= Number(prevTrade.amountToken);
        }
      }

      const balanceAfter =
        swap.side === 'buy' ? balanceBefore + swap.amountToken : balanceBefore - swap.amountToken;
      const normalizedBalanceBefore = Math.abs(balanceBefore) < 0.000001 ? 0 : balanceBefore;
      const normalizedBalanceAfter = Math.abs(balanceAfter) < 0.000001 ? 0 : balanceAfter;

      // Step 4: Determine TYPE (buy, sell, add, remove)
      // BUY = první nákup tokenu, když se balance změní z 0 na >0
      // ADD = každý další nákup/přikoupení, když už máme balance > 0
      // REM = odprodej tokenů (ne nikdy 100%), když balance zůstává > 0
      // SELL = poslední prodej tokenu, kdy balance = 0
      let tradeType: 'buy' | 'sell' | 'add' | 'remove' = swap.side;
      
      if (swap.side === 'buy') {
        // BUY: balanceBefore === 0 a balanceAfter > 0 (první nákup)
        // ADD: balanceBefore > 0 a balanceAfter > balanceBefore (další nákup)
        if (normalizedBalanceBefore === 0) {
          tradeType = 'buy';
        } else {
          tradeType = 'add';
        }
      } else if (swap.side === 'sell') {
        // SELL: balanceAfter === 0 (poslední prodej, kdy balance klesne na 0)
        // REM: balanceAfter > 0 (částečný prodej, balance zůstává > 0)
        if (normalizedBalanceAfter === 0) {
          tradeType = 'sell';
        } else {
          tradeType = 'remove';
        }
      }

      // Step 5: Calculate POSITION (positionChangePercent)
      // Pro BUY/ADD: % změna pozice = (amountToken / balanceBefore) * 100
      // Pro REM/SELL: % změna pozice = -(amountToken / balanceBefore) * 100
      let positionChangePercent: number | undefined = undefined;
      const MIN_POSITION_THRESHOLD = 0.000001; // Minimální threshold pro považování za nenulovou pozici

      if (swap.side === 'buy') {
        // BUY nebo ADD
        if (normalizedBalanceBefore === 0) {
          // První nákup (BUY) - pozice se vytváří, takže 100% změna
          positionChangePercent = 100;
        } else {
          // Další nákup (ADD) - počítáme % změnu z existující pozice
          positionChangePercent = (swap.amountToken / balanceBefore) * 100;
          // Omezíme na rozumné hodnoty (max 1000%, pak ořízneme na 100%)
          if (positionChangePercent > 1000) {
            positionChangePercent = 100;
          }
        }
      } else if (swap.side === 'sell') {
        // REM nebo SELL
        if (normalizedBalanceBefore === 0) {
          // Nemůžeme prodávat, když nemáme pozici
          positionChangePercent = 0;
        } else if (normalizedBalanceAfter === 0) {
          // SELL - prodáváme všechno, takže -100%
          positionChangePercent = -100;
        } else {
          // REM - částečný prodej, počítáme % změnu z existující pozice
          positionChangePercent = -(swap.amountToken / balanceBefore) * 100;
          // Omezíme na rozumné hodnoty (min -100%)
          if (positionChangePercent < -100) {
            positionChangePercent = -100;
          }
          // Pokud je změna větší než 1000%, ořízneme na -100%
          if (Math.abs(positionChangePercent) > 1000) {
            positionChangePercent = -100;
          }
        }
      }

      let pnlUsd: number | undefined = undefined;
      let pnlPercent: number | undefined = undefined;

      if (swap.side === 'sell') {
        const openBuys = tokenTrades
          .filter(t => t.side === 'buy' && t.txSignature !== swap.txSignature)
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        const matchingBuy = openBuys.find(buy => {
          const sellsAfterBuy = tokenTrades.filter(
            t =>
            t.side === 'sell' && 
            new Date(t.timestamp) > new Date(buy.timestamp) &&
            t.txSignature !== swap.txSignature
          );
          return sellsAfterBuy.length === 0;
        });

        if (matchingBuy) {
          const proceedsBase = swap.amountBase;
          const costBase = Number(matchingBuy.amountBase);
          const realizedPnlBase = proceedsBase - costBase;
          const realizedPnlPercentBase = costBase > 0 ? (realizedPnlBase / costBase) * 100 : 0;

          try {
            const currentSolPrice = await this.solPriceService.getSolPriceUsd();
            if (currentSolPrice > 0) {
              const baseToken = swap.baseToken || 'SOL';
              pnlUsd =
                baseToken === 'USDC' || baseToken === 'USDT'
                  ? realizedPnlBase
                  : realizedPnlBase * currentSolPrice;
              pnlPercent = realizedPnlPercentBase;
            }
          } catch {
            // ignore price lookup failure
          }
        }
      }

      // Calculate USD price using Binance SOL price
      let priceUsd: number | null = null;
      try {
        const baseToken = swap.baseToken || 'SOL';
        if (baseToken === 'SOL') {
          priceUsd = swap.priceBasePerToken * solPriceAtTimestamp;
        } else if (baseToken === 'USDC' || baseToken === 'USDT') {
          priceUsd = swap.priceBasePerToken;
        } else {
          priceUsd = swap.priceBasePerToken * solPriceAtTimestamp;
        }
      } catch (error: any) {
        console.warn(`⚠️  Failed to calculate priceUsd for trade ${swap.txSignature}: ${error.message}`);
      }

      const trade = await this.tradeRepo.create({
        txSignature: swap.txSignature,
        walletId: wallet.id,
        tokenId: token.id,
        side: tradeType,
        amountToken: swap.amountToken,
        amountBase: swap.amountBase,
        priceBasePerToken: swap.priceBasePerToken,
        timestamp: swap.timestamp,
        dex: swap.dex,
        valueUsd,
        pnlUsd,
        pnlPercent,
        positionChangePercent,
        meta: {
          source: 'helius-webhook',
          heliusType: tx.type,
          heliusSource: tx.source,
          baseToken: swap.baseToken || 'SOL',
          priceUsd,
          balanceBefore,
          balanceAfter,
        },
      });

      try {
        await this.walletQueueRepo.enqueue(wallet.id, 'metrics');
      } catch (error: any) {
        console.warn(`⚠️  Failed to enqueue wallet ${wallet.id} for metrics processing: ${error.message}`);
      }

      return { saved: true };
    } catch (error: any) {
      console.error('❌ Error processing webhook transaction:', error);
      return { saved: false, reason: error.message };
    }
  }
}

