/**
 * Minimal Solana collector that only processes webhook payloads.
 * All historical fetching has been removed - only webhook processing remains.
 */

import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { HeliusClient, type HeliusSwap } from './helius-client.service.js';
import { TokenPriceService } from './token-price.service.js';
import { SolPriceService } from './sol-price.service.js';
import { MetricsCalculatorService } from './metrics-calculator.service.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';

export class SolanaCollectorService {
  private heliusClient: HeliusClient;
  private tokenPriceService: TokenPriceService;
  private solPriceService: SolPriceService;
  private metricsCalculator: MetricsCalculatorService;

  constructor(
    private smartWalletRepo: SmartWalletRepository,
    private tradeRepo: TradeRepository,
    private tokenRepo: TokenRepository
  ) {
    this.heliusClient = new HeliusClient();
    this.tokenPriceService = new TokenPriceService();
    this.solPriceService = new SolPriceService();
    const metricsHistoryRepo = new MetricsHistoryRepository();
    this.metricsCalculator = new MetricsCalculatorService(
      smartWalletRepo,
      tradeRepo,
      metricsHistoryRepo
    );
  }

  /**
   * Process a single webhook transaction
   * Returns { saved: boolean, reason?: string }
   */
  async processWebhookTransaction(
    heliusTx: HeliusSwap,
    walletAddress: string
  ): Promise<{ saved: boolean; reason?: string }> {
    try {
      // Normalize swap using HeliusClient
      const swap = this.heliusClient.normalizeSwap(heliusTx, walletAddress);
      if (!swap) {
        return { saved: false, reason: 'not a swap or no matching transfers' };
      }

      // Get wallet
      const wallet = await this.smartWalletRepo.findByAddress(walletAddress);
      if (!wallet) {
        return { saved: false, reason: 'wallet not found' };
      }

      // Get or create token
      let token = await this.tokenRepo.findByMintAddress(swap.tokenMint);
      if (!token) {
        // Create token with minimal info (metadata will be enriched later if needed)
        token = await this.tokenRepo.create({
          mintAddress: swap.tokenMint,
          symbol: null,
          name: null,
          decimals: 9, // Default, will be updated when metadata is fetched
        });
      }

      // Check if trade already exists (duplicate check)
      const existing = await this.tradeRepo.findBySignature(swap.txSignature);
      if (existing) {
        return { saved: false, reason: 'duplicate' };
      }

      // Calculate USD values
      let valueUsd = 0;
      let priceUsd: number | null = null;

      try {
        // Try to get token price at trade timestamp
        priceUsd = await this.tokenPriceService.getTokenPriceAtDate(
          swap.tokenMint,
          swap.timestamp
        );

        if (priceUsd !== null && priceUsd > 0) {
          valueUsd = swap.amountToken * priceUsd;
        } else {
          // Fallback: use SOL price
          valueUsd = await this.solPriceService.solToUsdAtDate(
            swap.amountBase,
            swap.timestamp
          );
        }
      } catch (error: any) {
        console.warn(`⚠️  Failed to get price for trade ${swap.txSignature.substring(0, 16)}...:`, error.message);
        // Continue without USD value
      }

      // Save trade
      await this.tradeRepo.create({
        txSignature: swap.txSignature,
        walletId: wallet.id,
        tokenId: token.id,
        side: swap.side,
        amountToken: swap.amountToken,
        amountBase: swap.amountBase,
        priceBasePerToken: swap.priceBasePerToken,
        timestamp: swap.timestamp,
        dex: swap.dex,
        valueUsd: valueUsd > 0 ? valueUsd : undefined,
        meta: {
          source: 'helius-webhook',
          baseToken: swap.baseToken,
          priceUsd: priceUsd,
        },
      });

      // Recalculate metrics for wallet (async, don't wait)
      this.metricsCalculator.calculateMetricsForWallet(wallet.id).catch((error: any) => {
        console.warn(`⚠️  Failed to recalculate metrics for wallet ${wallet.id}:`, error.message);
      });

      return { saved: true };
    } catch (error: any) {
      console.error(`❌ Error processing webhook transaction:`, error);
      return { saved: false, reason: error.message || 'unknown error' };
    }
  }
}

