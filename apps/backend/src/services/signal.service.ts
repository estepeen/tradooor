import { SignalRepository, SignalRecord } from '../repositories/signal.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { PaperTradingModelsService, TradeQuality } from './paper-trading-models.service.js';
import { PaperTradeService } from './paper-trade.service.js';

export interface SignalGenerationConfig {
  minQualityScore?: number; // Minimální score pro generování signálu (default: 40)
  enableSmartCopy?: boolean; // Generovat signály z Smart Copy modelu
  enableConsensus?: boolean; // Generovat signály z Consensus modelu
  signalExpirationHours?: number; // Po kolika hodinách signál expiruje (default: 24)
  // sendToDiscord?: boolean; // TODO: Implementovat později
  // sendToTelegram?: boolean; // TODO: Implementovat později
}

export class SignalService {
  private signalRepo: SignalRepository;
  private tradeRepo: TradeRepository;
  private paperTradingModels: PaperTradingModelsService;
  private paperTradeService: PaperTradeService;

  constructor() {
    this.signalRepo = new SignalRepository();
    this.tradeRepo = new TradeRepository();
    this.paperTradingModels = new PaperTradingModelsService();
    this.paperTradeService = new PaperTradeService();
  }

  /**
   * Vygeneruje BUY signál z trade
   */
  async generateBuySignal(
    tradeId: string,
    config: SignalGenerationConfig = {}
  ): Promise<SignalRecord | null> {
    const minQualityScore = config.minQualityScore || 40;
    const enableSmartCopy = config.enableSmartCopy !== false; // Default: true
    const enableConsensus = config.enableConsensus !== false; // Default: true

    // 1. Načti trade
    const trade = await this.tradeRepo.findById(tradeId);
    if (!trade || trade.side !== 'buy') {
      return null;
    }

    // 2. Zkontroluj, jestli už není signál pro tento trade
    const existing = await this.signalRepo.findActive({
      walletId: trade.walletId,
      tokenId: trade.tokenId,
      type: 'buy',
    });
    const alreadyExists = existing.some(s => s.originalTradeId === tradeId);
    if (alreadyExists) {
      console.log(`⏭️  Signal already exists for trade ${tradeId}`);
      return null;
    }

    // 3. Vyhodnoť trade pomocí Smart Copy modelu
    let quality: TradeQuality | null = null;
    if (enableSmartCopy) {
      quality = await this.paperTradingModels.evaluateTradeForSmartCopy(tradeId);
      
      // Pokud score není dostatečný, přeskoč
      if (quality.score < minQualityScore) {
        console.log(`⏭️  Trade ${tradeId} score ${quality.score.toFixed(1)} < ${minQualityScore}, skipping signal`);
        return null;
      }
    }

    // 4. Vytvoř signál
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + (config.signalExpirationHours || 24));

    const signal = await this.signalRepo.create({
      type: 'buy',
      walletId: trade.walletId,
      tokenId: trade.tokenId,
      originalTradeId: tradeId,
      priceBasePerToken: Number(trade.priceBasePerToken),
      amountBase: Number(trade.amountBase),
      amountToken: Number(trade.amountToken),
      timestamp: new Date(trade.timestamp),
      status: 'active',
      expiresAt,
      qualityScore: quality?.score || null,
      riskLevel: quality?.riskLevel.level || null,
      model: enableSmartCopy ? 'smart-copy' : null,
      reasoning: quality?.reasoning || null,
      meta: {
        originalAmountBase: Number(trade.amountBase),
        originalAmountToken: Number(trade.amountToken),
      },
    });

    console.log(`📊 Generated BUY signal: ${signal.id} (Score: ${quality?.score.toFixed(1) || 'N/A'}, Risk: ${quality?.riskLevel.level || 'N/A'})`);

    // 5. Pošli notifikaci (zatím deaktivováno - bude implementováno později)
    // await this.sendSignalNotification(signal, config);

    return signal;
  }

  /**
   * Vygeneruje SELL signál z trade
   */
  async generateSellSignal(
    tradeId: string,
    config: SignalGenerationConfig = {}
  ): Promise<SignalRecord | null> {
    // 1. Načti trade
    const trade = await this.tradeRepo.findById(tradeId);
    if (!trade || trade.side !== 'sell') {
      return null;
    }

    // 2. Zkontroluj, jestli už není signál pro tento trade
    const existing = await this.signalRepo.findActive({
      walletId: trade.walletId,
      tokenId: trade.tokenId,
      type: 'sell',
    });
    const alreadyExists = existing.some(s => s.originalTradeId === tradeId);
    if (alreadyExists) {
      return null;
    }

    // 3. Vytvoř signál
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + (config.signalExpirationHours || 24));

    const signal = await this.signalRepo.create({
      type: 'sell',
      walletId: trade.walletId,
      tokenId: trade.tokenId,
      originalTradeId: tradeId,
      priceBasePerToken: Number(trade.priceBasePerToken),
      amountBase: Number(trade.amountBase),
      amountToken: Number(trade.amountToken),
      timestamp: new Date(trade.timestamp),
      status: 'active',
      expiresAt,
      model: 'smart-copy',
      reasoning: `Smart wallet sold ${trade.tokenId.substring(0, 8)}...`,
      meta: {},
    });

    console.log(`📊 Generated SELL signal: ${signal.id}`);

    // 4. Pošli notifikaci (zatím deaktivováno - bude implementováno později)
    // await this.sendSignalNotification(signal, config);

    return signal;
  }

  /**
   * Pošle notifikaci o signálu do Discord/Telegram
   * TODO: Implementovat později
   */
  private async sendSignalNotification(
    signal: SignalRecord,
    config: SignalGenerationConfig
  ): Promise<void> {
    // Discord/Telegram webhooky budou implementovány později
    // Prozatím jsou signály dostupné pouze na webu
  }

  /**
   * Získá aktivní signály
   */
  async getActiveSignals(options?: {
    type?: 'buy' | 'sell';
    walletId?: string;
    tokenId?: string;
    limit?: number;
  }): Promise<SignalRecord[]> {
    return this.signalRepo.findActive(options);
  }

  /**
   * Označí signál jako executed (použitý pro paper trade)
   */
  async markSignalAsExecuted(signalId: string): Promise<SignalRecord> {
    return this.signalRepo.markAsExecuted(signalId);
  }

  /**
   * Expiruje staré signály
   */
  async expireOldSignals(maxAgeHours: number = 24): Promise<number> {
    return this.signalRepo.expireOldSignals(maxAgeHours);
  }
}
