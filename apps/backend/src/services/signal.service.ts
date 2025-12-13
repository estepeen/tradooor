import { SignalRepository, SignalRecord } from '../repositories/signal.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { PaperTradingModelsService, TradeQuality } from './paper-trading-models.service.js';
import { PaperTradeService } from './paper-trade.service.js';

export interface SignalGenerationConfig {
  minQualityScore?: number; // Minimální score pro generování signálu (default: 40)
  enableSmartCopy?: boolean; // Generovat signály z Smart Copy modelu
  enableConsensus?: boolean; // Generovat signály z Consensus modelu
  signalExpirationHours?: number; // Po kolika hodinách signál expiruje (default: 24)
  sendToDiscord?: boolean; // Poslat signál do Discord webhooku
  sendToTelegram?: boolean; // Poslat signál do Telegram webhooku
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

    // 5. Pošli do Discord/Telegram (pokud je zapnuto)
    if (config.sendToDiscord || config.sendToTelegram) {
      await this.sendSignalNotification(signal, config);
    }

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

    // 4. Pošli do Discord/Telegram (pokud je zapnuto)
    if (config.sendToDiscord || config.sendToTelegram) {
      await this.sendSignalNotification(signal, config);
    }

    return signal;
  }

  /**
   * Pošle notifikaci o signálu do Discord/Telegram
   */
  private async sendSignalNotification(
    signal: SignalRecord,
    config: SignalGenerationConfig
  ): Promise<void> {
    const signalType = signal.type.toUpperCase();
    const emoji = signal.type === 'buy' ? '🟢' : '🔴';
    const riskEmoji = signal.riskLevel === 'low' ? '🟢' : signal.riskLevel === 'medium' ? '🟡' : '🔴';
    
    const message = {
      content: `${emoji} **${signalType} SIGNAL**\n` +
        `Token: \`${signal.tokenId.substring(0, 16)}...\`\n` +
        `Price: $${signal.priceBasePerToken.toFixed(6)}\n` +
        (signal.qualityScore ? `Quality Score: ${signal.qualityScore.toFixed(1)}/100 ${riskEmoji}\n` : '') +
        (signal.riskLevel ? `Risk: ${signal.riskLevel.toUpperCase()}\n` : '') +
        (signal.reasoning ? `Reason: ${signal.reasoning.substring(0, 200)}\n` : '') +
        `\n[View on Tradooor](https://tradooor.stepanpanek.cz/signals)`,
    };

    // Discord webhook
    if (config.sendToDiscord && process.env.DISCORD_WEBHOOK_URL) {
      try {
        await fetch(process.env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
        });
        console.log(`📤 Sent signal ${signal.id} to Discord`);
      } catch (error: any) {
        console.error(`❌ Failed to send signal to Discord:`, error.message);
      }
    }

    // Telegram webhook
    if (config.sendToTelegram && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      try {
        const telegramMessage = `${emoji} *${signalType} SIGNAL*\n` +
          `Token: \`${signal.tokenId.substring(0, 16)}...\`\n` +
          `Price: $${signal.priceBasePerToken.toFixed(6)}\n` +
          (signal.qualityScore ? `Quality: ${signal.qualityScore.toFixed(1)}/100 ${riskEmoji}\n` : '') +
          (signal.riskLevel ? `Risk: ${signal.riskLevel.toUpperCase()}\n` : '') +
          (signal.reasoning ? `Reason: ${signal.reasoning.substring(0, 200)}\n` : '');

        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: telegramMessage,
            parse_mode: 'Markdown',
          }),
        });
        console.log(`📤 Sent signal ${signal.id} to Telegram`);
      } catch (error: any) {
        console.error(`❌ Failed to send signal to Telegram:`, error.message);
      }
    }
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
