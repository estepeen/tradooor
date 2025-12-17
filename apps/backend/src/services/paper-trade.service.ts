import { PaperTradeRepository, PaperTradeRecord } from '../repositories/paper-trade.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { prisma } from '../lib/prisma.js';

export interface PaperTradingConfig {
  enabled: boolean;
  copyAllTrades: boolean; // Kopírovat všechny trades, nebo jen vybrané wallets?
  walletIds?: string[]; // Pokud není copyAllTrades, kopírovat jen tyto wallets
  minWalletScore?: number; // Minimální score wallet pro kopírování
  positionSizePercent?: number; // % portfolia na trade (default: 5%)
  maxPositionSizeUsd?: number; // Max velikost pozice v USD
  maxOpenPositions?: number; // Max počet otevřených pozic najednou
  meta?: {
    model?: 'basic' | 'smart-copy' | 'consensus';
    riskLevel?: 'low' | 'medium' | 'high';
    qualityScore?: number;
    walletCount?: number;
    consensusTriggerTradeId?: string;
    [key: string]: any; // Allow additional meta fields
  };
}

export class PaperTradeService {
  public paperTradeRepo: PaperTradeRepository;
  private tradeRepo: TradeRepository;
  private smartWalletRepo: SmartWalletRepository;
  private tokenRepo: TokenRepository;

  constructor() {
    this.paperTradeRepo = new PaperTradeRepository();
    this.tradeRepo = new TradeRepository();
    this.smartWalletRepo = new SmartWalletRepository();
    this.tokenRepo = new TokenRepository();
  }

  /**
   * Kopíruje BUY trade jako paper trade
   */
  async copyBuyTrade(
    originalTradeId: string,
    config: PaperTradingConfig
  ): Promise<PaperTradeRecord | null> {
    // 1. Načti původní trade
    const originalTrade = await this.tradeRepo.findById(originalTradeId);
    if (!originalTrade) {
      throw new Error(`Trade not found: ${originalTradeId}`);
    }

    // 2. Validace - pouze BUY trades
    if (originalTrade.side !== 'buy') {
      console.log(`⏭️  Skipping ${originalTrade.side} trade (only copying BUY)`);
      return null;
    }

    // 3. Validace - pouze non-void trades
    if ((originalTrade.side as string).toLowerCase() === 'void') {
      console.log(`⏭️  Skipping void trade`);
      return null;
    }

    // 4. Validace wallet (pokud je filtrování zapnuté)
    if (!config.copyAllTrades && config.walletIds) {
      if (!config.walletIds.includes(originalTrade.walletId)) {
        console.log(`⏭️  Skipping trade from wallet ${originalTrade.walletId} (not in allowed list)`);
        return null;
      }
    }

    // 5. Validace wallet score
    if (config.minWalletScore !== undefined) {
      const wallet = await this.smartWalletRepo.findById(originalTrade.walletId);
      if (!wallet || wallet.score < config.minWalletScore) {
        console.log(`⏭️  Skipping trade from wallet ${originalTrade.walletId} (score ${wallet?.score || 0} < ${config.minWalletScore})`);
        return null;
      }
    }

    // 6. Validace max otevřených pozic
    if (config.maxOpenPositions) {
      const openPositions = await this.paperTradeRepo.findOpenPositions();
      if (openPositions.length >= config.maxOpenPositions) {
        console.log(`⏭️  Skipping trade (max open positions reached: ${openPositions.length}/${config.maxOpenPositions})`);
        return null;
      }
    }

    // 7. Zkontroluj, jestli už tento trade není zkopírovaný
    const existing = await this.paperTradeRepo.findByWallet(originalTrade.walletId, {
      status: 'open',
      limit: 1000,
    });
    const alreadyCopied = existing.some(pt => pt.originalTradeId === originalTradeId);
    if (alreadyCopied) {
      console.log(`⏭️  Trade ${originalTradeId} already copied`);
      return null;
    }

    // 8. Vypočti position size
    const positionSize = await this.calculatePositionSize(originalTrade, config);

    // 9. Vytvoř paper trade
    // Vypočti amountToken na základě position size a ceny
    const amountToken = positionSize.amountBase / Number(originalTrade.priceBasePerToken);

    const paperTrade = await this.paperTradeRepo.create({
      walletId: originalTrade.walletId,
      tokenId: originalTrade.tokenId,
      originalTradeId: originalTradeId,
      side: 'buy',
      amountToken: amountToken,
      amountBase: positionSize.amountBase,
      priceBasePerToken: Number(originalTrade.priceBasePerToken),
      timestamp: new Date(originalTrade.timestamp),
      status: 'open',
      meta: {
        copiedFrom: originalTradeId,
        originalAmountToken: Number(originalTrade.amountToken),
        originalAmountBase: Number(originalTrade.amountBase),
        positionSizePercent: config.positionSizePercent || 5,
        model: config.meta?.model || 'basic',
        riskLevel: config.meta?.riskLevel,
        qualityScore: config.meta?.qualityScore,
      },
    });

    console.log(`✅ Copied BUY trade: ${originalTradeId} → PaperTrade ${paperTrade.id}`);
    return paperTrade;
  }

  /**
   * Uzavře paper trade (SELL) když původní trader prodal
   */
  async closePaperTrade(
    originalSellTradeId: string,
    config: PaperTradingConfig
  ): Promise<PaperTradeRecord | null> {
    // 1. Načti původní SELL trade
    const originalSellTrade = await this.tradeRepo.findById(originalSellTradeId);
    if (!originalSellTrade || originalSellTrade.side !== 'sell') {
      return null;
    }

    // 2. Najdi otevřenou paper trade pozici pro tento token a wallet
    const openPositions = await this.paperTradeRepo.findOpenPositions(originalSellTrade.walletId);
    const matchingPosition = openPositions.find(
      pos => pos.tokenId === originalSellTrade.tokenId && pos.walletId === originalSellTrade.walletId
    );

    if (!matchingPosition) {
      console.log(`⏭️  No open paper position found for SELL trade ${originalSellTradeId}`);
      return null;
    }

    // 3. Vypočti realized PnL
    const entryPrice = matchingPosition.priceBasePerToken;
    const exitPrice = Number(originalSellTrade.priceBasePerToken);
    const realizedPnl = (exitPrice - entryPrice) * matchingPosition.amountToken;
    const realizedPnlPercent = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;

    // 4. Uzavři pozici
    const closedTrade = await this.paperTradeRepo.update(matchingPosition.id, {
      status: 'closed',
      realizedPnl,
      realizedPnlPercent,
      closedAt: new Date(originalSellTrade.timestamp),
      meta: {
        ...matchingPosition.meta,
        closedBy: originalSellTradeId,
        exitPrice,
        entryPrice,
      },
    });

    console.log(`✅ Closed paper trade: ${matchingPosition.id} → PnL: ${realizedPnl.toFixed(2)} USD (${realizedPnlPercent.toFixed(2)}%)`);
    return closedTrade;
  }

  /**
   * Uzavře paper trade kvůli stop loss (50% ztráta)
   * @param paperTradeId ID paper trade k uzavření
   * @param currentPrice Aktuální cena tokenu
   */
  async closePaperTradeStopLoss(
    paperTradeId: string,
    currentPrice: number
  ): Promise<PaperTradeRecord | null> {
    // 1. Načti paper trade
    const paperTrade = await this.paperTradeRepo.findById(paperTradeId);
    if (!paperTrade || paperTrade.status !== 'open') {
      return null;
    }

    // 2. Vypočti PnL
    const entryPrice = paperTrade.priceBasePerToken;
    const exitPrice = currentPrice;
    const realizedPnl = (exitPrice - entryPrice) * paperTrade.amountToken;
    const realizedPnlPercent = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;

    // 3. Uzavři pozici
    const closedTrade = await this.paperTradeRepo.update(paperTradeId, {
      status: 'closed',
      realizedPnl,
      realizedPnlPercent,
      closedAt: new Date(),
      meta: {
        ...paperTrade.meta,
        closedBy: 'stop-loss',
        exitPrice,
        entryPrice,
        stopLossTriggered: true,
      },
    });

    console.log(`🛑 Stop Loss triggered for paper trade ${paperTradeId} → PnL: ${realizedPnl.toFixed(2)} USD (${realizedPnlPercent.toFixed(2)}%)`);
    return closedTrade;
  }

  /**
   * Zkontroluje všechny otevřené pozice a uzavře ty, které dosáhly stop loss (50% ztráta)
   */
  async checkStopLosses(): Promise<number> {
    const STOP_LOSS_PERCENT = -50; // 50% ztráta
    let closedCount = 0;

    try {
      // 1. Načti všechny otevřené pozice
      const openPositions = await this.paperTradeRepo.findOpenPositions();

      // 2. Pro každou pozici zkontroluj aktuální cenu a PnL
      for (const position of openPositions) {
        try {
          // Získej aktuální cenu tokenu z posledního trade pro tento token
          const latestTrades = await prisma.trade.findMany({
            where: {
              tokenId: position.tokenId,
            },
            select: {
              priceBasePerToken: true,
              timestamp: true,
            },
            orderBy: {
              timestamp: 'desc',
            },
            take: 1,
          });

          if (!latestTrades || latestTrades.length === 0) {
            // Pokud není dostupná aktuální cena, přeskoč
            continue;
          }

          const latestTrade = latestTrades[0];
          const currentPrice = Number(latestTrade.priceBasePerToken);
          const entryPrice = position.priceBasePerToken;
          
          if (entryPrice <= 0) {
            continue;
          }

          const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

          // 3. Pokud je ztráta >= 50%, uzavři pozici
          if (pnlPercent <= STOP_LOSS_PERCENT) {
            await this.closePaperTradeStopLoss(position.id, currentPrice);
            closedCount++;
          }
        } catch (error: any) {
          console.error(`❌ Error checking stop loss for position ${position.id}:`, error.message);
        }
      }

      if (closedCount > 0) {
        console.log(`🛑 Closed ${closedCount} positions due to stop loss (50% loss)`);
      }

      return closedCount;
    } catch (error: any) {
      console.error('❌ Error checking stop losses:', error.message);
      return 0;
    }
  }

  /**
   * Vypočítá velikost pozice pro paper trade
   */
  private async calculatePositionSize(
    originalTrade: any,
    config: PaperTradingConfig
  ): Promise<{ amountToken: number; amountBase: number }> {
    const INITIAL_CAPITAL_USD = 1000;
    const originalAmountBase = Number(originalTrade.amountBase);
    
    // Získej aktuální portfolio value
    const portfolioStats = await this.paperTradeRepo.getPortfolioStats();
    const currentPortfolioValue = portfolioStats.totalValueUsd || INITIAL_CAPITAL_USD;
    
    // Pokud je nastaven max position size, použij ho
    if (config.maxPositionSizeUsd) {
      const positionSize = Math.min(originalAmountBase, config.maxPositionSizeUsd);
      const ratio = positionSize / originalAmountBase;
      return {
        amountToken: Number(originalTrade.amountToken) * ratio,
        amountBase: positionSize,
      };
    }

    // Pokud je nastaven position size percent, použij ho z aktuálního portfolia
    const positionSizePercent = config.positionSizePercent || 5;
    const positionSize = (currentPortfolioValue * positionSizePercent) / 100;
    
    // Omezení na min/max
    const MIN_POSITION_SIZE_PERCENT = 5;
    const MAX_POSITION_SIZE_PERCENT = 20;
    const minPositionUsd = (currentPortfolioValue * MIN_POSITION_SIZE_PERCENT) / 100;
    const maxPositionUsd = (currentPortfolioValue * MAX_POSITION_SIZE_PERCENT) / 100;
    const finalPositionSize = Math.max(minPositionUsd, Math.min(maxPositionUsd, positionSize));

    return {
      amountToken: 0, // Bude vypočítáno z positionSize a price
      amountBase: finalPositionSize,
    };
  }

  /**
   * Získá aktuální portfolio stats
   */
  async getPortfolioStats() {
    return await this.paperTradeRepo.getPortfolioStats();
  }

  /**
   * Vytvoří portfolio snapshot
   */
  async createPortfolioSnapshot() {
    const stats = await this.getPortfolioStats();
    return await this.paperTradeRepo.createPortfolioSnapshot(stats);
  }
}
