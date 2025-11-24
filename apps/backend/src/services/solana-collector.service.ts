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
      const token = await this.tokenRepo.findOrCreate({
        mintAddress: normalized.tokenMint,
      });

      // 4. Fetch token metadata if missing
      if (!token.symbol || !token.name) {
        try {
          await this.tokenMetadataBatchService.enrichTokenMetadata([normalized.tokenMint]);
        } catch (error: any) {
          console.warn(`⚠️  Failed to fetch metadata for ${normalized.tokenMint.substring(0, 8)}...:`, error.message);
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

      // 6. Save trade
      const existing = await this.tradeRepo.findBySignature(normalized.txSignature);
      if (existing) {
        return { saved: false, reason: 'duplicate' };
      }

      await this.tradeRepo.create({
        txSignature: normalized.txSignature,
        walletId: wallet.id,
        tokenId: token.id,
        side: normalized.side,
        amountToken: normalized.amountToken,
        amountBase: normalized.amountBase,
        priceBasePerToken: normalized.priceBasePerToken,
        timestamp: normalized.timestamp,
        dex: normalized.dex,
        valueUsd,
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
