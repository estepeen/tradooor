import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { NormalizedTradeRepository } from '../repositories/normalized-trade.repository.js';
import { HeliusClient } from './helius-client.service.js';
import { TokenMetadataBatchService } from './token-metadata-batch.service.js';
import { TokenPriceService } from './token-price.service.js';
import { SolPriceService } from './sol-price.service.js';
import { BinancePriceService } from './binance-price.service.js';

/**
 * Normalized trade shape used by collector – both Helius and QuickNode
 * normalizers should return this structure.
 */
export type NormalizedSwap = {
  txSignature: string;
  tokenMint: string;
  side: 'buy' | 'sell';
  amountToken: number;
  amountBase: number; // V USD (přepočteno z SOL/USDC/USDT nebo sekundárního tokenu)
  priceBasePerToken: number; // V USD za 1 token
  baseToken: string; // SOL, USDC, USDT, nebo mint address pro token za token swap
  timestamp: Date;
  dex: string;
};

/**
 * Try to normalize a single QuickNode transaction (RPC-style webhook payload)
 * into our internal NormalizedSwap format, based purely on pre/post balances.
 *
 * This is intentionally conservative: if we can't clearly detect a token ↔ base
 * trade for the given wallet, we return null and let the caller skip the tx.
 */
export function normalizeQuickNodeSwap(
  tx: any,
  walletAddress: string,
  blockTime?: number
): NormalizedSwap | null {
  try {
    const meta = tx.meta;
    const message = tx.transaction?.message;
    if (!meta || !message) return null;

    const walletLower = walletAddress.toLowerCase();

    // Map account index -> pubkey
    const accountKeys: string[] = (message.accountKeys || []).map((k: any) =>
      typeof k === 'string' ? k : k?.pubkey
    );

    // Helper: base token universe
    const BASE_MINTS = new Set<string>([
      // WSOL
      'So11111111111111111111111111111111111111112',
      // USDC
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      // USDT
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    ]);
    const BASE_MINT_TO_SYMBOL: Record<string, string> = {
      'So11111111111111111111111111111111111111112': 'SOL',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
    };

    const getBaseTokenSymbol = (mint: string | undefined): string => {
      if (!mint) return 'SOL';
      return BASE_MINT_TO_SYMBOL[mint] ?? 'SOL';
    };

    // 1) Compute per-(owner,mint) net token changes from pre/postTokenBalances
    type TokenKey = string; // `${owner}:${mint}`
    const preMap = new Map<TokenKey, number>();
    const postMap = new Map<TokenKey, number>();

    const addBalances = (arr: any[], target: Map<TokenKey, number>) => {
      for (const b of arr || []) {
        const owner = b.owner;
        const mint = b.mint as string | undefined;
        if (!owner || !mint) continue;
        const key = `${owner.toLowerCase()}:${mint}`;
        const uiTokenAmount = b.uiTokenAmount;
        if (!uiTokenAmount) continue;

        // Try uiAmount first (already normalized), then uiAmountString, then calculate from raw amount.
        // QUICKNODE EDGE CASE:
        //  - U některých tokenů (hlavně stablecoiny jako USDC/USDT) nemusí být vyplněné "decimals"
        //  - Pokud bychom použili default 0, dostaneme o 10^6 větší hodnoty (např. 1 135.74 USDC -> 1 135 740 000)
        //  - Proto defaultujeme na 6 pro base stablecoiny a 9 pro ostatní SPL tokeny.
        let amt: number | null = null;
        if (uiTokenAmount.uiAmount !== undefined && uiTokenAmount.uiAmount !== null) {
          amt =
            typeof uiTokenAmount.uiAmount === 'string'
              ? parseFloat(uiTokenAmount.uiAmount)
              : Number(uiTokenAmount.uiAmount);
        } else if (uiTokenAmount.uiAmountString) {
          amt = parseFloat(uiTokenAmount.uiAmountString);
        } else if (uiTokenAmount.amount) {
          // Raw amount as string, need to divide by 10^decimals
          const rawAmount =
            typeof uiTokenAmount.amount === 'string'
              ? BigInt(uiTokenAmount.amount)
              : BigInt(uiTokenAmount.amount);

          // Lepší default pro případy, kdy QuickNode neposkytne decimals:
          // - USDC/USDT mají 6 desetinných míst
          // - Většina ostatních SPL tokenů má 9 desetinných míst
          const explicitDecimals =
            typeof uiTokenAmount.decimals === 'number'
              ? uiTokenAmount.decimals
              : undefined;
          const defaultDecimals = BASE_MINTS.has(mint)
            ? 6 // stabilní coiny (USDC/USDT/WSOL) – 6
            : 9; // běžné SPL tokeny – 9
          const decimals = explicitDecimals ?? defaultDecimals;

          amt = Number(rawAmount) / Math.pow(10, decimals);
        }

        if (amt === null || !Number.isFinite(amt) || amt === 0) continue;
        target.set(key, (target.get(key) ?? 0) + amt);
      }
    };

    addBalances(meta.preTokenBalances || [], preMap);
    addBalances(meta.postTokenBalances || [], postMap);

    // Net changes for the specific wallet
    const tokenNetByMint = new Map<string, number>();
    for (const [key, pre] of preMap.entries()) {
      const [ownerLower, mint] = key.split(':');
      if (ownerLower !== walletLower) continue;
      const post = postMap.get(key) ?? 0;
      const delta = post - pre;
      if (Math.abs(delta) < 1e-12) continue;
      tokenNetByMint.set(mint, (tokenNetByMint.get(mint) ?? 0) + delta);
    }
    for (const [key, post] of postMap.entries()) {
      if (preMap.has(key)) continue; // already handled above
      const [ownerLower, mint] = key.split(':');
      if (ownerLower !== walletLower) continue;
      const delta = post;
      if (Math.abs(delta) < 1e-12) continue;
      tokenNetByMint.set(mint, (tokenNetByMint.get(mint) ?? 0) + delta);
    }

    // 2) Compute native SOL net change from pre/postBalances for wallet's accounts
    let solNet = 0;
    const preBalances: number[] = meta.preBalances || [];
    const postBalances: number[] = meta.postBalances || [];
    for (let i = 0; i < accountKeys.length; i++) {
      const pk = accountKeys[i];
      if (!pk || pk.toLowerCase() !== walletLower) continue;
      const preLamports = preBalances[i] ?? 0;
      const postLamports = postBalances[i] ?? preLamports;
      const deltaLamports = postLamports - preLamports;
      if (deltaLamports !== 0) {
        solNet += deltaLamports / 1e9;
      }
    }

    // Debug: log token net changes (only if there are changes)
    if (tokenNetByMint.size > 0 || Math.abs(solNet) > 0.001) {
      console.log(`   [QuickNode] Token net changes for wallet ${walletAddress.substring(0, 8)}...:`, 
        Array.from(tokenNetByMint.entries()).map(([mint, delta]) => `${mint.substring(0, 8)}...: ${delta}`).join(', '));
      console.log(`   [QuickNode] SOL net change: ${solNet}`);
    }

    // 3) Pick main traded (non-base) token by absolute net change
    let primaryMint: string | null = null;
    let primaryDelta = 0;
    for (const [mint, delta] of tokenNetByMint.entries()) {
      if (BASE_MINTS.has(mint)) continue;
      if (Math.abs(delta) <= 0) continue;
      if (!primaryMint || Math.abs(delta) > Math.abs(primaryDelta)) {
        primaryMint = mint;
        primaryDelta = delta;
      }
    }
    if (!primaryMint || Math.abs(primaryDelta) < 1e-9) {
      // No clear non-base token movement for this wallet → not a trade we care about
      console.log(`   ⚠️  [QuickNode] No primary token found for wallet ${walletAddress.substring(0, 8)}...`);
      console.log(`      Token net changes: ${tokenNetByMint.size > 0 ? Array.from(tokenNetByMint.entries()).map(([m, d]) => `${m.substring(0, 8)}...: ${d.toFixed(6)}`).join(', ') : 'none'}`);
      console.log(`      SOL net change: ${solNet.toFixed(6)}`);
      return null;
    }

    const side: 'buy' | 'sell' = primaryDelta > 0 ? 'buy' : 'sell';
    const amountToken = Math.abs(primaryDelta);

    // 4) Compute base side (SOL / USDC / USDT / WSOL) net amounts
    let usdcNet = 0;
    let usdtNet = 0;
    let wsolNet = 0;
    for (const [mint, delta] of tokenNetByMint.entries()) {
      if (!BASE_MINTS.has(mint)) continue;
      if (mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
        usdcNet += delta;
      } else if (mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') {
        usdtNet += delta;
      } else if (mint === 'So11111111111111111111111111111111111111112') {
        wsolNet += delta;
      }
    }

    // Effective SOL exposure = native SOL + WSOL
    const solTotalNet = solNet + wsolNet;

    // For BUY: user spent base => negative net
    let baseAmount = 0;
    let baseToken = 'SOL';
    if (side === 'buy') {
      const solSpent = solTotalNet < 0 ? -solTotalNet : 0;
      const usdcSpent = usdcNet < 0 ? -usdcNet : 0;
      const usdtSpent = usdtNet < 0 ? -usdtNet : 0;
      baseAmount = Math.max(solSpent, usdcSpent, usdtSpent);
      
      // Pokud není base token (SOL/USDC/USDT), zkus najít sekundární token (token za token swap)
      if (baseAmount <= 0) {
        // Najdi sekundární token (ten, za který se kupuje primární token)
        let secondaryMint: string | null = null;
        let secondaryDelta = 0;
        for (const [mint, delta] of tokenNetByMint.entries()) {
          if (mint === primaryMint) continue; // Skip primární token
          if (BASE_MINTS.has(mint)) continue; // Skip base tokeny (už jsme je zkontrolovali)
          if (delta < 0 && Math.abs(delta) > Math.abs(secondaryDelta)) {
            // Negativní delta = token se prodává (za něj se kupuje primární)
            secondaryMint = mint;
            secondaryDelta = delta;
          }
        }
        
        if (secondaryMint && Math.abs(secondaryDelta) > 1e-9) {
          // Swap token za token - použij sekundární token jako "base"
          baseAmount = Math.abs(secondaryDelta);
          baseToken = secondaryMint; // Použijeme mint address jako base token
        } else {
          // Not enough info about base leg
          console.log(`   ⚠️  [QuickNode] No base token found for BUY swap (wallet ${walletAddress.substring(0, 8)}...)`);
          console.log(`      Primary token: ${primaryMint?.substring(0, 16)}..., delta: ${primaryDelta.toFixed(6)}`);
          console.log(`      SOL net: ${solNet.toFixed(6)}, USDC net: ${usdcNet.toFixed(6)}, USDT net: ${usdtNet.toFixed(6)}`);
          console.log(`      Token net changes: ${tokenNetByMint.size > 0 ? Array.from(tokenNetByMint.entries()).map(([m, d]) => `${m.substring(0, 8)}...: ${d.toFixed(6)}`).join(', ') : 'none'}`);
          return null;
        }
      } else {
        // Máme base token (SOL/USDC/USDT)
        if (baseAmount === usdcSpent) baseToken = 'USDC';
        else if (baseAmount === usdtSpent) baseToken = 'USDT';
        else baseToken = 'SOL';
      }
    } else {
      // SELL: user received base => positive net
      const solReceived = solTotalNet > 0 ? solTotalNet : 0;
      const usdcReceived = usdcNet > 0 ? usdcNet : 0;
      const usdtReceived = usdtNet > 0 ? usdtNet : 0;
      baseAmount = Math.max(solReceived, usdcReceived, usdtReceived);
      
      // Pokud není base token, zkus najít sekundární token (token za token swap)
      if (baseAmount <= 0) {
        // Najdi sekundární token (ten, který se přijímá za primární token)
        let secondaryMint: string | null = null;
        let secondaryDelta = 0;
        for (const [mint, delta] of tokenNetByMint.entries()) {
          if (mint === primaryMint) continue; // Skip primární token
          if (BASE_MINTS.has(mint)) continue; // Skip base tokeny
          if (delta > 0 && delta > secondaryDelta) {
            // Pozitivní delta = token se přijímá (za primární token)
            secondaryMint = mint;
            secondaryDelta = delta;
          }
        }
        
        if (secondaryMint && secondaryDelta > 1e-9) {
          // Swap token za token - použij sekundární token jako "base"
          baseAmount = secondaryDelta;
          baseToken = secondaryMint; // Použijeme mint address jako base token
        } else {
          console.log(`   ⚠️  [QuickNode] No base token found for SELL swap (wallet ${walletAddress.substring(0, 8)}...)`);
          console.log(`      Primary token: ${primaryMint?.substring(0, 16)}..., delta: ${primaryDelta.toFixed(6)}`);
          console.log(`      SOL net: ${solNet.toFixed(6)}, USDC net: ${usdcNet.toFixed(6)}, USDT net: ${usdtNet.toFixed(6)}`);
          console.log(`      Token net changes: ${tokenNetByMint.size > 0 ? Array.from(tokenNetByMint.entries()).map(([m, d]) => `${m.substring(0, 8)}...: ${d.toFixed(6)}`).join(', ') : 'none'}`);
          return null;
        }
      } else {
        // Máme base token (SOL/USDC/USDT)
        if (baseAmount === usdcReceived) baseToken = 'USDC';
        else if (baseAmount === usdtReceived) baseToken = 'USDT';
        else baseToken = 'SOL';
      }
    }

    if (baseAmount <= 0 || amountToken <= 0) {
      console.log(`   ⚠️  [QuickNode] Invalid baseAmount or amountToken for wallet ${walletAddress.substring(0, 8)}...`);
      console.log(`      Primary token: ${primaryMint?.substring(0, 16)}..., delta: ${primaryDelta.toFixed(6)}`);
      console.log(`      Base amount: ${baseAmount.toFixed(6)}, Base token: ${baseToken}`);
      console.log(`      SOL net: ${solNet.toFixed(6)}, USDC net: ${usdcNet.toFixed(6)}, USDT net: ${usdtNet.toFixed(6)}`);
      return null;
    }

    const priceBasePerToken = baseAmount / amountToken;

    // Signature & timestamp
    const signature = tx.transaction?.signatures?.[0];
    if (!signature) return null;

    const tsSec: number =
      (typeof tx.blockTime === 'number' && tx.blockTime) ||
      (typeof blockTime === 'number' && blockTime) ||
      0;
    const timestamp = tsSec > 0 ? new Date(tsSec * 1000) : new Date();

    // Rough DEX detection from accountKeys (best-effort, not critical)
    const keySet = new Set(accountKeys);
    let dex = 'unknown';
    const DEX_PROGRAMS: Array<{ id: string; name: string }> = [
      { id: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', name: 'jupiter' },
      { id: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', name: 'meteora' },
      { id: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', name: 'phoenix' },
      { id: 'pump9xNzDDnyWJ1cg9CHG9g9o6CWGt77CajND4xqJcf', name: 'pump_fun' },
    ];
    for (const { id, name } of DEX_PROGRAMS) {
      if (keySet.has(id)) {
        dex = name;
        break;
      }
    }

    // Pro token za token swapy použijeme mint address jako base token symbol
    // Pro base tokeny (SOL/USDC/USDT) použijeme symbol
    let baseTokenSymbol: string;
    if (BASE_MINTS.has(baseToken)) {
      // Je to base token - použij symbol
      baseTokenSymbol = getBaseTokenSymbol(
        baseToken === 'SOL' ? 'So11111111111111111111111111111111111111112' : baseToken
      );
    } else {
      // Je to token za token swap - použij mint address (backend to může převést na symbol později)
      baseTokenSymbol = baseToken;
    }

    return {
      txSignature: signature,
      tokenMint: primaryMint,
      side,
      amountToken,
      amountBase: baseAmount,
      priceBasePerToken,
      baseToken: baseTokenSymbol,
      timestamp,
      dex,
    };
  } catch (err: any) {
    console.warn('⚠️  Error normalizing QuickNode tx:', err?.message || err);
    return null;
  }
}

/**
 * Service for processing Solana transactions from webhooks
 * This service normalizes transactions and saves them as trades
 */
export class SolanaCollectorService {
  private heliusClient: HeliusClient;
  private tokenMetadataBatchService: TokenMetadataBatchService;
  private tokenPriceService: TokenPriceService;
  private solPriceService: SolPriceService;
  private binancePriceService: BinancePriceService;

  constructor(
    private smartWalletRepo: SmartWalletRepository,
    private tradeRepo: TradeRepository,
    private tokenRepo: TokenRepository,
    private walletQueueRepo: WalletProcessingQueueRepository,
    private normalizedTradeRepo: NormalizedTradeRepository = new NormalizedTradeRepository()
  ) {
    this.heliusClient = new HeliusClient();
    this.tokenMetadataBatchService = new TokenMetadataBatchService(this.heliusClient, this.tokenRepo);
    this.tokenPriceService = new TokenPriceService();
    this.solPriceService = new SolPriceService();
    this.binancePriceService = new BinancePriceService();
  }

  /**
   * Process a single webhook transaction (Helius enhanced format).
   * Kept for backwards compatibility; new QuickNode flow should use
   * processQuickNodeTransaction instead.
   */
  async processWebhookTransaction(
    tx: any,
    walletAddress: string
  ): Promise<{ saved: boolean; reason?: string }> {
    try {
      // 1. Normalize swap
      const normalized = await this.heliusClient.normalizeSwap(tx, walletAddress);
      if (!normalized) {
        return { saved: false, reason: 'not a swap' };
      }

      // 1b. Filter out tiny SOL trades (likely just fees) - do not store trades with value < 0.03 SOL
      if (normalized.baseToken === 'SOL' && normalized.amountBase < 0.03) {
        console.log(
          `   ⚠️  Skipping tiny SOL trade (amountBase=${normalized.amountBase} SOL < 0.03) for wallet ${walletAddress.substring(
            0,
            8
          )}...`
        );
        return { saved: false, reason: 'amountBase < 0.03 SOL (likely fee)' };
      }

      // 2. Find or create wallet
      const wallet = await this.smartWalletRepo.findByAddress(walletAddress);
      if (!wallet) {
        return { saved: false, reason: 'wallet not found' };
      }

      // 2b. Připrav debug/meta data z raw Helius webhooku pro tuto wallet
      //     Cíl: mít v DB dost informací pro přepočet SOL hodnot a PnL jen z databáze,
      //     bez nutnosti zpětného volání Helius getTransaction.
      const walletLower = walletAddress.toLowerCase();
      const heliusDebugMeta: any = {
        source: tx.source ?? null,
        type: tx.type ?? null,
      };

      // Native transfers relevantní pro tuto wallet
      if (Array.isArray(tx.nativeTransfers) && tx.nativeTransfers.length > 0) {
        const walletNativeTransfers = tx.nativeTransfers.filter((t: any) => {
          const from = typeof t.fromUserAccount === 'string' ? t.fromUserAccount.toLowerCase() : '';
          const to = typeof t.toUserAccount === 'string' ? t.toUserAccount.toLowerCase() : '';
          return from === walletLower || to === walletLower;
        });
        if (walletNativeTransfers.length > 0) {
          heliusDebugMeta.walletNativeTransfers = walletNativeTransfers;
        }
      }

      // AccountData položka pro tuto wallet (nativeBalanceChange apod.)
      if (Array.isArray(tx.accountData) && tx.accountData.length > 0) {
        const walletAccountData = tx.accountData.find((acc: any) => {
          const account = typeof acc.account === 'string' ? acc.account.toLowerCase() : '';
          return account === walletLower;
        });
        if (walletAccountData) {
          heliusDebugMeta.walletAccountData = {
            account: walletAccountData.account,
            nativeBalanceChange: walletAccountData.nativeBalanceChange ?? null,
            tokenBalanceChanges: walletAccountData.tokenBalanceChanges ?? null,
          };
        }
      }

      // Základní shrnutí swap eventu (zmenšené kvůli velikosti)
      if (tx.events?.swap) {
        const swap = tx.events.swap;
        heliusDebugMeta.swapSummary = {
          nativeInput: swap.nativeInput ?? null,
          nativeOutput: swap.nativeOutput ?? null,
          tokenInputs: Array.isArray(swap.tokenInputs)
            ? swap.tokenInputs.map((ti: any) => ({
                mint: ti.mint,
                tokenAmount: ti.tokenAmount ?? null,
                rawTokenAmount: ti.rawTokenAmount ?? null,
                userAccount: ti.userAccount ?? null,
                fromUserAccount: ti.fromUserAccount ?? null,
              }))
            : null,
          tokenOutputs: Array.isArray(swap.tokenOutputs)
            ? swap.tokenOutputs.map((to: any) => ({
                mint: to.mint,
                tokenAmount: to.tokenAmount ?? null,
                rawTokenAmount: to.rawTokenAmount ?? null,
                userAccount: to.userAccount ?? null,
                toUserAccount: to.toUserAccount ?? null,
              }))
            : null,
        };
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

      // 7. Save trade
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
        valueUsd: undefined,
        meta: {
          source: 'helius-webhook',
          baseToken: normalized.baseToken,
          heliusDebug: heliusDebugMeta,
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

  /**
   * Process a single QuickNode webhook transaction (RPC/block-style payload).
   * Uses balance diffs to infer token ↔ base swaps for the given wallet.
   */
  async processQuickNodeTransaction(
    tx: any,
    walletAddress: string,
    blockTime?: number
  ): Promise<{ saved: boolean; reason?: string; normalizedTradeId?: string }> {
    try {
      const normalized = normalizeQuickNodeSwap(tx, walletAddress, blockTime);
      if (!normalized) {
        return { saved: false, reason: 'not a swap' };
      }
      
      const amountBaseRaw = normalized.amountBase;

      // 2. Find or create wallet
      const wallet = await this.smartWalletRepo.findByAddress(walletAddress);
      if (!wallet) {
        return { saved: false, reason: 'wallet not found' };
      }

      const walletLower = walletAddress.toLowerCase();
      const quicknodeDebugMeta: any = {
        source: 'quicknode',
        wallet: walletAddress,
        signature: tx.transaction?.signatures?.[0] ?? null,
        slot: tx.slot ?? null,
        blockTime: blockTime ?? tx.blockTime ?? null,
      };

      // Attach balance snapshots relevant to this wallet (for future debugging)
      if (tx.meta) {
        const meta = tx.meta;

        // Native SOL balance change
        if (Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances) && tx.transaction?.message) {
          const keys = (tx.transaction.message.accountKeys || []).map((k: any) =>
            typeof k === 'string' ? k : k?.pubkey
          );
          const diffs: Array<{ pubkey: string; pre: number; post: number }> = [];
          for (let i = 0; i < keys.length; i++) {
            const pk = keys[i];
            if (!pk || pk.toLowerCase() !== walletLower) continue;
            const pre = meta.preBalances[i] ?? 0;
            const post = meta.postBalances[i] ?? pre;
            diffs.push({ pubkey: pk, pre, post });
          }
          if (diffs.length > 0) quicknodeDebugMeta.walletSolBalances = diffs;
        }

        // Token balances for this wallet
        const collectTokenBalances = (arr: any[]) =>
          (arr || [])
            .filter((b: any) => b.owner && b.owner.toLowerCase() === walletLower)
            .map((b: any) => ({
              mint: b.mint,
              accountIndex: b.accountIndex,
              owner: b.owner,
              uiTokenAmount: b.uiTokenAmount,
            }));

        const preTokens = collectTokenBalances(meta.preTokenBalances || []);
        const postTokens = collectTokenBalances(meta.postTokenBalances || []);
        if (preTokens.length > 0 || postTokens.length > 0) {
          quicknodeDebugMeta.walletTokenBalances = { pre: preTokens, post: postTokens };
        }
      }

      // 3. Find or create token
      let token = await this.tokenRepo.findOrCreate({
        mintAddress: normalized.tokenMint,
      });

      // 4. Fetch token metadata if missing (same as Helius path)
      if (!token.symbol || !token.name) {
        try {
          console.log(
            `   🔍 Token ${normalized.tokenMint.substring(
              0,
              8
            )}... missing metadata, fetching from Birdeye/DexScreener/Metaplex...`
          );
          const metadataMap = await this.tokenMetadataBatchService.getTokenMetadataBatch([
            normalized.tokenMint,
          ]);
          const metadata = metadataMap.get(normalized.tokenMint);

          if (metadata && (metadata.symbol || metadata.name)) {
            const updatedToken = await this.tokenRepo.findByMintAddress(normalized.tokenMint);
            if (updatedToken) {
              token = updatedToken;
              console.log(
                `   ✅ Token metadata fetched: ${token.symbol || 'N/A'} / ${token.name || 'N/A'}`
              );
            } else {
              console.warn(
                `   ⚠️  Token metadata fetched but token not found in DB after update`
              );
            }
          } else {
            console.warn(
              `   ⚠️  Token metadata fetch returned no symbol/name for ${normalized.tokenMint.substring(
                0,
                8
              )}...`
            );
          }
        } catch (error: any) {
          console.warn(
            `⚠️  Failed to fetch metadata for ${normalized.tokenMint.substring(0, 8)}...:`,
            error.message
          );
        }
      }

      // 5. USD value je už vypočítané v normalized.amountBase (v USD)
      const valueUsd = normalized.amountBase; // Už je v USD

      const existing = await this.tradeRepo.findBySignature(normalized.txSignature);
      if (existing) {
        return { saved: false, reason: 'duplicate' };
      }

      const baseTokenSymbol = normalized.baseToken?.toUpperCase?.() || '';
      const isStableBase = baseTokenSymbol === 'SOL' || baseTokenSymbol === 'WSOL' || baseTokenSymbol === 'USDC' || baseTokenSymbol === 'USDT';
      const secondaryTokenMint = isStableBase ? null : normalized.baseToken;

      const normalizedRecord = await this.normalizedTradeRepo.create({
        txSignature: normalized.txSignature,
        walletId: wallet.id,
        tokenId: token.id,
        tokenMint: token.mintAddress,
        side: normalized.side,
        amountToken: normalized.amountToken,
        amountBaseRaw,
        baseToken: normalized.baseToken,
        priceBasePerTokenRaw: normalized.priceBasePerToken,
        timestamp: normalized.timestamp,
        dex: normalized.dex,
        meta: {
          source: 'quicknode-webhook',
          baseToken: normalized.baseToken,
          isTokenToTokenSwap: !['SOL', 'USDC', 'USDT'].includes(normalized.baseToken),
          secondaryTokenMint,
          quicknodeDebug: quicknodeDebugMeta,
          walletAddress,
        },
        rawPayload: tx,
      });

      console.log(
        `   ✅ [QuickNode] Normalized trade stored: ${normalizedRecord.id.substring(0, 8)}... (${normalized.side} ${normalized.amountToken} tokens, ${normalized.amountBase} ${normalized.baseToken})`
      );

      return { saved: true, normalizedTradeId: normalizedRecord.id };
    } catch (error: any) {
      console.error(`❌ Error processing QuickNode webhook transaction:`, error);
      return { saved: false, reason: error.message || 'unknown error' };
    }
  }
}

