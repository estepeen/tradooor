import { Connection, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { HeliusClient, HeliusRateLimitError } from './helius-client.service.js';
import { SolPriceService } from './sol-price.service.js';

dotenv.config();

const DEFAULT_HELIUS_PAGE_SIZE = 100;
const DEFAULT_HELIUS_MAX_PAGES = 5;
// IMPORTANT: For manual refresh we want all swaps, not just those above $5
// MIN_NOTIONAL_USD is now 0 (disabled) - can be enabled via env var for automatic refresh
const MIN_NOTIONAL_USD = Number(process.env.MIN_NOTIONAL_USD || 0);

const ALLOWED_SWAP_SOURCES = new Set<string>([
  // Main DEXes (verified from Helius API)
  'JUPITER',
  'JUPITER_LIMIT',
  'RAYDIUM',
  'PUMP_FUN',
  'PUMP_AMM', // Pump.fun AMM
  'METEORA',
  'OKX',
  
  // Other known DEXes
  'ORCA',
  'ORCA_V2',
  'ORCA_WHIRLPOOL',
  'WHIRLPOOL',
  'LIFINITY',
  'PHOENIX',
  'MERCURIAL',
  'DRIFT',
  'MANGO',
  'ALDRIN',
  'SABER',
  'GOOSEFX',
  'MARINADE',
  'STEP',
  
  // Potential DEXes (not yet verified via Helius API)
  // If they appear in logs as "Disallowed source", we'll add them
  'GMGN',
  'BONK_DEX',
  'BLOOM',
  'DFLOW',
  'BACKPACK',
  'PHANTOM',
]);

const normalizeSource = (source?: string | null): string | undefined => {
  if (!source) return undefined;
  return source.trim().toUpperCase();
};

const getTransactionSource = (tx: any): string | undefined => {
  return (
    normalizeSource(tx.source) ||
    normalizeSource(tx.events?.swap?.programInfo?.source) ||
    normalizeSource(tx.events?.swap?.programInfo?.protocol) ||
    normalizeSource(tx.events?.swap?.programInfo?.program)
  );
};

/**
 * 1) Primární detekce swapu – kombinace type === 'SWAP' nebo existence events.swap
 */
const isSwapTx = (tx: any): boolean => {
  const hasSwapEvent = !!tx.events?.swap;
  const isSwapType = tx.type === 'SWAP';
  return hasSwapEvent || isSwapType;
};

/**
 * 2) Musí proběhnout reálná výměna tokenů – ve swap.tokenInputs i swap.tokenOutputs
 *    musí být alespoň jeden token s rawTokenAmount.tokenAmount > 0.
 *    Ignoruje čistě native SOL → native SOL swapy bez tokenů.
 */
const isRealTokenSwap = (tx: any): boolean => {
  const swap = tx.events?.swap;
  if (!swap) return false;

  const hasPositiveAmount = (items?: any[]): boolean => {
    if (!items || items.length === 0) return false;
    return items.some(t => {
      const raw = t?.rawTokenAmount;
      if (!raw || raw.tokenAmount == null) return false;
      const amountStr = String(raw.tokenAmount);
      try {
        // Use BigInt if available, otherwise fallback to Number
        return BigInt(amountStr) > 0n;
      } catch {
        return Number(amountStr) > 0;
      }
    });
  };

  const hasTokenIn = hasPositiveAmount(swap.tokenInputs);
  const hasTokenOut = hasPositiveAmount(swap.tokenOutputs);

  return hasTokenIn && hasTokenOut;
};

/**
 * 3) Peněženka se musí účastnit swapu – alespoň jeden účet ve swapu odpovídá wallet adrese.
 *    Zahrnujeme jak top-level swap, tak innerSwaps.
 */
const swapInvolvesWallet = (tx: any, wallet: string): boolean => {
  const swap = tx.events?.swap;
  if (!swap) return false;

  const accounts = new Set<string>();

  const addAccount = (acc?: string) => {
    if (acc) accounts.add(acc);
  };

  // native input/output
  addAccount(swap.nativeInput?.account);
  addAccount(swap.nativeOutput?.account);

  const collectTokenAccounts = (tokens?: any[]) => {
    if (!tokens) return;
    for (const t of tokens) {
      addAccount(t.userAccount);
      addAccount(t.fromUserAccount);
      addAccount(t.toUserAccount);
    }
  };

  // tokenInputs/Outputs z top-levelu
  collectTokenAccounts(swap.tokenInputs);
  collectTokenAccounts(swap.tokenOutputs);

  // tokenInputs/Outputs z innerSwaps
  if (swap.innerSwaps && Array.isArray(swap.innerSwaps)) {
    for (const inner of swap.innerSwaps) {
      collectTokenAccounts(inner.tokenInputs);
      collectTokenAccounts(inner.tokenOutputs);
    }
  }

  return accounts.has(wallet);
};

/**
 * 4) Source používáme jen jako „hint“ – pokud není, swap nezabíjíme.
 */
const passesSourceHint = (tx: any): boolean => {
  const source = getTransactionSource(tx);
  if (!source) return true; // prefer not to kill swaps with UNKNOWN

  // If source is in allowlist, it's a plus - but we won't kill swaps because of it.
  if (ALLOWED_SWAP_SOURCES.has(source)) {
    return true;
  }

  // For now we DON'T filter by source - it's just a hint (logging, possibly future tightening).
  return true;
};

/**
 * Celkový check: robustní detekce swapu pro konkrétní walletku.
 *
 * - type / events.swap
 * - reálná výměna tokenů (tokenInputs & tokenOutputs)
 * - účast peněženky
 * - source jen jako hint (lze případně vypnout)
 *
 * IMPORTANT: If Helius says type='SWAP', we trust it and let normalizeSwap decide the details.
 */
const isWalletSwap = (tx: any, wallet: string): boolean => {
  // If Helius explicitly says type='SWAP', we trust it
  // (Helius already identified the swap, let normalizeSwap decide the details)
  if (tx.type === 'SWAP') {
    // Still check that wallet is a participant (minimal check)
    const walletInvolved =
      tx.tokenTransfers?.some(
        (t: any) => t.fromUserAccount === wallet || t.toUserAccount === wallet
      ) ||
      tx.nativeTransfers?.some(
        (n: any) => n.fromUserAccount === wallet || n.toUserAccount === wallet
      ) ||
      tx.events?.swap?.nativeInput?.account === wallet ||
      tx.events?.swap?.nativeOutput?.account === wallet ||
      tx.events?.swap?.tokenInputs?.some(
        (t: any) => t.userAccount === wallet || t.fromUserAccount === wallet
      ) ||
      tx.events?.swap?.tokenOutputs?.some(
        (t: any) => t.userAccount === wallet || t.toUserAccount === wallet
      ) ||
      tx.accountData?.some(
        (acc: any) => acc.account === wallet && (acc.nativeBalanceChange !== 0 || (acc.tokenBalanceChanges?.length ?? 0) > 0)
      );
    
    if (walletInvolved) {
      return true; // Helius says SWAP + wallet is participant → swap
    }
  }

  // If we don't have type='SWAP', use original logic
  if (!isSwapTx(tx)) return false;

  // Preferred path: we have events.swap → use strict logic
  if (tx.events?.swap) {
    if (!isRealTokenSwap(tx)) return false;
    if (!swapInvolvesWallet(tx, wallet)) return false;
    // Source here is only used as a hint (logs), not for hard filtering
    return true;
  }

  // Fallback: we don't have events.swap (e.g. some legacy / specific DEXes)
  // Use simpler heuristic over tokenTransfers/nativeTransfers.
  const tokenTransfers = tx.tokenTransfers ?? [];
  const nativeTransfers = tx.nativeTransfers ?? [];

  // Wallet must participate in at least one transfer
  const walletInvolved =
    tokenTransfers.some(
      (t: any) => t.fromUserAccount === wallet || t.toUserAccount === wallet
    ) ||
    nativeTransfers.some(
      (n: any) => n.fromUserAccount === wallet || n.toUserAccount === wallet
    );

  if (!walletInvolved) return false;

  // Must look like a token swap - at least 2 different tokens
  // nebo kombinace token + native transfer.
  const uniqueMints = new Set<string>(tokenTransfers.map((t: any) => t.mint).filter(Boolean));
  const looksLikeTokenSwap =
    uniqueMints.size >= 2 || (uniqueMints.size === 1 && nativeTransfers.length > 0);

  if (!looksLikeTokenSwap) return false;

  // Source only as hint - if specified and not in allowlist, prefer to skip.
  if (!passesSourceHint(tx)) return false;

  return true;
};

const hasSpamFlag = (tx: any): boolean => {
  return Boolean(
    tx.tokenTransfers?.some(
      (transfer: any) =>
        transfer?.tokenMetadata?.isSpam === true ||
        transfer?.tokenMetadata?.spam === true
    )
  );
};

/**
 * Jednoduchý RPC limiter (Bottleneck-like) pro omezování Solana RPC volání
 * - Omezuje max. concurrency (kolik volání může běžet současně)
 * - Zajišťuje minTime mezi requesty
 */
class RpcLimiter {
  private running = 0;
  private queue: Array<() => void> = [];
  private lastCallTime = 0;

  constructor(
    private maxConcurrency: number,
    private minTimeMs: number
  ) {}

  /**
   * Schedules RPC call through limiter
   */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = async () => {
        // Wait for minTime since last call
        const now = Date.now();
        const timeSinceLastCall = now - this.lastCallTime;
        if (timeSinceLastCall < this.minTimeMs) {
          await new Promise(resolve => setTimeout(resolve, this.minTimeMs - timeSinceLastCall));
        }

        this.running++;
        this.lastCallTime = Date.now();

        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.running--;
          // Start next from queue if there's space
          if (this.queue.length > 0 && this.running < this.maxConcurrency) {
            const next = this.queue.shift()!;
            next();
          }
        }
      };

      // If we have space, start immediately, otherwise add to queue
      if (this.running < this.maxConcurrency) {
        run();
      } else {
        this.queue.push(run);
      }
    });
  }
}

/**
 * Solana Collector Service
 * 
 * Periodically collects transactions for tracked smart wallets and saves swaps to database.
 * 
 * Data flow:
 * 1. Loads list of tracked addresses from database (smart_wallets.address)
 * 2. For each address, fetches latest transactions from Solana RPC
 * 3. Finds swap-like transactions (SPL token ↔ SOL/WSOL/stable)
 * 4. Saves them to trades table
 */
export class SolanaCollectorService {
  private connection: Connection;
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private heliusClient: HeliusClient;
  private solPriceService: SolPriceService;

  // Konfigurace
  private readonly intervalSeconds: number;
  private readonly maxTransactionsPerWallet: number;
  private readonly rpcMaxConcurrency: number;
  private readonly rpcMinTimeMs: number;
  private readonly rpcMaxRetries: number;
  private readonly rpcBaseDelayMs: number;
  private readonly useHelius: boolean;

  // Global RPC limiter (shared for all calls to Solana RPC)
  private rpcLimiter: RpcLimiter;

  constructor(
    private smartWalletRepo: SmartWalletRepository,
    private tradeRepo: TradeRepository,
    private tokenRepo: TokenRepository
  ) {
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(rpcUrl, 'confirmed');
    
    // Helius client
    this.heliusClient = new HeliusClient(process.env.HELIUS_API_KEY);
    this.useHelius = this.heliusClient.isAvailable();
    
    // SOL price service for USD conversion
    this.solPriceService = new SolPriceService();
    
    if (this.useHelius) {
      console.log('✅ Helius API enabled - using Enhanced API for better swap detection');
    } else {
      console.log('⚠️  Helius API not configured - using standard RPC parsing');
    }
    
    // Configuration from .env or default values
    // Default: 5 minutes (300s) instead of 60s to reduce API requests
    this.intervalSeconds = parseInt(process.env.COLLECTOR_INTERVAL_SECONDS || '300');
    this.maxTransactionsPerWallet = parseInt(process.env.COLLECTOR_MAX_TX_PER_WALLET || '50');

    this.rpcMaxConcurrency = parseInt(process.env.SOLANA_RPC_MAX_CONCURRENCY || '3');
    this.rpcMinTimeMs = parseInt(process.env.SOLANA_RPC_MIN_TIME_MS || '300'); // min 300ms between requests
    this.rpcMaxRetries = parseInt(process.env.SOLANA_RPC_MAX_RETRIES || '5');
    this.rpcBaseDelayMs = parseInt(process.env.SOLANA_RPC_BASE_DELAY_MS || '1000'); // 1s base delay for backoff

    this.rpcLimiter = new RpcLimiter(this.rpcMaxConcurrency, this.rpcMinTimeMs);
  }

  /**
   * General wrapper for RPC calls with global limiter + retry logic
   */
  private async rpcCallWithRetry<T>(
    opName: 'getSignaturesForAddress' | 'getTransaction' | 'getParsedTransaction',
    fn: () => Promise<T>
  ): Promise<T> {
    let attempt = 0;

    // Helper function to determine if it's a rate-limit error
    const isRateLimitError = (error: any) => {
      const msg = String(error?.message || '');
      return msg.includes('429') || msg.toLowerCase().includes('too many requests');
    };

    while (true) {
      try {
        // All RPC calls go through global limiter
        return await this.rpcLimiter.schedule(fn);
      } catch (error: any) {
        attempt++;
        if (!isRateLimitError(error) || attempt > this.rpcMaxRetries) {
          console.error(`❌ RPC ${opName} failed after ${attempt} attempts:`, error?.message || error);
          throw error;
        }

        // Exponential backoff – 1s, 2s, 4s, 8s, ...
        const delay = this.rpcBaseDelayMs * Math.pow(2, attempt - 1);
        console.warn(
          `⚠️  RPC ${opName} rate-limited (attempt ${attempt}/${this.rpcMaxRetries}), retrying in ${delay}ms...`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  private async getSignaturesWithRetry(
    publicKey: PublicKey,
    limit: number
  ): Promise<any[]> {
    return this.rpcCallWithRetry('getSignaturesForAddress', () =>
      this.connection.getSignaturesForAddress(publicKey, { limit })
    );
  }

  private async getTransactionWithRetry(
    signature: string
  ): Promise<any | null> {
    // Use getParsedTransaction - returns better structured data with token balances
    try {
      const parsed = await this.rpcCallWithRetry('getParsedTransaction', () =>
        this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        })
      );
      if (parsed) {
        return parsed;
      }
    } catch (error: any) {
      // If getParsedTransaction fails, try normal getTransaction
      console.warn(`⚠️  getParsedTransaction failed for ${signature.substring(0, 8)}..., trying getTransaction: ${error.message}`);
    }
    
    // Fallback to normal getTransaction
    return this.rpcCallWithRetry('getTransaction', () =>
      this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      })
    );
  }

  /**
   * Spuštění periodického sběru
   * 
   * ⚠️ DISABLED: Automatic collector is disabled because we use webhook for real-time notifications.
   * Webhook is more efficient and doesn't need periodic polling, which saves API credits.
   * 
   * For manual refresh use:
   * - Backfill: `collector:backfill WALLET_ADDRESS [LIMIT]`
   * - Process all: `collector:process-all`
   */
  start(): void {
    console.warn('⚠️  Automatic collector is DISABLED. We use webhook for real-time notifications.');
    console.warn('   This saves API credits and is more efficient.');
    console.warn('   For manual refresh, use:');
    console.warn('   - Backfill: pnpm --filter backend collector:backfill WALLET_ADDRESS [LIMIT]');
    console.warn('   - Process all: pnpm --filter backend collector:process-all');
    console.warn('   - Or use the API endpoint: POST /api/smart-wallets/backfill');
      return;
  }

  /**
   * Process transactions for one address
   * 
   * Uses Helius Enhanced API if available, otherwise fallback to RPC parsing
   * 
   * @param address Wallet address
   * @param limit Optional: number of transactions to fetch
   * @param ignoreLastTradeTimestamp Optional: if true, ignore lastTradeTimestamp and fetch all swaps (for manual refresh)
   * 
   * @throws HeliusRateLimitError if Helius rate-limits (429) - WE DON'T USE RPC fallback for 429!
   */
  private async processWallet(address: string, limit?: number, ignoreLastTradeTimestamp = false): Promise<{
    processed: number;
    trades: number;
    skipped: number;
  }> {
    // If we have Helius, use Enhanced API
    if (this.useHelius) {
      try {
        return await this.processWalletWithHelius(address, limit, ignoreLastTradeTimestamp);
      } catch (error: any) {
        // If it's 429 rate limit, propagate error up (WE DON'T USE RPC fallback!)
        if (error instanceof HeliusRateLimitError) {
          throw error; // Propagate up - main loop will handle it
        }
        
        // If it's 401 (invalid API key), disable Helius for future calls
        if (error.message?.includes('401') || error.message?.includes('Unauthorized') || error.message?.includes('invalid api key')) {
          console.error(`❌ Helius API key is invalid. Disabling Helius and using RPC fallback.`);
          console.error(`   Please check your HELIUS_API_KEY in .env file.`);
          (this as any).useHelius = false; // Disable Helius for future calls
        } else {
          console.error(`❌ Helius error for ${address}, falling back to RPC:`, error.message);
        }
        // Fallback to RPC if Helius fails (but NOT for 429!)
      }
    }

    // Fallback to standard RPC parsing
    return await this.processWalletWithRPC(address);
  }

  /**
   * Process wallet using Helius Enhanced API
   * 
   * @param address Wallet address
   * @param limit Optional: number of transactions to fetch
   * @param ignoreLastTradeTimestamp Optional: if true, ignore lastTradeTimestamp and fetch all swaps (for manual refresh)
   */
  private async processWalletWithHelius(address: string, limit?: number, ignoreLastTradeTimestamp = false): Promise<{
    processed: number;
    trades: number;
    skipped: number;
  }> {
    try {
      // DEBUG: Log address we're tracking
      console.log(`\n🔍 Collector is tracking wallet: ${address}`);
      console.log(`   📋 Requested limit: ${limit || 'default (20)'}`);
      
      // Get last processed trade for tracking
      const wallet = await this.smartWalletRepo.findByAddress(address);
      if (!wallet) {
        console.log(`   ⚠️  Wallet not found in database`);
        return { processed: 0, trades: 0, skipped: 0 };
      }
      console.log(`   ✅ Wallet found in DB: ${wallet.id}`);

      // Get all existing signatures from DB for duplicate check and pagination stop
      // NOTE: Automatic refresh is disabled - we use webhook
      // - Load all new trades (that aren't in DB yet)
      // - Stop pagination when we hit first trade that's already in DB
      // - This way we won't load any older trades than what we already have
      let lastTradeTimestamp: number | undefined = undefined;
      let lastSignature: string | undefined = undefined;
      let existingSignaturesForStop: Set<string> | null = null;

      // Load all existing trades from DB for duplicate check
      const allExistingTrades = await this.tradeRepo.findByWalletId(wallet.id, {
        page: 1,
        pageSize: 10000,
      });

      if (allExistingTrades.trades.length > 0) {
        // Get last trade (newest) for logging
        const lastTrade = allExistingTrades.trades[0]; // Trades are sorted from newest
        lastTradeTimestamp = new Date(lastTrade.timestamp).getTime() / 1000;
        lastSignature = lastTrade.txSignature;
        
        // Create Set of all existing signatures for fast check
        existingSignaturesForStop = new Set<string>();
        allExistingTrades.trades.forEach(t => {
          if (t.txSignature && existingSignaturesForStop) {
            existingSignaturesForStop.add(t.txSignature);
          }
        });
        
        console.log(`   📅 Found ${allExistingTrades.trades.length} existing trades in DB`);
        if (lastSignature) {
          console.log(`   📅 Last trade: ${new Date(lastTrade.timestamp).toISOString()} (${lastSignature.substring(0, 16)}...)`);
        }
        console.log(`   🔍 Will stop pagination when we hit any existing trade signature`);
      } else {
        console.log(`   📅 No trades in DB yet - will fetch all recent swaps`);
      }

      // Robust pagination: go backwards through pages and take only swap transactions
      // NOTE: Automatic refresh is disabled - we use webhook. This method is only used for:
      // - Manual refresh (backfill)
      // - Webhook processing (when we need to process specific transaction)
      // - Load all new trades (that aren't in DB yet)
      // - Stop pagination when we hit first trade that's already in DB
      const pageSize = Math.min(Math.max(limit ?? DEFAULT_HELIUS_PAGE_SIZE, 20), 200);
      
      let maxPages: number;
      if (ignoreLastTradeTimestamp || !limit) {
        // Manual refresh without limit: load all swaps (no limit on number of pages)
        // Stop when we hit trade that's already in DB
        maxPages = 9999; // Large number to load all new swaps
        console.log(`   📡 Will fetch all new swaps (no limit on pages, will stop when hitting existing trade)`);
      } else {
        // Manual refresh with limit: use limit (for faster scanning)
      const defaultTotalTarget = pageSize * DEFAULT_HELIUS_MAX_PAGES;
        const requestedTotal = Math.max(limit, defaultTotalTarget);
        maxPages = Math.ceil(requestedTotal / pageSize);
        console.log(`   📡 Fetching with limit: ${pageSize} tx per page (max ${maxPages} pages ≈ ${pageSize * maxPages} tx)`);
      }

      const inspectedTransactions: any[] = [];
      const swapTransactions: any[] = [];
      let cursor: string | undefined = undefined;
      let page = 0;
      let reachedHistory = false;
      let nonSwapCount = 0;
      let disallowedSourceCount = 0;
      let spamTokenCount = 0;
      const seenSwapSignatures = new Set<string>();

      while (page < maxPages && !reachedHistory) {
        console.log(`   📄 Page ${page + 1}/${maxPages}${cursor ? ` (before ${cursor.substring(0, 8)}...)` : ''}`);
        const pageTxs = await this.heliusClient.getTransactionsForAddress(address, {
          limit: pageSize,
          before: cursor,
        });

        if (pageTxs.length === 0) {
          console.log(`   ⚠️  Helius returned 0 transactions for page ${page + 1}`);
          break;
        }

        inspectedTransactions.push(...pageTxs);

        for (const tx of pageTxs) {
          // Stop pagination when we hit any trade that's already in DB
          // NOTE: Automatic refresh is disabled - we use webhook
          // - Helius returns transactions from newest to oldest
          // - First we load all new trades (that aren't in DB yet) → those get saved
          // - Then we hit trade that's already in DB (duplicate) → stop pagination
          // - This way we won't load any older trades than what we already have
          if (existingSignaturesForStop && existingSignaturesForStop.has(tx.signature)) {
            // Found trade that's already in DB - stop pagination
            // This way we won't load any older trades than what we already have
            reachedHistory = true;
            console.log(`   ⏹️  Reached existing trade signature (${tx.signature.substring(0, 16)}...), stopping pagination`);
            console.log(`      This means we've loaded all newer trades and now we're hitting older ones that are already in DB`);
            break; // Stop processing this page
          }

          // Skip spam
          if (hasSpamFlag(tx)) {
            spamTokenCount++;
            console.log(`      ⏭️  Spam token: ${tx.signature.substring(0, 8)}...`);
            continue;
          }

          if (seenSwapSignatures.has(tx.signature)) {
            continue;
          }

          // IMPORTANT: Try isWalletSwap first (fast)
          let isSwap = isWalletSwap(tx, address);
          let normalizedSwap: any = null; // Cache for normalizeSwap result
          
          // If isWalletSwap returns false, but transaction looks like swap candidate
          // (has token transfers + native transfers and wallet is participant),
          // try calling normalizeSwap - if it returns swap, consider it a swap
          if (!isSwap) {
            const tokenTransfers = tx.tokenTransfers ?? [];
            const nativeTransfers = tx.nativeTransfers ?? [];
            
            // Wallet must participate
            const walletInvolved =
              tokenTransfers.some(
                (t: any) => t.fromUserAccount === address || t.toUserAccount === address
              ) ||
              nativeTransfers.some(
                (n: any) => n.fromUserAccount === address || n.toUserAccount === address
              ) ||
              tx.accountData?.some(
                (acc: any) => acc.account === address && (acc.nativeBalanceChange !== 0 || (acc.tokenBalanceChanges?.length ?? 0) > 0)
              );
            
            // If has token transfers + native transfers and wallet is participant,
            // try normalizeSwap (might be swap that Helius didn't mark as type='SWAP')
            if (walletInvolved && (tokenTransfers.length > 0 || nativeTransfers.length > 0)) {
              normalizedSwap = this.heliusClient.normalizeSwap(tx as any, address);
              if (normalizedSwap) {
                // normalizeSwap was able to process → it's a swap!
                isSwap = true;
                console.log(`      ✅ Swap detected via normalizeSwap (Helius type: ${tx.type || 'unknown'}): ${tx.signature.substring(0, 8)}...`);
              }
            }
          }
          
          if (!isSwap) {
            nonSwapCount++;
            // Log only sometimes to avoid being too verbose
            if (Math.random() < 0.1) {
              console.log(`      ⏭️  Non-swap: ${tx.signature.substring(0, 8)}... - type: ${tx.type || 'unknown'}, source: ${tx.source || 'unknown'}`);
            }
            continue;
          }

          // DEBUG: Log every swap that passed filters
          const source = getTransactionSource(tx);
          const hasEventsSwap = !!(tx as any).events?.swap;
          const swapReason = tx.type === 'SWAP' ? 'type=SWAP' : (hasEventsSwap ? 'events.swap' : `normalizeSwap success`);
          console.log(`      ✅ Swap candidate: ${tx.signature.substring(0, 8)}... - ${swapReason}, timestamp: ${new Date(tx.timestamp * 1000).toISOString()}`);
          
          // Save normalized swap to tx object so it doesn't need to be called again during processing
          (tx as any)._normalizedSwap = normalizedSwap;
          
          swapTransactions.push(tx);
          seenSwapSignatures.add(tx.signature);
        }

        if (pageTxs.length > 0) {
          cursor = pageTxs[pageTxs.length - 1].signature;
        }
        page++;
      }

      if (inspectedTransactions.length > 0) {
        const newest = inspectedTransactions[0];
        const oldest = inspectedTransactions[inspectedTransactions.length - 1];
        console.log(`   📅 Helius newest: ${new Date(newest.timestamp * 1000).toISOString()} (${newest.type || 'unknown'}) - ${newest.signature.substring(0, 16)}...`);
        console.log(`   📅 Helius oldest: ${new Date(oldest.timestamp * 1000).toISOString()} (${oldest.type || 'unknown'}) - ${oldest.signature.substring(0, 16)}...`);
        
        console.log(`   📋 First 5 transactions from Helius (current window):`);
        inspectedTransactions.slice(0, 5).forEach((tx: any, idx: number) => {
          console.log(`      [${idx + 1}] ${tx.signature.substring(0, 16)}... - ${new Date(tx.timestamp * 1000).toISOString()} - type: ${tx.type || 'unknown'}, source: ${tx.source || 'unknown'}`);
        });
      }

      console.log(`   📥 Total inspected transactions: ${inspectedTransactions.length}`);
      console.log(`      - Non-swap entries: ${nonSwapCount}`);
      // disallowedSourceCount is no longer used (removed source filtering)
      console.log(`      - Spam token flags: ${spamTokenCount}`);
      console.log(`      - Swap candidates: ${swapTransactions.length}`);

      if (reachedHistory) {
        console.log(`   ⏹️  Stopped pagination – reached last processed trade timestamp (${new Date((lastTradeTimestamp || 0) * 1000).toISOString()})`);
      }

      console.log(`   🔄 Found ${swapTransactions.length} potential swaps after filtering`);
      console.log(`   📊 Transaction breakdown:`);
      console.log(`      - Total transactions from Helius: ${inspectedTransactions.length}`);
      console.log(`      - Potential swaps: ${swapTransactions.length}`);
      console.log(`      - Filtered out: ${inspectedTransactions.length - swapTransactions.length}`);
      
      const typeBreakdown = new Map<string, number>();
      inspectedTransactions.forEach((tx: any) => {
        const type = tx.type || 'UNKNOWN';
        typeBreakdown.set(type, (typeBreakdown.get(type) || 0) + 1);
      });
      console.log(`      - By type: ${Array.from(typeBreakdown.entries()).map(([type, count]) => `${type}: ${count}`).join(', ')}`);

      // Filtering by lastTradeTimestamp
      // NOTE: Automatic refresh is disabled - we use webhook
      // For manual refresh without limit: load all new swaps from last trade (filter by timestamp and duplicates)
      // For manual refresh with limit: load swaps by limit (filter only duplicates)
      let newTransactions: any[];
      
      if (ignoreLastTradeTimestamp) {
        // Manual refresh: load all swaps and filter only by duplicates (NOT by timestamp)
        // Reason: we want to load all new swaps that aren't in DB yet, regardless of timestamp
        console.log(`   🔄 Manual refresh: filtering swaps by duplicates only (ignoring timestamp)...`);
        
        // Check all existing signatures for duplicate check
          const allExistingTrades = await this.tradeRepo.findByWalletId(wallet.id, {
            page: 1,
            pageSize: 10000, // Get all trades for duplicate check
          });
        
        const existingSignatures = new Set<string>();
        allExistingTrades.trades.forEach(t => {
          if (t.txSignature) {
            existingSignatures.add(t.txSignature);
          }
        });
          
          console.log(`   🔄 Manual refresh: found ${allExistingTrades.trades.length} existing trades in DB`);
          console.log(`   🔄 Manual refresh: checking ${swapTransactions.length} swap candidates against ${existingSignatures.size} existing signatures...`);
          
        // Filter: only duplicates (NOT by timestamp - we want all new swaps)
          const duplicateSignatures: string[] = [];
          newTransactions = swapTransactions.filter(tx => {
          // Filter only duplicates - if we already have this swap in DB, skip it
            if (existingSignatures.has(tx.signature)) {
              duplicateSignatures.push(tx.signature.substring(0, 16) + '...');
              return false;
            }
            return true;
          });
          
          if (duplicateSignatures.length > 0) {
            console.log(`   ⏭️  Filtered out ${duplicateSignatures.length} duplicates: ${duplicateSignatures.slice(0, 5).join(', ')}${duplicateSignatures.length > 5 ? '...' : ''}`);
          }
        console.log(`   ✅ Manual refresh: found ${newTransactions.length} new swaps (${swapTransactions.length - newTransactions.length} filtered out)`);
      } else if (lastTradeTimestamp === undefined) {
        // We don't have any trade in DB - take all swaps (except duplicates)
        const existingSignatures = new Set<string>();
        if (lastSignature) {
          existingSignatures.add(lastSignature);
        }
        newTransactions = swapTransactions.filter(tx => !existingSignatures.has(tx.signature));
        console.log(`   ⚠️  No lastTradeTimestamp - taking ALL ${newTransactions.length} swaps (${swapTransactions.length - newTransactions.length} duplicates skipped)`);
      } else {
        // We have last trade - filter by signature and timestamp (only newer trades)
        newTransactions = swapTransactions.filter(tx => {
          // Filter by signature - must not be same as last trade
          if (tx.signature === lastSignature) {
            return false; // Same transaction
          }
          
          // Filter by timestamp - only newer than last trade
          // Helius returns timestamp in seconds (Unix timestamp)
          const txTimestamp = tx.timestamp;
          
          // If transaction has same timestamp as last trade, but different signature,
          // it might be transaction that happened in same block - check signature
          if (txTimestamp === lastTradeTimestamp) {
            // Same timestamp - skip only if it's same transaction (we already checked above)
            // If different signature, it might be valid swap from same block
            // But to be safe, skip it because we already have trade with same timestamp
            return false;
          }
          
          // Add small tolerance (1 second) for possible rounding errors
          if (txTimestamp < lastTradeTimestamp) {
            return false; // Older than last trade
          }
          
          return true;
        });
        
        // DEBUG: Log filtering
        console.log(`   🔍 After filtering by lastTradeTimestamp (${new Date(lastTradeTimestamp * 1000).toISOString()}):`);
        console.log(`      - Before filter: ${swapTransactions.length} swaps`);
        console.log(`      - After filter: ${newTransactions.length} new swaps`);
        
        if (newTransactions.length === 0 && swapTransactions.length > 0) {
          console.log(`   ⚠️  WARNING: All swaps were filtered out!`);
          console.log(`      - Oldest swap from Helius: ${new Date(swapTransactions[swapTransactions.length - 1].timestamp * 1000).toISOString()}`);
          console.log(`      - Last trade in DB: ${new Date(lastTradeTimestamp * 1000).toISOString()}`);
          console.log(`      - This might indicate a timestamp filtering issue!`);
        }
      }

      // HANDLING: When there are no swaps, return empty result WITHOUT working with timestamp
      if (newTransactions.length === 0) {
        if (lastTradeTimestamp !== undefined) {
          console.log(`   ⏭️  Wallet ${address.substring(0, 8)}...: No new swaps (last trade: ${new Date(lastTradeTimestamp * 1000).toISOString()})`);
        } else {
          console.log(`   ⏭️  Wallet ${address.substring(0, 8)}...: No swaps found in recent transactions`);
        }
        return { processed: 0, trades: 0, skipped: 0 };
      }

      // HANDLING: Check that we have at least one swap before accessing timestamp
      const newestSwap = newTransactions[0];
      if (!newestSwap || !newestSwap.timestamp) {
        console.log(`   ⏭️  Wallet ${address.substring(0, 8)}...: No valid swaps found`);
        return { processed: 0, trades: 0, skipped: 0 };
      }

      // Helius returns timestamp in seconds (Unix timestamp)
      const newestSwapTime = new Date(newestSwap.timestamp * 1000);
      if (isNaN(newestSwapTime.getTime())) {
        console.error(`   ❌ Invalid timestamp for swap ${newestSwap.signature.substring(0, 8)}...: ${newestSwap.timestamp}`);
        return { processed: 0, trades: 0, skipped: 0 };
      }

      console.log(`   📊 Wallet ${address.substring(0, 8)}...: Found ${newTransactions.length} new swaps (from ${inspectedTransactions.length} total${lastTradeTimestamp !== undefined ? `, last trade: ${new Date(lastTradeTimestamp * 1000).toISOString()}` : ''})`);

      // OPTIMIZATION: Batch token info fetching
      // 1. Get all unique token mints from new swaps
      const uniqueTokenMints = new Set<string>();
      const swaps: Array<{ tx: any; swap: any }> = [];

      let skippedExisting = 0;
      let skippedNormalize = 0;
      
      console.log(`   🔄 Processing ${newTransactions.length} swap transactions...`);

      for (const tx of newTransactions) {
        // Check if it already exists
        const existing = await this.tradeRepo.findBySignature(tx.signature);
        if (existing) {
          skippedExisting++;
          console.log(`   ⏭️  Skipping existing trade: ${tx.signature.substring(0, 16)}... (already in DB)`);
          continue;
        }

        // Normalize swap (use cache if exists from fallback logic)
        let swap = (tx as any)._normalizedSwap;
        if (!swap) {
          // If we don't have cache, call normalizeSwap
          swap = this.heliusClient.normalizeSwap(tx as any, address);
        }
        
        if (!swap) {
          skippedNormalize++;
          // More detailed logging for debugging - log EVERY skipped swap
          const txType = tx.type || 'unknown';
          const txSource = getTransactionSource(tx) || 'unknown';
          const hasEventsSwap = !!(tx as any).events?.swap;
          const tokenTransfersCount = tx.tokenTransfers?.length || 0;
          const nativeTransfersCount = tx.nativeTransfers?.length || 0;
          console.log(`   ⏭️  ⚠️  normalizeSwap returned NULL for: ${tx.signature.substring(0, 16)}...`);
          console.log(`      - timestamp: ${new Date(tx.timestamp * 1000).toISOString()}`);
          console.log(`      - type: ${txType}, source: ${txSource}`);
          console.log(`      - has events.swap: ${hasEventsSwap}, tokenTransfers: ${tokenTransfersCount}, nativeTransfers: ${nativeTransfersCount}`);
          if (hasEventsSwap) {
            const swapEvent = (tx as any).events.swap;
            console.log(`      - events.swap.tokenInputs: ${swapEvent.tokenInputs?.length || 0}`);
            console.log(`      - events.swap.tokenOutputs: ${swapEvent.tokenOutputs?.length || 0}`);
            console.log(`      - events.swap.nativeInput: ${swapEvent.nativeInput ? `${Number(swapEvent.nativeInput.amount) / 1e9} SOL` : 'none'}`);
            console.log(`      - events.swap.nativeOutput: ${swapEvent.nativeOutput ? `${Number(swapEvent.nativeOutput.amount) / 1e9} SOL` : 'none'}`);
          }
          continue;
        }

        console.log(`   ✅ Swap normalized: ${tx.signature.substring(0, 16)}... - ${swap.side} ${swap.amountToken.toFixed(4)} tokens (${swap.tokenMint.substring(0, 16)}...)`);

        swaps.push({ tx, swap });
        uniqueTokenMints.add(swap.tokenMint);
      }
      
      console.log(`   📊 Swap processing summary:`);
      console.log(`      - Total transactions: ${newTransactions.length}`);
      console.log(`      - Skipped (existing): ${skippedExisting}`);
      console.log(`      - Skipped (normalize returned null): ${skippedNormalize}`);
      console.log(`      - Valid swaps to save: ${swaps.length}`);

      // 2. Check which tokens we already have in DB with symbol/name
      const tokensToFetch = new Set<string>();
      const tokenCache = new Map<string, { symbol?: string; name?: string; decimals?: number }>();
      
      // Helper function for detecting garbage symbols (look like contract addresses)
      const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;
      const isGarbageSymbol = (symbol: string | null | undefined, mintAddress?: string): boolean => {
        if (!symbol) return false;
        const sym = symbol.trim();
        if (!sym) return false;
        
        // Long pure base58 string (probably full CA)
        if (sym.length > 15 && BASE58_REGEX.test(sym)) {
          return true;
        }
        
        // Shortened address with "..."
        if (sym.includes('...')) {
          return true;
        }
        
        // Symbol that equals mint address
        if (mintAddress && sym.toLowerCase() === mintAddress.toLowerCase()) {
          return true;
        }
        
        return false;
      };
      
      for (const mintAddress of uniqueTokenMints) {
        const WSOL_MINT = 'So11111111111111111111111111111111111111112';
        if (mintAddress === WSOL_MINT) {
          // SOL is hardcoded
          tokenCache.set(mintAddress, { symbol: 'SOL', name: 'Solana', decimals: 9 });
          continue;
        }
        
        // Check if we already have token in DB with symbol/name
        const existingToken = await this.tokenRepo.findByMintAddress(mintAddress);
        if (existingToken) {
          // We have token in DB
          const hasValidSymbol = existingToken.symbol && !isGarbageSymbol(existingToken.symbol, mintAddress);
          const hasValidName = !!existingToken.name;
          
          if (hasValidSymbol || hasValidName) {
            // We have valid symbol/name - use it
            tokenCache.set(mintAddress, {
              symbol: existingToken.symbol || undefined,
              name: existingToken.name || undefined,
              decimals: existingToken.decimals || 9,
            });
          } else {
            // We don't have valid symbol/name or have garbage symbol - try to load from API (even if token already exists)
            tokensToFetch.add(mintAddress);
          }
        } else {
          // Token doesn't exist in DB - need to load from API
          tokensToFetch.add(mintAddress);
        }
      }

      // 3. Batch fetch token info for tokens we don't have in DB
      // Use new TokenMetadataBatchService with rate limiting and DB caching
      if (tokensToFetch.size > 0) {
        console.log(`   🔍 Batch fetching token info for ${tokensToFetch.size} tokens...`);
        
        try {
          // Import TokenMetadataBatchService dynamically (to avoid circular dependency)
          const { TokenMetadataBatchService } = await import('./token-metadata-batch.service.js');
          const tokenMetadataBatchService = new TokenMetadataBatchService(
            this.heliusClient,
            this.tokenRepo
          );
          
          const batchTokenInfo = await tokenMetadataBatchService.getTokenMetadataBatch(Array.from(tokensToFetch));
          batchTokenInfo.forEach((info, mint) => {
            tokenCache.set(mint, info);
          });
          
          console.log(`   ✅ Found metadata for ${batchTokenInfo.size}/${tokensToFetch.size} tokens`);
        } catch (error: any) {
          // If it's 429 rate limit, propagate error up
          if (error instanceof HeliusRateLimitError) {
            throw error;
          }
          // Other errors we ignore - tokens will be without symbol/name
          console.warn(`   ⚠️  Error fetching token metadata: ${error.message}`);
        }
      }

      let newTrades = 0;
      let skipped = 0;

      console.log(`   📊 Starting to process ${newTransactions.length} new swap transactions...`);

      // 4. Sort swaps chronologically by timestamp (important for correct currentPosition calculation)
      swaps.sort((a, b) => {
        const timeA = a.swap.timestamp.getTime();
        const timeB = b.swap.timestamp.getTime();
        return timeA - timeB; // From oldest to newest
      });

      console.log(`   📅 Swaps sorted chronologically (${swaps.length} total)`);

      // 5. Process swaps with cached token info (now in chronological order)
      for (const { tx, swap } of swaps) {
        // Debug: Check transaction structure
        console.log(`   🔍 TX ${tx.signature.substring(0, 8)}...: type=${tx.type}, source=${tx.source || 'unknown'}, has events.swap=${!!(tx as any).events?.swap}`);
        if ((tx as any).events?.swap) {
          const swapEvent = (tx as any).events.swap;
          console.log(`      - tokenInputs: ${swapEvent.tokenInputs?.length || 0}, tokenOutputs: ${swapEvent.tokenOutputs?.length || 0}`);
          console.log(`      - innerSwaps: ${swapEvent.innerSwaps?.length || 0}`);
          console.log(`      - nativeInput: ${swapEvent.nativeInput ? `${swapEvent.nativeInput.account.substring(0, 8)}... ${Number(swapEvent.nativeInput.amount) / 1e9} SOL` : 'none'}`);
          console.log(`      - nativeOutput: ${swapEvent.nativeOutput ? `${swapEvent.nativeOutput.account.substring(0, 8)}... ${Number(swapEvent.nativeOutput.amount) / 1e9} SOL` : 'none'}`);
          if (swapEvent.innerSwaps?.[0]?.tokenOutputs) {
            console.log(`      - innerSwaps[0].tokenOutputs: ${swapEvent.innerSwaps[0].tokenOutputs.length}`);
          }
        }

        console.log(`   ✅ Normalized swap: ${swap.side} ${swap.amountToken.toFixed(4)} tokens (${swap.tokenMint.substring(0, 8)}...) via ${swap.dex} (${tx.signature.substring(0, 8)}...)`);

        // Use cached token info
        const cachedTokenInfo = tokenCache.get(swap.tokenMint);
        const tokenSymbol = cachedTokenInfo?.symbol;
        const tokenName = cachedTokenInfo?.name;
        const tokenDecimals = cachedTokenInfo?.decimals;
        
              if (tokenSymbol) {
          console.log(`   ✅ Token symbol: ${tokenSymbol} (${swap.tokenMint.substring(0, 8)}...)`);
        }

        const token = await this.tokenRepo.findOrCreate({
          mintAddress: swap.tokenMint,
          symbol: tokenSymbol,
          name: tokenName,
          decimals: tokenDecimals,
        });
        
        // Debug: Check if symbol was saved
        if (tokenSymbol && !token.symbol) {
          console.log(`   ⚠️  WARNING: Token symbol ${tokenSymbol} was not saved to DB for ${swap.tokenMint.substring(0, 8)}...`);
        } else if (token.symbol) {
          console.log(`   ✅ Token symbol in DB: ${token.symbol} (${swap.tokenMint.substring(0, 8)}...)`);
        }

        // Convert value to USD using token price from Birdeye API
        // IMPORTANT: Use historical token price from transaction time, not current price
        // valueUsd = amountToken * tokenPriceUsd (from Birdeye)
        let valueUsd = 0;
        
        // Import TokenPriceService dynamically (to avoid circular dependency)
        const { TokenPriceService } = await import('./token-price.service.js');
        const tokenPriceService = new TokenPriceService();
        
        const tokenPriceUsd = await tokenPriceService.getTokenPriceAtDate(swap.tokenMint, swap.timestamp);
        if (tokenPriceUsd !== null && tokenPriceUsd > 0) {
          valueUsd = swap.amountToken * tokenPriceUsd;
          console.log(`   💰 Token price from Birdeye: $${tokenPriceUsd.toFixed(6)} (historical at ${swap.timestamp.toISOString()})`);
        } else {
          // Fallback: use SOL price if Birdeye doesn't have token price
          console.warn(`   ⚠️  No token price from Birdeye for ${swap.tokenMint.substring(0, 8)}..., falling back to SOL price`);
          valueUsd = await this.solPriceService.solToUsdAtDate(swap.amountBase, swap.timestamp);
        }

        // MIN_NOTIONAL_USD filter - only if set > 0
        if (MIN_NOTIONAL_USD > 0 && valueUsd < MIN_NOTIONAL_USD) {
          skipped++;
          console.log(
            `   ⏭️  Skipping trade ${swap.txSignature.substring(0, 8)}... - value ${valueUsd.toFixed(
              2
            )} USD is below threshold $${MIN_NOTIONAL_USD}`
          );
          continue;
        }

        // Calculate % position change (how many % tokens added/removed)
        let positionChangePercent: number | undefined = undefined;
        
        // Find all previous trades for this token from this wallet (before current trade)
        const allTrades = await this.tradeRepo.findAllForMetrics(wallet.id);
        const tokenTrades = allTrades
          .filter(t => t.tokenId === token.id)
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()); // Sort chronologically
        
        // Check if this trade is chronologically first for given token
        const isFirstTradeForToken = tokenTrades.length === 0 || 
          (tokenTrades.length === 1 && tokenTrades[0].txSignature === swap.txSignature) ||
          (tokenTrades.length > 0 && tokenTrades[0].txSignature === swap.txSignature);
        
        // Calculate current position before this trade
        let balanceBefore = 0;
        let hasPreviousTrades = false;
        for (const prevTrade of tokenTrades) {
          if (prevTrade.txSignature === swap.txSignature) {
            break; // Stop before current trade
          }
          hasPreviousTrades = true;
          if (prevTrade.side === 'buy' || prevTrade.side === 'add') {
            balanceBefore += Number(prevTrade.amountToken);
          } else if (prevTrade.side === 'sell' || prevTrade.side === 'remove') {
            balanceBefore -= Number(prevTrade.amountToken);
          }
        }

        // Calculate balance AFTER this trade
        const balanceAfter = swap.side === 'buy' 
          ? balanceBefore + swap.amountToken 
          : balanceBefore - swap.amountToken;

        // Normalize balance for floating-point comparison
        const normalizedBalanceBefore = Math.abs(balanceBefore) < 0.000001 ? 0 : balanceBefore;
        const normalizedBalanceAfter = Math.abs(balanceAfter) < 0.000001 ? 0 : balanceAfter;

        // Determine trade type based on balance before and after
        // IMPORTANT: First purchase (balance from 0 to x) is ALWAYS BUY!
        let tradeType: 'buy' | 'sell' | 'add' | 'remove' = swap.side;
        if (swap.side === 'buy') {
          // If it's first trade for token or balanceBefore is 0, it's BUY
          if (isFirstTradeForToken || !hasPreviousTrades || normalizedBalanceBefore === 0) {
            // First purchase - BUY
            tradeType = 'buy';
          } else {
            // Additional purchase - ADD
            tradeType = 'add';
          }
        } else if (swap.side === 'sell') {
          if (normalizedBalanceAfter === 0 || normalizedBalanceAfter < 0) {
            // Final sale - SELL (balance is 0 or negative due to floating-point errors)
            tradeType = 'sell';
          } else if (normalizedBalanceAfter > 0) {
            // Partial sale - REM
            tradeType = 'remove';
          } else {
            // Edge case: sold more than had (shouldn't happen, but just in case)
            tradeType = 'sell';
          }
        }

        // Debug logging for trade type determination
        if (swap.tokenMint && (swap.tokenMint.includes('PorkAI') || swap.tokenMint.includes('pork'))) {
          console.log(`   🔍 Trade type determination for ${swap.tokenMint.substring(0, 16)}...:`);
          console.log(`      - swap.side: ${swap.side}`);
          console.log(`      - isFirstTradeForToken: ${isFirstTradeForToken}`);
          console.log(`      - hasPreviousTrades: ${hasPreviousTrades}`);
          console.log(`      - balanceBefore: ${balanceBefore.toFixed(6)} (normalized: ${normalizedBalanceBefore})`);
          console.log(`      - balanceAfter: ${balanceAfter.toFixed(6)} (normalized: ${normalizedBalanceAfter})`);
          console.log(`      - tradeType: ${tradeType}`);
          console.log(`      - amountToken: ${swap.amountToken.toFixed(6)}`);
        }

        let currentPosition = balanceBefore;
        
        // Calculate % position change
        // Limitation: if currentPosition is very small (less than 1% of amountToken),
        // consider it new position (100%) or sale of entire position (-100%)
        const MIN_POSITION_THRESHOLD = swap.amountToken * 0.01; // 1% of amountToken
        
        if (swap.side === 'buy') {
          // Bought tokens - added to position
          if (currentPosition > MIN_POSITION_THRESHOLD) {
            // Normal calculation
            positionChangePercent = (swap.amountToken / currentPosition) * 100;
            // Limit to maximum 1000% (10x) - if more, it's probably an error
            if (positionChangePercent > 1000) {
              positionChangePercent = 100; // Consider as new position
            }
          } else {
            // First purchase or very small position - 100% new position
            positionChangePercent = 100;
          }
        } else if (swap.side === 'sell') {
          // Sold tokens - removed from position
          if (currentPosition > MIN_POSITION_THRESHOLD) {
            // Normal calculation
            positionChangePercent = -(swap.amountToken / currentPosition) * 100;
            // Limit to maximum -100% (entire position sale)
            if (positionChangePercent < -100) {
              positionChangePercent = -100; // Consider as entire position sale
            }
            // If abs(positionChangePercent) is very large (more than 1000%), it's probably an error
            if (Math.abs(positionChangePercent) > 1000) {
              positionChangePercent = -100; // Consider as entire position sale
            }
          } else {
            // Sold, but didn't have position or very small position
            // If selling more than has, it's an error - mark as -100%
            if (swap.amountToken > currentPosition) {
              positionChangePercent = -100; // Sale of entire (small) position
            } else {
              positionChangePercent = currentPosition > 0 
                ? -(swap.amountToken / currentPosition) * 100 
                : 0;
            }
          }
        }

        // Calculate PnL for closed positions (sell)
        let pnlUsd: number | undefined = undefined;
        let pnlPercent: number | undefined = undefined;

        if (swap.side === 'sell') {
          // Find newest buy trade that isn't closed yet
          const openBuys = tokenTrades
            .filter(t => t.side === 'buy' && t.txSignature !== swap.txSignature)
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          
          // Find matching buy (FIFO - first bought, first sold)
          const matchingBuy = openBuys.find(buy => {
            // Check if this buy isn't already closed by another sell
            const sellsAfterBuy = tokenTrades.filter(t => 
              t.side === 'sell' && 
              new Date(t.timestamp) > new Date(buy.timestamp) &&
              t.txSignature !== swap.txSignature // Not current sell
            );
            return sellsAfterBuy.length === 0; // Buy is not closed
          });

          if (matchingBuy) {
            // NEW APPROACH: Realized PnL in base currency (proceedsBase - costBase)
            // proceedsBase = amountBase from SELL trade (what we received)
            // costBase = amountBase from BUY trade (what we paid)
            const proceedsBase = swap.amountBase; // What we received for sale
            const costBase = Number(matchingBuy.amountBase); // What we paid for purchase
            
            // Realized PnL in base currency
            const realizedPnlBase = proceedsBase - costBase;
            const realizedPnlPercentBase = costBase > 0 ? (realizedPnlBase / costBase) * 100 : 0;
            
            // For compatibility: convert to USD only for display (optional)
            // Use current SOL price for conversion (not historical, because PnL is in base currency)
            // NOTE: This works only for SOL as base token
            // For USDC/USDT it would be pnlUsd = realizedPnlBase (because 1 USDC = 1 USD)
            try {
              const currentSolPrice = await this.solPriceService.getSolPriceUsd();
              if (currentSolPrice > 0) {
                // If baseToken is SOL, convert to USD
                // If baseToken is USDC/USDT, pnlUsd = realizedPnlBase (1:1 with USD)
                const baseToken = swap.baseToken || 'SOL';
                if (baseToken === 'USDC' || baseToken === 'USDT') {
                  pnlUsd = realizedPnlBase; // 1:1 with USD
            } else {
                  pnlUsd = realizedPnlBase * currentSolPrice; // SOL → USD
                }
                pnlPercent = realizedPnlPercentBase; // Percentage is same in base and USD
              }
            } catch (error) {
              // If we fail to get SOL price, leave pnlUsd undefined
            }
          }
        }

        // Calculate priceUsd: priceBasePerToken * historical SOL price from Binance
        let priceUsd: number | null = null;
        try {
          const { BinancePriceService } = await import('./binance-price.service.js');
          const binancePriceService = new BinancePriceService();
          const solPriceAtTimestamp = await binancePriceService.getSolPriceAtTimestamp(swap.timestamp);
          const baseToken = swap.baseToken || 'SOL';
          
          if (baseToken === 'SOL') {
            priceUsd = swap.priceBasePerToken * solPriceAtTimestamp;
          } else if (baseToken === 'USDC' || baseToken === 'USDT') {
            // If base token is USDC/USDT, price is already in USD
            priceUsd = swap.priceBasePerToken;
          } else {
            // For other base tokens use SOL price as fallback
            priceUsd = swap.priceBasePerToken * solPriceAtTimestamp;
          }
        } catch (error: any) {
          console.warn(`⚠️  Failed to calculate priceUsd for trade ${swap.txSignature}: ${error.message}`);
        }

        // Debug: log positionChangePercent before saving
        if (positionChangePercent !== undefined) {
          const multiplier = positionChangePercent / 100;
          const multiplierStr = `${multiplier >= 0 ? '+' : ''}${multiplier.toFixed(2)}x`;
          console.log(`   📊 Position change calculated: ${positionChangePercent.toFixed(2)}% (${multiplierStr})`);
          console.log(`      - balanceBefore: ${balanceBefore.toFixed(6)}, balanceAfter: ${balanceAfter.toFixed(6)}`);
          console.log(`      - tradeType: ${tradeType}`);
        } else {
          console.log(`   ⚠️  Position change NOT calculated for ${swap.txSignature.substring(0, 8)}...`);
        }

        // Save trade
        try {
        console.log(`   💾 Saving trade to DB: ${swap.txSignature.substring(0, 16)}...`);
          console.log(`      - side: ${tradeType}, token: ${swap.tokenMint.substring(0, 16)}..., amount: ${swap.amountToken.toFixed(4)}, base: ${swap.amountBase.toFixed(6)} SOL`);
          console.log(`      - valueUsd: ${valueUsd.toFixed(2)}, priceUsd: ${priceUsd?.toFixed(6) || 'N/A'}, timestamp: ${swap.timestamp.toISOString()}`);
        
        const createdTrade = await this.tradeRepo.create({
          txSignature: swap.txSignature,
          walletId: wallet.id,
          tokenId: token.id,
            side: tradeType, // Use determined type (buy/add/remove/sell)
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
            source: 'helius-enhanced-api',
            heliusType: tx.type,
            heliusSource: tx.source,
              baseToken: swap.baseToken || 'SOL', // Save baseToken to meta
              priceUsd, // Save calculated price in USD
              balanceBefore,
              balanceAfter,
          },
        });
        
        console.log(`   ✅ Trade saved to DB with ID: ${createdTrade.id}`);

        // Debug: verify that positionChangePercent was saved
        if (createdTrade && createdTrade.positionChangePercent) {
          const savedPercent = Number(createdTrade.positionChangePercent);
          const multiplier = savedPercent / 100;
          const multiplierStr = `${multiplier >= 0 ? '+' : ''}${multiplier.toFixed(2)}x`;
          console.log(`   ✅ Position saved: ${savedPercent.toFixed(2)}% (${multiplierStr})`);
        } else {
          console.log(`   ⚠️  Position NOT saved in DB for ${swap.txSignature.substring(0, 8)}...`);
        }

        newTrades++;
        console.log(`   ✅ Helius swap: ${swap.txSignature.substring(0, 8)}... - ${swap.side} ${swap.amountToken.toFixed(4)} tokens`);
        } catch (error: any) {
          // Error saving trade - log, but continue with other swaps
          console.error(`   ❌ Error saving trade ${swap.txSignature.substring(0, 16)}... to DB:`, error.message);
          if (error.code) {
            console.error(`      Error code: ${error.code}`);
          }
          if (error.details) {
            console.error(`      Details: ${error.details}`);
          }
          skipped++;
          // Continue with next swap - don't stop processing entire wallet
        }

        // Note: currentPosition is recalculated for each swap from database,
        // which ensures correctness even with parallel processing or restart
        // Cache is not needed because calculation is fast and ensures consistency

        // Helius Enhanced API has good rate limits, delay is not needed
        // We save swaps quickly without unnecessary waiting
      }

      // Log summary after processing
      console.log(`   📊 Processing summary:`);
      console.log(`      - Total swap transactions to process: ${swaps.length}`);
      console.log(`      - Successfully saved: ${newTrades}`);
      console.log(`      - Total skipped: ${skipped}`);
      
      if (newTrades === 0 && swaps.length > 0) {
        console.log(`   ⚠️  WARNING: No trades were saved despite having ${swaps.length} swap transactions!`);
        console.log(`      This might indicate a problem with duplicate detection or normalization.`);
      }

      // Automatically recalculate metrics and create closed lots after adding new trades
      if (newTrades > 0) {
        try {
          // 1. Create closed lots (FIFO matching)
          console.log(`   📊 Creating closed lots after ${newTrades} new trades...`);
          const { LotMatchingService } = await import('./lot-matching.service.js');
          const lotMatchingService = new LotMatchingService();
          
          const walletForLots = await this.smartWalletRepo.findById(wallet.id);
          const trackingStartTime = walletForLots?.createdAt ? new Date(walletForLots.createdAt) : undefined;
          
          const closedLots = await lotMatchingService.processTradesForWallet(
            wallet.id,
            undefined, // Process all tokens
            trackingStartTime
          );
          
          await lotMatchingService.saveClosedLots(closedLots);
          const knownCostLots = closedLots.filter(l => l.costKnown);
          console.log(`   ✅ Created ${closedLots.length} closed lots (${knownCostLots.length} with known cost)`);
          
          // 2. Recalculate metrics
          console.log(`   📊 Recalculating metrics after ${newTrades} new trades...`);
          // Dynamically import MetricsCalculatorService (to avoid circular dependency)
          const { MetricsCalculatorService } = await import('./metrics-calculator.service.js');
          const { MetricsHistoryRepository } = await import('../repositories/metrics-history.repository.js');
          const metricsHistoryRepo = new MetricsHistoryRepository();
          const metricsCalculator = new MetricsCalculatorService(
            this.smartWalletRepo,
            this.tradeRepo,
            metricsHistoryRepo
          );
          await metricsCalculator.calculateMetricsForWallet(wallet.id);
          console.log(`   ✅ Metrics recalculated successfully`);
        } catch (error: any) {
          console.error(`   ⚠️  Failed to recalculate metrics/closed lots: ${error.message}`);
          // We don't want entire process to fail due to metrics error
        }
      }

      return {
        processed: newTransactions.length,
        trades: newTrades,
        skipped,
      };
    } catch (error: any) {
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      const errorStack = error?.stack ? error.stack.split('\n').slice(0, 5).join('\n') : '';
      console.error(`❌ Error processing wallet with Helius ${address}:`, errorMessage);
      if (errorStack) {
        console.error(`   Stack trace:`, errorStack);
      }
      if (error?.code) {
        console.error(`   Error code: ${error.code}`);
      }
      if (error?.status) {
        console.error(`   HTTP status: ${error.status}`);
      }
      if (error?.response?.data) {
        console.error(`   Response data:`, JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * Process wallet using standard RPC (fallback)
   */
  private async processWalletWithRPC(address: string): Promise<{
    processed: number;
    trades: number;
    skipped: number;
  }> {
    try {
      const publicKey = new PublicKey(address);
      // Reduced to 10 to lower rate limits during one-time processing
      const limit = 10;
      const signatures = await this.getSignaturesWithRetry(
        publicKey,
        limit,
      );

      let processed = 0;
      let trades = 0;
      let skipped = 0;

      let duplicateCount = 0;
      let nonSwapCount = 0;

      for (const sigInfo of signatures) {
        try {
          // Check if it's not already in DB
          const existingTrade = await this.tradeRepo.findBySignature(sigInfo.signature);
          if (existingTrade) {
            duplicateCount++;
            skipped++;
            continue; // Already processed
          }

          // Zpracuj transakci
          const hadTrade = await this.processTransaction(sigInfo.signature, address);
          if (hadTrade) {
            trades++;
          } else {
            nonSwapCount++;
            skipped++; // Not a swap
          }
          processed++;

          // Small safety delay between transactions (limiter handles most throttling)
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error: any) {
          console.error(`❌ Error processing transaction ${sigInfo.signature.substring(0, 8)}...:`, error.message);
          skipped++;
        }
      }

      if (processed > 0) {
        console.log(`   Wallet ${address.substring(0, 8)}...: ${trades} trades, ${duplicateCount} duplicates, ${nonSwapCount} non-swaps`);
      }

      // Automatically recalculate metrics after adding new trades
      if (trades > 0) {
        try {
          const wallet = await this.smartWalletRepo.findByAddress(address);
          if (wallet) {
            console.log(`   📊 Recalculating metrics after ${trades} new trades...`);
            // Dynamically import MetricsCalculatorService (to avoid circular dependency)
            const { MetricsCalculatorService } = await import('./metrics-calculator.service.js');
            const { MetricsHistoryRepository } = await import('../repositories/metrics-history.repository.js');
            const metricsHistoryRepo = new MetricsHistoryRepository();
            const metricsCalculator = new MetricsCalculatorService(
              this.smartWalletRepo,
              this.tradeRepo,
              metricsHistoryRepo
            );
            await metricsCalculator.calculateMetricsForWallet(wallet.id);
            console.log(`   ✅ Metrics recalculated successfully`);
          }
        } catch (error: any) {
          console.error(`   ⚠️  Failed to recalculate metrics: ${error.message}`);
          // We don't want entire process to fail due to metrics error
        }
      }
      
      return { processed, trades, skipped };
    } catch (error: any) {
      console.error(`❌ Error in processWallet for ${address}:`, error.message);
      throw error;
    }
  }

  /**
   * Process specific transaction (signature)
   * 
   * As specified: parse transaction using simple heuristic
   */
  async processTransaction(signature: string, walletAddress: string): Promise<boolean> {
    try {
      const tx = await this.getTransactionWithRetry(signature);
      if (!tx || !tx.meta) {
        return false; // Invalid transaction
      }

      // If there's an error, skip
      if (tx.meta.err) {
        return false; // Failed transaction
      }

      // Extract swap data using heuristic
      const swapData = this.extractSwapData(tx, walletAddress);
      
      if (!swapData) {
        // Debug: log why it's not a swap
        const preTokenCount = tx.meta.preTokenBalances?.length || 0;
        const postTokenCount = tx.meta.postTokenBalances?.length || 0;
        const hasPreBalances = (tx.meta.preBalances?.length || 0) > 0;
        const hasPostBalances = (tx.meta.postBalances?.length || 0) > 0;
        
        // Find wallet account index for SOL balance change
        let accountKeys: string[] = [];
        if (tx.transaction?.message?.accountKeys) {
          accountKeys = tx.transaction.message.accountKeys.map((key: any) => {
            if (typeof key === 'string') return key;
            if (key.pubkey) return typeof key.pubkey === 'string' ? key.pubkey : key.pubkey.toString();
            return key.toString();
          });
        }
        const walletAccountIndex = accountKeys.findIndex((key: string) => key === walletAddress);
        
        const hasInnerInstructions = (tx.meta.innerInstructions?.length || 0) > 0;
        const solBalanceChange = walletAccountIndex >= 0 && walletAccountIndex < tx.meta.preBalances.length && walletAccountIndex < tx.meta.postBalances.length
          ? ((tx.meta.postBalances[walletAccountIndex] - tx.meta.preBalances[walletAccountIndex]) / 1e9).toFixed(6)
          : 'N/A';
        
        // Check if has innerInstructions with token transfers
        let tokenTransferCount = 0;
        if (hasInnerInstructions && tx.meta.innerInstructions) {
          const innerIxCount = tx.meta.innerInstructions.reduce((sum: number, ix: any) => sum + (ix.instructions?.length || 0), 0);
          // Count token transfers
          for (const innerIx of tx.meta.innerInstructions) {
            if (innerIx.instructions) {
              for (const ix of innerIx.instructions) {
                if (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked') {
                  tokenTransferCount++;
                }
              }
            }
          }
          
          // Log only first 3 transactions for debugging
          if (Math.random() < 0.03) { // 3% chance
            console.log(`   🔍 TX ${signature.substring(0, 8)}...: no swap detected`);
            console.log(`      - preTokenBalances: ${preTokenCount}, postTokenBalances: ${postTokenCount}`);
            console.log(`      - SOL balance change: ${solBalanceChange} SOL`);
            console.log(`      - innerInstructions: ${hasInnerInstructions}, token transfers: ${tokenTransferCount}`);
          }
        }
        
        return false; // Not a swap
      }
      
      console.log(`   ✅ Found swap: ${signature.substring(0, 8)}... - ${swapData.side} ${swapData.amountToken.toFixed(4)} tokens`);

      // Najdi wallet v DB
      const wallet = await this.smartWalletRepo.findByAddress(walletAddress);
      if (!wallet) {
        console.warn(`⚠️  Wallet not found in database: ${walletAddress}`);
        return false;
      }

      // Verify if token mint_address already exists in tokens table
          // Get token info from Helius Token Metadata API
          let tokenSymbol: string | undefined = undefined;
          let tokenName: string | undefined = undefined;
          let tokenDecimals: number | undefined = undefined;
          
          // Special case: Native SOL
          const WSOL_MINT = 'So11111111111111111111111111111111111111112';
          if (swapData.tokenMint === WSOL_MINT) {
            tokenSymbol = 'SOL';
            tokenName = 'Solana';
            tokenDecimals = 9;
          } else if (this.useHelius) {
            // Use Helius Token Metadata API
            try {
              const tokenInfo = await this.heliusClient.getTokenInfo(swapData.tokenMint);
              if (tokenInfo) {
                tokenSymbol = tokenInfo.symbol;
                tokenName = tokenInfo.name;
                tokenDecimals = tokenInfo.decimals;
              }
            } catch (error: any) {
              // Ignore errors when getting token info - not critical
            }
      }

      const token = await this.tokenRepo.findOrCreate({
        mintAddress: swapData.tokenMint,
            symbol: tokenSymbol,
            name: tokenName,
            decimals: tokenDecimals,
          });

      // Ensure tx_signature + wallet_id + token_id + side combination is not saved twice
      // (duplicate protection - we already check by signature, but just in case)
      const existingTrade = await this.tradeRepo.findBySignature(signature);
      if (existingTrade) {
        console.log(`   ℹ️  Trade already exists in DB: ${signature.substring(0, 8)}...`);
        return true; // Already exists
      }

      // Create record in trades
      const timestamp = tx.blockTime 
        ? new Date(tx.blockTime * 1000)
        : new Date();

      // Calculate % position change (how many % tokens added/removed)
      let positionChangePercent: number | undefined = undefined;
      
      // Find all previous trades for this token from this wallet (before current trade)
      const allTrades = await this.tradeRepo.findAllForMetrics(wallet.id);
      const tokenTrades = allTrades
        .filter(t => t.tokenId === token.id)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()); // Sort chronologically
      
      // Check if this trade is chronologically first for given token
      const isFirstTradeForToken = tokenTrades.length === 0 || 
        (tokenTrades.length === 1 && tokenTrades[0].txSignature === signature) ||
        (tokenTrades.length > 0 && tokenTrades[0].txSignature === signature);
      
      // Calculate current position before this trade
      let balanceBefore = 0;
      let hasPreviousTrades = false;
      for (const prevTrade of tokenTrades) {
        if (prevTrade.txSignature === signature) {
          break; // Stop before current trade
        }
        hasPreviousTrades = true;
        if (prevTrade.side === 'buy' || prevTrade.side === 'add') {
          balanceBefore += Number(prevTrade.amountToken);
        } else if (prevTrade.side === 'sell' || prevTrade.side === 'remove') {
          balanceBefore -= Number(prevTrade.amountToken);
        }
      }

      // Calculate balance AFTER this trade
      const balanceAfter = swapData.side === 'buy' 
        ? balanceBefore + swapData.amountToken 
        : balanceBefore - swapData.amountToken;

      // Normalize balance for floating-point comparison
      const normalizedBalanceBefore = Math.abs(balanceBefore) < 0.000001 ? 0 : balanceBefore;
      const normalizedBalanceAfter = Math.abs(balanceAfter) < 0.000001 ? 0 : balanceAfter;

      // Determine trade type based on balance before and after
      // IMPORTANT: First purchase (balance from 0 to x) is ALWAYS BUY!
      let tradeType: 'buy' | 'sell' | 'add' | 'remove' = swapData.side;
      if (swapData.side === 'buy') {
        // Pokud je to první trade pro token nebo balanceBefore je 0, je to BUY
        if (isFirstTradeForToken || !hasPreviousTrades || normalizedBalanceBefore === 0) {
          // První nákup - BUY
          tradeType = 'buy';
        } else {
          // Další nákup - ADD
          tradeType = 'add';
        }
      } else if (swapData.side === 'sell') {
        if (normalizedBalanceAfter === 0 || normalizedBalanceAfter < 0) {
          // Final sale - SELL (balance is 0 or negative due to floating-point errors)
            tradeType = 'sell';
          } else if (normalizedBalanceAfter > 0) {
            // Partial sale - REM
          tradeType = 'remove';
        } else {
          // Edge case: sold more than had (shouldn't happen, but just in case)
          tradeType = 'sell';
        }
      }

      // Debug logging for trade type determination
      if (swapData.tokenMint && (swapData.tokenMint.includes('PorkAI') || swapData.tokenMint.includes('pork'))) {
        console.log(`   🔍 Trade type determination (webhook) for ${swapData.tokenMint.substring(0, 16)}...:`);
        console.log(`      - swap.side: ${swapData.side}`);
        console.log(`      - isFirstTradeForToken: ${isFirstTradeForToken}`);
        console.log(`      - hasPreviousTrades: ${hasPreviousTrades}`);
        console.log(`      - balanceBefore: ${balanceBefore.toFixed(6)} (normalized: ${normalizedBalanceBefore})`);
        console.log(`      - balanceAfter: ${balanceAfter.toFixed(6)} (normalized: ${normalizedBalanceAfter})`);
        console.log(`      - tradeType: ${tradeType}`);
        console.log(`      - amountToken: ${swapData.amountToken.toFixed(6)}`);
      }

      let currentPosition = balanceBefore;
      
      // Calculate % position change
      // Limitation: if currentPosition is very small (less than 1% of amountToken),
      // consider it new position (100%) or sale of entire position (-100%)
      const MIN_POSITION_THRESHOLD = swapData.amountToken * 0.01; // 1% z amountToken
      
      if (swapData.side === 'buy') {
        // Koupil tokeny - přidal k pozici
        if (currentPosition > MIN_POSITION_THRESHOLD) {
          // Normální výpočet
          positionChangePercent = (swapData.amountToken / currentPosition) * 100;
          // Omez na maximálně 1000% (10x) - pokud je více, je to pravděpodobně chyba
          if (positionChangePercent > 1000) {
            positionChangePercent = 100; // Považuj za novou pozici
          }
        } else {
          // První koupě nebo velmi malá pozice - 100% nová pozice
          positionChangePercent = 100;
        }
      } else if (swapData.side === 'sell') {
        // Prodal tokeny - odebral z pozice
        if (currentPosition > MIN_POSITION_THRESHOLD) {
          // Normální výpočet
          positionChangePercent = -(swapData.amountToken / currentPosition) * 100;
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
          if (swapData.amountToken > currentPosition) {
            positionChangePercent = -100; // Prodej celé (malé) pozice
          } else {
            positionChangePercent = currentPosition > 0 
              ? -(swapData.amountToken / currentPosition) * 100 
              : 0;
          }
        }
      }

      // Calculate priceUsd: priceBasePerToken * historical SOL price from Binance
      let priceUsd: number | null = null;
      try {
        const { BinancePriceService } = await import('./binance-price.service.js');
        const binancePriceService = new BinancePriceService();
        const solPriceAtTimestamp = await binancePriceService.getSolPriceAtTimestamp(timestamp);
        const baseToken = swapData.baseToken || 'SOL';
        
        if (baseToken === 'SOL') {
          priceUsd = swapData.priceBasePerToken * solPriceAtTimestamp;
        } else if (baseToken === 'USDC' || baseToken === 'USDT') {
          // Pokud je base token USDC/USDT, cena je už v USD
          priceUsd = swapData.priceBasePerToken;
        } else {
          // Pro jiné base tokeny použij SOL cenu jako fallback
          priceUsd = swapData.priceBasePerToken * solPriceAtTimestamp;
        }
      } catch (error: any) {
        console.warn(`⚠️  Failed to calculate priceUsd for trade ${signature}: ${error.message}`);
      }

      console.log(`   💾 Saving trade to DB: ${signature.substring(0, 8)}... (${tradeType}, ${swapData.amountToken.toFixed(4)} tokens, position change: ${positionChangePercent?.toFixed(2)}%)`);
      
      const createdTrade = await this.tradeRepo.create({
        txSignature: signature,
        walletId: wallet.id,
        tokenId: token.id,
        side: tradeType, // Use determined type (buy/add/remove/sell)
        amountToken: swapData.amountToken,
        amountBase: swapData.amountBase,
        priceBasePerToken: swapData.priceBasePerToken,
        timestamp,
        dex: 'unknown', // For now "unknown" (DEX detection will be added later)
        positionChangePercent,
        meta: {
          baseToken: swapData.baseToken || 'SOL',
          priceUsd, // Save calculated price in USD
          balanceBefore,
          balanceAfter,
          slot: tx.slot,
          fee: tx.meta.fee,
          baseToken: (swapData as any).baseToken || 'SOL', // Save baseToken to meta
        },
      });

      console.log(`   ✅ Trade saved successfully: ${createdTrade.id}`);

      return true; // Trade saved
    } catch (error: any) {
      // Don't catch errors - prefer log and continue
      console.error(`❌ Error in processTransaction ${signature.substring(0, 8)}...:`, error.message);
      return false;
    }
  }

  /**
   * Extrakce swap dat z transakce pomocí jednoduché heuristiky
   *
   * V1.5: Konzervativní detektor swapů:
   *  - Sleduje jen token balances, kde owner === walletAddress
   *  - Primárně řeší swapy se SOL jako base assetem
   *  - Navíc umí použít USDC/USDT jako base, pokud se SOL nemění
   *  - Detekuje swapy, kde se base (SOL/USDC/USDT) a SPL token mění opačným směrem
   *
   * Edge cases jako čistý token→token swap nebo komplexní Jupiter routy
   * tady zatím nejsou – ty budeme řešit v další iteraci.
   */
  private extractSwapData(transaction: any, walletAddress: string): {
    tokenMint: string;
    side: 'buy' | 'sell';
    amountToken: number;
    amountBase: number;
    priceBasePerToken: number;
  } | null {
    if (!transaction?.meta) return null;

    const meta = transaction.meta;
    const preTokenBalances = meta.preTokenBalances || [];
    const postTokenBalances = meta.postTokenBalances || [];
    const preBalances = meta.preBalances || [];
    const postBalances = meta.postBalances || [];

    // --- 1) Find wallet index in accountKeys (for SOL change) ---
    let accountKeys: string[] = [];
    if (transaction.transaction?.message?.accountKeys) {
      accountKeys = transaction.transaction.message.accountKeys.map((key: any) => {
        if (typeof key === 'string') return key;
        if (key.pubkey) return typeof key.pubkey === 'string' ? key.pubkey : key.pubkey.toString();
        return key.toString();
      });
    } else if (transaction.transaction?.message?.staticAccountKeys) {
      accountKeys = transaction.transaction.message.staticAccountKeys.map((key: any) => {
        if (typeof key === 'string') return key;
        if (key.pubkey) return typeof key.pubkey === 'string' ? key.pubkey : key.pubkey.toString();
        return key.toString();
      });
    }

    const walletIndex = accountKeys.findIndex(k => k === walletAddress);

    let solDelta = 0;
    if (
      walletIndex >= 0 &&
      walletIndex < preBalances.length &&
      walletIndex < postBalances.length
    ) {
      solDelta = (postBalances[walletIndex] - preBalances[walletIndex]) / 1e9; // lamports -> SOL
    }

    // --- 2) Calculate SPL token changes for this wallet ---
    type TokenChange = { mint: string; delta: number };

    const tokenMap = new Map<string, { pre: number; post: number }>();

    // pre
    for (const b of preTokenBalances) {
      const mint = b.mint;
      const owner = b.owner;
      if (owner !== walletAddress) continue; // track only tokens that actually belong to this wallet

      const ui = b.uiTokenAmount;
      const pre =
        ui?.uiAmount != null
          ? Number(ui.uiAmount)
          : ui?.uiAmountString
          ? Number(ui.uiAmountString)
          : ui?.amount
          ? Number(ui.amount) / Math.pow(10, ui.decimals || 9)
          : 0;

      tokenMap.set(mint, { pre, post: pre });
    }

    // post
    for (const b of postTokenBalances) {
      const mint = b.mint;
      const owner = b.owner;
      if (owner !== walletAddress) continue;

      const ui = b.uiTokenAmount;
      const post =
        ui?.uiAmount != null
          ? Number(ui.uiAmount)
          : ui?.uiAmountString
          ? Number(ui.uiAmountString)
          : ui?.amount
          ? Number(ui.amount) / Math.pow(10, ui.decimals || 9)
          : 0;

      const existing = tokenMap.get(mint);
      if (existing) {
        existing.post = post;
      } else {
        tokenMap.set(mint, { pre: 0, post });
      }
    }

    const tokenChanges: TokenChange[] = [];
    for (const [mint, { pre, post }] of tokenMap.entries()) {
      const delta = post - pre;
      if (Math.abs(delta) > 1e-9) {
        tokenChanges.push({ mint, delta });
      }
    }

    // no token change → won't be token swap
    if (tokenChanges.length === 0) {
      return null;
    }

    // --- 3) Split tokens into base (USDC/USDT) and others ---
    const BASE_TOKEN_MINTS = new Set<string>([
      // USDC
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      // USDT
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    ]);

    const baseTokenChanges: TokenChange[] = [];
    const nonBaseTokenChanges: TokenChange[] = [];

    for (const change of tokenChanges) {
      if (BASE_TOKEN_MINTS.has(change.mint)) {
        baseTokenChanges.push(change);
      } else {
        nonBaseTokenChanges.push(change);
      }
    }

    // We need at least one "non-base" token – pure USDC/USDT movements don't interest us
    if (nonBaseTokenChanges.length === 0) {
      return null;
    }

    // --- 4) Select main token (largest absolute change among non-base tokens) ---
    nonBaseTokenChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const main = nonBaseTokenChanges[0];
    const tokenMint = main.mint;
    const tokenDelta = main.delta;

    // --- 5) Find base change: first SOL, then possibly USDC/USDT ---
    const EPS = 1e-6;
    let baseDelta = 0;

    // 5a) Primarily SOL (native)
    if (Math.abs(solDelta) > EPS) {
      baseDelta = solDelta;
    }

    // 5b) Pokud není SOL změna, zkus USDC/USDT změnu pro wallet
    if (Math.abs(baseDelta) <= EPS && baseTokenChanges.length > 0) {
      // Vezmi base token s největší absolutní změnou
      baseTokenChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      baseDelta = baseTokenChanges[0].delta;
    }

    // Still no reasonable base change → we don't want it
    if (Math.abs(baseDelta) <= EPS) {
      return null;
    }

    // Token and base should move in opposite directions:
    // - tokenDelta > 0 a baseDelta < 0 => BUY
    // - tokenDelta < 0 a baseDelta > 0 => SELL
    if (tokenDelta === 0 || baseDelta === 0) {
      return null;
    }

    let side: 'buy' | 'sell' | null = null;
    if (tokenDelta > 0 && baseDelta < 0) {
      side = 'buy';
    } else if (tokenDelta < 0 && baseDelta > 0) {
      side = 'sell';
    }

    if (!side) {
      return null;
    }

    const amountToken = Math.abs(tokenDelta);
    const amountBase = Math.abs(baseDelta);
    const priceBasePerToken = amountBase / amountToken;

    return {
      tokenMint,
      side,
      amountToken,
      amountBase,
      priceBasePerToken,
    };
  }

  /**
   * Extrakce swap dat z innerInstructions (token transfers)
   * Fallback metoda, když token balances nejsou dostupné
   */
  private extractSwapFromInstructions(
    transaction: any,
    walletAddress: string,
    accountKeys: string[],
    solBalanceChange: number
  ): {
    tokenMint: string;
    side: 'buy' | 'sell';
    amountToken: number;
    amountBase: number;
    priceBasePerToken: number;
  } | null {
    if (!transaction?.meta?.innerInstructions) {
      return null;
    }

    // Najdi token transfers v innerInstructions
    const tokenTransfers: Array<{
      mint: string;
      from: string;
      to: string;
      amount: number;
    }> = [];

    for (const innerIx of transaction.meta.innerInstructions) {
      if (!innerIx.instructions) continue;
      
      for (const ix of innerIx.instructions) {
        // Parsed instruction pro token transfer
        if (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked') {
          const parsed = ix.parsed;
          const info = parsed.info;
          
          if (info.authority === walletAddress || info.source === walletAddress || info.destination === walletAddress) {
            // Najdi mint z account keys nebo z parsed info
            let mint: string | null = null;
            let amount = 0;
            
            if (parsed.type === 'transferChecked') {
              mint = info.mint;
              amount = parseFloat(info.tokenAmount?.uiAmountString || info.tokenAmount?.amount || '0');
            } else if (parsed.type === 'transfer') {
              // For transfer we need to find mint from account keys
              // Skip for now because we don't have mint
              continue;
            }
            
            if (mint && amount > 0) {
              const from = info.source || info.authority;
              const to = info.destination;
              
              tokenTransfers.push({
                mint,
                from,
                to,
                amount: from === walletAddress ? -amount : amount, // Negative if leaving wallet
              });
            }
          }
        }
      }
    }

    if (tokenTransfers.length === 0) {
    return null;
    }

    // Find main token transfer (largest change)
    tokenTransfers.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    const mainTransfer = tokenTransfers[0];
    
    // Base tokens
    const baseTokens = new Set([
      'So11111111111111111111111111111111111111112', // SOL/WSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ]);

    // If main transfer is base token, use next one
    if (baseTokens.has(mainTransfer.mint)) {
      if (tokenTransfers.length < 2) {
        return null; // Potřebujeme alespoň 2 tokeny pro swap
      }
      // Použij druhý token jako hlavní
      const tokenTransfer = tokenTransfers[1];
      const baseTransfer = mainTransfer;
      
      const amountToken = Math.abs(tokenTransfer.amount);
      const amountBase = Math.abs(baseTransfer.amount);
      const side: 'buy' | 'sell' = tokenTransfer.amount > 0 ? 'buy' : 'sell';
      const priceBasePerToken = amountBase / amountToken;

      return {
        tokenMint: tokenTransfer.mint,
        side,
        amountToken,
        amountBase,
        priceBasePerToken,
      };
    } else {
      // Hlavní transfer je token, použij SOL balance change jako base
      if (Math.abs(solBalanceChange) < 0.000001) {
        return null; // Nemáme base change
      }

      const amountToken = Math.abs(mainTransfer.amount);
      const amountBase = Math.abs(solBalanceChange);
      const side: 'buy' | 'sell' = mainTransfer.amount > 0 ? 'buy' : 'sell';
      const priceBasePerToken = amountBase / amountToken;

      // Kontrola: token a base by měly jít opačným směrem
      const tokenPositive = mainTransfer.amount > 0;
      const basePositive = solBalanceChange > 0;
      
      if (tokenPositive === basePositive) {
        return null; // Nejsou opačného směru
      }

      return {
        tokenMint: mainTransfer.mint,
        side,
        amountToken,
        amountBase,
        priceBasePerToken,
      };
    }
  }

  /**
   * Zastavení collectoru
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    console.log('🛑 Collector stopped');
  }

  /**
   * Manually fetch and process historical transactions for a wallet
   * Useful for backfilling data
   */
  async fetchHistoricalTransactions(walletAddress: string, limit = 100): Promise<void> {
    try {
      console.log(`📥 Fetching ${limit} historical transactions for ${walletAddress}...`);

      const publicKey = new PublicKey(walletAddress);
      const signatures = await this.getSignaturesWithRetry(publicKey, limit);

      console.log(`📊 Found ${signatures.length} transactions`);
      // Helius returns signatures from newest to oldest. For deterministic position
      // tracking we need to process from oldest to newest.
      const orderedSignatures = [...signatures].reverse();

      let processed = 0;
      let trades = 0;
      let skipped = 0;

      for (const sigInfo of orderedSignatures) {
        try {
          // Check if it's not already in DB
          const existingTrade = await this.tradeRepo.findBySignature(sigInfo.signature);
          if (existingTrade) {
            skipped++;
            continue;
          }

          // Zpracuj transakci
          const hadTrade = await this.processTransaction(sigInfo.signature, walletAddress);
          if (hadTrade) {
            trades++;
          } else {
            skipped++;
          }
          processed++;

          // Small safety delay between transactions
        await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error: any) {
          console.error(`❌ Error processing transaction ${sigInfo.signature.substring(0, 8)}...:`, error.message);
          skipped++;
        }
      }

      console.log(`✅ Backfill completed:`);
      console.log(`   - Transactions processed: ${processed}`);
      console.log(`   - New trades: ${trades}`);
      console.log(`   - Skipped: ${skipped}`);
    } catch (error: any) {
      console.error(`❌ Error in fetchHistoricalTransactions:`, error.message);
      throw error;
    }
  }

  /**
   * Získání token info z Jupiter Token List API
   * Používá endpoint se seznamem všech tokenů: https://token.jup.ag/all
   * Cache pro zlepšení výkonu - načteme seznam jednou a použijeme ho pro všechny tokeny
   */
  private jupiterTokenListCache: Array<{ address: string; symbol: string; name: string; decimals?: number }> | null = null;
  private jupiterTokenListCacheTime: number = 0;
  private readonly JUPITER_CACHE_TTL = 60 * 60 * 1000; // 1 hodina

  private async getTokenFromJupiterList(mintAddress: string): Promise<{ symbol: string; name: string; decimals?: number } | null> {
    try {
      const now = Date.now();
      
      // Try to use cache if still valid
      if (this.jupiterTokenListCache && (now - this.jupiterTokenListCacheTime) < this.JUPITER_CACHE_TTL) {
        const token = this.jupiterTokenListCache.find(t => t.address === mintAddress);
        if (token) {
          return {
            symbol: token.symbol,
            name: token.name || token.symbol,
            decimals: token.decimals,
          };
        }
        return null;
      }

      // Load list of all tokens from Jupiter API
      // Try different endpoints
      let response = await fetch('https://token.jup.ag/all', {
        headers: { 'Accept': 'application/json' }
      });
      
      if (!response.ok) {
        // Fallback to different endpoint
        response = await fetch('https://api.jup.ag/tokens/v1', {
          headers: { 'Accept': 'application/json' }
        });
      }
      
      if (!response.ok) {
        console.warn(`⚠️  Jupiter Token List API error: ${response.status}`);
        return null;
      }

      let tokens = await response.json();
      
      // Jupiter may return object with tokens array or directly array
      if (tokens && !Array.isArray(tokens)) {
        tokens = (tokens as any).tokens || (tokens as any).data || [];
      }
      
      if (!Array.isArray(tokens)) {
        console.warn(`⚠️  Jupiter Token List API returned invalid format`);
        return null;
      }
      
      const tokenList = tokens as Array<{
        address: string;
        symbol: string;
        name: string;
        decimals?: number;
      }>;

      // Save to cache
      this.jupiterTokenListCache = tokenList;
      this.jupiterTokenListCacheTime = now;

      // Najdi token
      const token = tokenList.find(t => t.address === mintAddress);
      
      if (token) {
        return {
          symbol: token.symbol,
          name: token.name || token.symbol,
          decimals: token.decimals,
        };
      }

      return null;
    } catch (error: any) {
      console.warn(`⚠️  Error fetching Jupiter Token List: ${error.message}`);
      return null;
    }
  }

  /**
   * Zpracování transakce z webhook notifikace
   * 
   * Tato metoda se volá, když přijde webhook notifikace od Helius
   * o nové transakci pro sledovanou wallet adresu.
   * 
   * @param tx Helius transakce (už rozparsovaná)
   * @param walletAddress Adresa walletky, která provedla transakci
   * @returns { saved: boolean, reason?: string }
   */
  async processWebhookTransaction(tx: any, walletAddress: string): Promise<{ saved: boolean; reason?: string }> {
    try {
      // Najdi wallet v DB
      const wallet = await this.smartWalletRepo.findByAddress(walletAddress);
      if (!wallet) {
        return { saved: false, reason: 'Wallet not found in DB' };
      }

      // Check if we already have this trade in DB
      const existing = await this.tradeRepo.findBySignature(tx.signature);
      if (existing) {
        return { saved: false, reason: 'Trade already exists' };
      }

      // Normalizuj swap
      const swap = this.heliusClient.normalizeSwap(tx, walletAddress);
      if (!swap) {
        return { saved: false, reason: 'Failed to normalize swap' };
      }

      // Get or create token
      const { TokenMetadataBatchService } = await import('./token-metadata-batch.service.js');
      const tokenMetadataBatchService = new TokenMetadataBatchService(
        this.heliusClient,
        this.tokenRepo
      );

      // Get token metadata
      const tokenMetadata = await tokenMetadataBatchService.getTokenMetadataBatch([swap.tokenMint]);
      const metadata = tokenMetadata.get(swap.tokenMint) || {};

      const token = await this.tokenRepo.findOrCreate({
        mintAddress: swap.tokenMint,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals,
      });

      // Convert value to USD using token price from Birdeye API
      let valueUsd = 0;
      const { TokenPriceService } = await import('./token-price.service.js');
      const tokenPriceService = new TokenPriceService();
      
      const tokenPriceUsd = await tokenPriceService.getTokenPriceAtDate(swap.tokenMint, swap.timestamp);
      if (tokenPriceUsd !== null && tokenPriceUsd > 0) {
        valueUsd = swap.amountToken * tokenPriceUsd;
      } else {
        // Fallback: use SOL price
        valueUsd = await this.solPriceService.solToUsdAtDate(swap.amountBase, swap.timestamp);
      }

      // MIN_NOTIONAL_USD filtr
      if (MIN_NOTIONAL_USD > 0 && valueUsd < MIN_NOTIONAL_USD) {
        return { saved: false, reason: `Value ${valueUsd.toFixed(2)} USD below threshold $${MIN_NOTIONAL_USD}` };
      }

      // Calculate % position change and determine trade type (BUY/ADD/REM/SELL)
      let positionChangePercent: number | undefined = undefined;
      let tradeType: 'buy' | 'sell' | 'add' | 'remove' = swap.side;
      
      const allTrades = await this.tradeRepo.findAllForMetrics(wallet.id);
      const tokenTrades = allTrades
        .filter(t => t.tokenId === token.id)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // Check if this trade is chronologically first for given token
      const isFirstTradeForToken = tokenTrades.length === 0 || 
        (tokenTrades.length === 1 && tokenTrades[0].txSignature === swap.txSignature) ||
        (tokenTrades.length > 0 && tokenTrades[0].txSignature === swap.txSignature);

      // Calculate balance BEFORE this trade
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

      // Calculate balance AFTER this trade
      const balanceAfter = swap.side === 'buy' 
        ? balanceBefore + swap.amountToken 
        : balanceBefore - swap.amountToken;

      // Normalize balance for floating-point comparison
      const normalizedBalanceBefore = Math.abs(balanceBefore) < 0.000001 ? 0 : balanceBefore;
      const normalizedBalanceAfter = Math.abs(balanceAfter) < 0.000001 ? 0 : balanceAfter;

      // Determine trade type based on balance before and after
      // IMPORTANT: First purchase (balance from 0 to x) is ALWAYS BUY!
      if (swap.side === 'buy') {
        // Pokud je to první trade pro token nebo balanceBefore je 0, je to BUY
        if (isFirstTradeForToken || !hasPreviousTrades || normalizedBalanceBefore === 0) {
          // První nákup - BUY
          tradeType = 'buy';
        } else {
          // Další nákup - ADD
          tradeType = 'add';
        }
      } else if (swap.side === 'sell') {
        if (normalizedBalanceAfter === 0 || normalizedBalanceAfter < 0) {
          // Final sale - SELL (balance is 0 or negative due to floating-point errors)
            tradeType = 'sell';
          } else if (normalizedBalanceAfter > 0) {
            // Partial sale - REM
          tradeType = 'remove';
        } else {
          // Edge case: sold more than had (shouldn't happen, but just in case)
          tradeType = 'sell';
        }
      }

      // Debug logging for trade type determination
      if (swap.tokenMint && (swap.tokenMint.includes('PorkAI') || swap.tokenMint.includes('pork'))) {
        console.log(`   🔍 Trade type determination (processWallet) for ${swap.tokenMint.substring(0, 16)}...:`);
        console.log(`      - swap.side: ${swap.side}`);
        console.log(`      - isFirstTradeForToken: ${isFirstTradeForToken}`);
        console.log(`      - hasPreviousTrades: ${hasPreviousTrades}`);
        console.log(`      - balanceBefore: ${balanceBefore.toFixed(6)} (normalized: ${normalizedBalanceBefore})`);
        console.log(`      - balanceAfter: ${balanceAfter.toFixed(6)} (normalized: ${normalizedBalanceAfter})`);
        console.log(`      - tradeType: ${tradeType}`);
        console.log(`      - amountToken: ${swap.amountToken.toFixed(6)}`);
      }

      let currentPosition = balanceBefore;

      const MIN_POSITION_THRESHOLD = swap.amountToken * 0.01;

      if (swap.side === 'buy') {
        if (currentPosition > MIN_POSITION_THRESHOLD) {
          positionChangePercent = (swap.amountToken / currentPosition) * 100;
          if (positionChangePercent > 1000) {
            positionChangePercent = 100;
          }
        } else {
          positionChangePercent = 100;
        }
      } else if (swap.side === 'sell') {
        if (currentPosition > MIN_POSITION_THRESHOLD) {
          positionChangePercent = -(swap.amountToken / currentPosition) * 100;
          if (positionChangePercent < -100) {
            positionChangePercent = -100;
          }
          if (Math.abs(positionChangePercent) > 1000) {
            positionChangePercent = -100;
          }
        } else {
          if (swap.amountToken > currentPosition) {
            positionChangePercent = -100;
          } else {
            positionChangePercent = currentPosition > 0 
              ? -(swap.amountToken / currentPosition) * 100 
              : 0;
          }
        }
      }

      // Calculate PnL for closed positions (sell)
      let pnlUsd: number | undefined = undefined;
      let pnlPercent: number | undefined = undefined;

      if (swap.side === 'sell') {
        const openBuys = tokenTrades
          .filter(t => t.side === 'buy' && t.txSignature !== swap.txSignature)
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        const matchingBuy = openBuys.find(buy => {
          const sellsAfterBuy = tokenTrades.filter(t => 
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
              if (baseToken === 'USDC' || baseToken === 'USDT') {
                pnlUsd = realizedPnlBase;
              } else {
                pnlUsd = realizedPnlBase * currentSolPrice;
              }
              pnlPercent = realizedPnlPercentBase;
            }
          } catch (error) {
            // Ignore
          }
        }
      }

      // Calculate priceUsd: priceBasePerToken * historical SOL price from Binance
      let priceUsd: number | null = null;
      try {
        const { BinancePriceService } = await import('./binance-price.service.js');
        const binancePriceService = new BinancePriceService();
        const solPriceAtTimestamp = await binancePriceService.getSolPriceAtTimestamp(swap.timestamp);
        const baseToken = swap.baseToken || 'SOL';
        
        if (baseToken === 'SOL') {
          priceUsd = swap.priceBasePerToken * solPriceAtTimestamp;
        } else if (baseToken === 'USDC' || baseToken === 'USDT') {
          // If base token is USDC/USDT, price is already in USD
            priceUsd = swap.priceBasePerToken;
          } else {
            // For other base tokens use SOL price as fallback
          priceUsd = swap.priceBasePerToken * solPriceAtTimestamp;
        }
      } catch (error: any) {
        console.warn(`⚠️  Failed to calculate priceUsd for trade ${swap.txSignature}: ${error.message}`);
      }

      // Save trade with determined type
      await this.tradeRepo.create({
        txSignature: swap.txSignature,
        walletId: wallet.id,
        tokenId: token.id,
        side: tradeType, // Use determined type (buy/add/remove/sell)
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
          priceUsd, // Save calculated price in USD
          balanceBefore,
          balanceAfter,
        },
      });

      // Automatically recalculate metrics after adding new trade
      try {
        const { MetricsCalculatorService } = await import('./metrics-calculator.service.js');
        const { MetricsHistoryRepository } = await import('../repositories/metrics-history.repository.js');
        const metricsHistoryRepo = new MetricsHistoryRepository();
        const metricsCalculator = new MetricsCalculatorService(
          this.smartWalletRepo,
          this.tradeRepo,
          metricsHistoryRepo
        );
        await metricsCalculator.calculateMetricsForWallet(wallet.id);
      } catch (error: any) {
        console.warn(`⚠️  Failed to recalculate metrics after webhook trade: ${error.message}`);
      }

      return { saved: true };
    } catch (error: any) {
      console.error(`❌ Error processing webhook transaction:`, error);
      return { saved: false, reason: error.message };
    }
  }
}
