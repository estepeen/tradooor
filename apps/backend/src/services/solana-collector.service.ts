import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { HeliusClient } from './helius-client.service.js';
import { TokenMetadataBatchService } from './token-metadata-batch.service.js';
import { TokenPriceService } from './token-price.service.js';
import { SolPriceService } from './sol-price.service.js';

/**
 * Service for processing Solana transactions from Helius webhooks
 * This service normalizes transactions and saves them as trades
 */
export class SolanaCollectorService {
  private heliusClient: HeliusClient;
  private tokenMetadataBatchService: TokenMetadataBatchService;
  private tokenPriceService: TokenPriceService;
  private solPriceService: SolPriceService;

  constructor(
    private smartWalletRepo: SmartWalletRepository,
    private tradeRepo: TradeRepository,
    private tokenRepo: TokenRepository,
    private walletQueueRepo: WalletProcessingQueueRepository
  ) {
    this.heliusClient = new HeliusClient();
    this.tokenMetadataBatchService = new TokenMetadataBatchService(this.heliusClient, this.tokenRepo);
    this.tokenPriceService = new TokenPriceService();
    this.solPriceService = new SolPriceService();
  }

  /**
   * Process a single webhook transaction
   * Normalizes the transaction and saves it as a trade
   * Returns { saved: boolean, reason?: string }
   */
  async processWebhookTransaction(tx: any, walletAddress: string): Promise<{ saved: boolean; reason?: string }> {
    try {
      // 1. Normalize swap
      const normalized = await this.heliusClient.normalizeSwap(tx, walletAddress);
      if (!normalized) {
        return { saved: false, reason: 'not a swap' };
      }

      // 2. Find or create wallet
      const wallet = await this.smartWalletRepo.findByAddress(walletAddress);
      if (!wallet) {
        return { saved: false, reason: 'wallet not found' };
      }

      // 3. Find or create token
      let token = await this.tokenRepo.findOrCreate({
        mintAddress: normalized.tokenMint,
      });

      // 4. DŮLEŽITÉ: Fetch token metadata if missing - MUSÍME POČKAT na výsledek před uložením trade!
      // Pokud token nemá symbol/name, zkusíme fetchovat z Birdeye/DexScreener/Metaplex/Helius
      if (!token.symbol || !token.name) {
        try {
          console.log(`   🔍 Token ${normalized.tokenMint.substring(0, 8)}... missing metadata, fetching from Birdeye/DexScreener/Metaplex...`);
          const metadataMap = await this.tokenMetadataBatchService.getTokenMetadataBatch([normalized.tokenMint]);
          const metadata = metadataMap.get(normalized.tokenMint);
          
          if (metadata && (metadata.symbol || metadata.name)) {
            // Metadata byla úspěšně načtena a uložena do DB přes getTokenMetadataBatch
            // Znovu načteme token z DB, aby měl aktualizované symbol/name
            const updatedToken = await this.tokenRepo.findByMintAddress(normalized.tokenMint);
            if (updatedToken) {
              token = updatedToken;
              console.log(`   ✅ Token metadata fetched: ${token.symbol || 'N/A'} / ${token.name || 'N/A'}`);
            } else {
              console.warn(`   ⚠️  Token metadata fetched but token not found in DB after update`);
            }
          } else {
            console.warn(`   ⚠️  Token metadata fetch returned no symbol/name for ${normalized.tokenMint.substring(0, 8)}...`);
          }
        } catch (error: any) {
          console.warn(`⚠️  Failed to fetch metadata for ${normalized.tokenMint.substring(0, 8)}...:`, error.message);
          // Pokračujeme i když fetch selhal - trade se uloží bez symbol/name
        }
      }

      // 5. Calculate USD value
      let valueUsd: number | undefined;
      try {
        if (normalized.baseToken === 'SOL') {
          const solPrice = await this.solPriceService.getSolPriceUsd();
          valueUsd = normalized.amountBase * solPrice;
        } else {
          // For USDC/USDT, 1:1 with USD
          valueUsd = normalized.amountBase;
        }
        } catch (error: any) {
        console.warn(`⚠️  Failed to calculate USD value:`, error.message);
      }

      // 6. Determine correct TYPE (buy/add/remove/sell) based on balance before and after
      // Get all previous trades for this wallet and token to calculate balance
      const previousTrades = await this.tradeRepo.findAllForMetrics(wallet.id);
      const tokenTrades = previousTrades
        .filter(t => t.tokenId === token.id)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      
      // Calculate balance before this trade
      let balanceBefore = 0;
      for (const prevTrade of tokenTrades) {
        const prevSide = prevTrade.side;
        const prevAmount = Number(prevTrade.amountToken);
        if (prevSide === 'buy' || prevSide === 'add') {
          balanceBefore += prevAmount;
        } else if (prevSide === 'sell' || prevSide === 'remove') {
          balanceBefore = Math.max(0, balanceBefore - prevAmount);
        }
      }

      // Calculate balance after this trade
      const normalizedBalanceBefore = Math.abs(balanceBefore) < 0.000001 ? 0 : balanceBefore;
      const isBuy = normalized.side === 'buy';
      const balanceAfter = isBuy 
        ? balanceBefore + normalized.amountToken
        : Math.max(0, balanceBefore - normalized.amountToken);
      const normalizedBalanceAfter = Math.abs(balanceAfter) < 0.000001 ? 0 : balanceAfter;

      // Determine correct TYPE
      let correctSide: 'buy' | 'sell' | 'add' | 'remove';
      if (isBuy) {
        // BUY: balanceBefore === 0 a balanceAfter > 0 (první nákup)
        // ADD: balanceBefore > 0 a balanceAfter > balanceBefore (další nákup)
        if (normalizedBalanceBefore === 0) {
          correctSide = 'buy';
        } else {
          correctSide = 'add';
        }
        } else {
        // SELL: balanceAfter === 0 nebo velmi blízko 0 (poslední prodej, kdy balance klesne na 0)
        // REM: balanceAfter > 0 (částečný prodej, balance zůstává > 0)
        // DŮLEŽITÉ: Použij tolerance pro zaokrouhlování (pokud je balanceAfter < 0.000001, považuj to za 0)
        const EPS = 0.000001;
        if (normalizedBalanceAfter < EPS) {
          correctSide = 'sell';
        } else {
          correctSide = 'remove';
        }
      }

      // Calculate positionChangePercent (procentuální změna pozice)
      let positionChangePercent: number | undefined = undefined;
      if (isBuy) {
        // BUY nebo ADD
        if (normalizedBalanceBefore === 0) {
          // První nákup (BUY) - pozice se vytváří, takže 100% změna
          positionChangePercent = 100;
        } else {
          // Další nákup (ADD) - počítáme % změnu z existující pozice
          positionChangePercent = (normalized.amountToken / balanceBefore) * 100;
          // Omezíme na rozumné hodnoty (max 1000%, pak ořízneme na 100%)
          if (positionChangePercent > 1000) {
            positionChangePercent = 100;
          }
        }
        } else {
        // REM nebo SELL
        if (normalizedBalanceBefore === 0) {
          // Nemůžeme prodávat, když nemáme pozici
          positionChangePercent = 0;
        } else if (normalizedBalanceAfter === 0) {
          // SELL - prodáváme všechno, takže -100%
          positionChangePercent = -100;
        } else {
          // REM - částečný prodej, počítáme % změnu z existující pozice
          positionChangePercent = -(normalized.amountToken / balanceBefore) * 100;
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

      // 7. Save trade
      const existing = await this.tradeRepo.findBySignature(normalized.txSignature);
      if (existing) {
        return { saved: false, reason: 'duplicate' };
      }

      await this.tradeRepo.create({
        txSignature: normalized.txSignature,
        walletId: wallet.id,
        tokenId: token.id,
        side: correctSide, // Use calculated TYPE instead of normalized.side
        amountToken: normalized.amountToken,
        amountBase: normalized.amountBase,
        priceBasePerToken: normalized.priceBasePerToken,
        timestamp: normalized.timestamp,
        dex: normalized.dex,
        valueUsd,
        positionChangePercent, // Calculate and save positionChangePercent at save time
        meta: {
          source: 'helius-webhook',
          baseToken: normalized.baseToken,
        },
      });

      // 7. Enqueue wallet for metrics recalculation
      try {
        await this.walletQueueRepo.enqueue(wallet.id);
      } catch (queueError: any) {
        console.warn(`⚠️  Failed to enqueue wallet ${walletAddress} for metrics recalculation: ${queueError.message}`);
      }

      return { saved: true };
    } catch (error: any) {
      console.error(`❌ Error processing webhook transaction:`, error);
      return { saved: false, reason: error.message || 'unknown error' };
    }
  }
}
