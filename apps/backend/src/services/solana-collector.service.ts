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
// DŮLEŽITÉ: Pro manual refresh chceme všechny swapy, ne jen ty nad $5
// MIN_NOTIONAL_USD je nyní 0 (vypnuto) - můžeme ho zapnout přes env var pro automatický refresh
const MIN_NOTIONAL_USD = Number(process.env.MIN_NOTIONAL_USD || 0);

const ALLOWED_SWAP_SOURCES = new Set<string>([
  // Hlavní DEXy (ověřené z Helius API)
  'JUPITER',
  'JUPITER_LIMIT',
  'RAYDIUM',
  'PUMP_FUN',
  'PUMP_AMM', // Pump.fun AMM
  'METEORA',
  'OKX',
  
  // Další známé DEXy
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
  
  // Potenciální DEXy (ještě neověřené přes Helius API)
  // Pokud se objeví v logu jako "Disallowed source", přidáme je
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
        // Použij BigInt, pokud je k dispozici, jinak fallback na Number
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
  if (!source) return true; // raději nezabít swapy s UNKNOWN

  // Pokud je source v allowlistu, je to plus – ale nebudeme kvůli tomu swapy zabíjet.
  if (ALLOWED_SWAP_SOURCES.has(source)) {
    return true;
  }

  // Prozatím NEfiltrujeme podle source – je to jen hint (logging, případně budoucí zpřísnění).
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
 * DŮLEŽITÉ: Pokud Helius říká type='SWAP', věříme mu a necháme normalizeSwap rozhodnout detaily.
 */
const isWalletSwap = (tx: any, wallet: string): boolean => {
  // Pokud Helius explicitně říká type='SWAP', věříme mu
  // (Helius už swap identifikoval, necháme normalizeSwap rozhodnout detaily)
  if (tx.type === 'SWAP') {
    // Ještě zkontrolujeme, že peněženka je účastník (minimální kontrola)
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
      return true; // Helius říká SWAP + peněženka je účastník → swap
    }
  }

  // Pokud nemáme type='SWAP', použijeme původní logiku
  if (!isSwapTx(tx)) return false;

  // Preferovaná cesta: máme events.swap → použijeme striktní logiku
  if (tx.events?.swap) {
    if (!isRealTokenSwap(tx)) return false;
    if (!swapInvolvesWallet(tx, wallet)) return false;
    // Source tady používáme jen jako hint (logy), ne pro tvrdé filtrování
    return true;
  }

  // Fallback: nemáme events.swap (např. některé legacy / specifické DEXy)
  // Použijeme jednodušší heuristiku nad tokenTransfers/nativeTransfers.
  const tokenTransfers = tx.tokenTransfers ?? [];
  const nativeTransfers = tx.nativeTransfers ?? [];

  // Peněženka se musí účastnit aspoň jednoho transferu
  const walletInvolved =
    tokenTransfers.some(
      (t: any) => t.fromUserAccount === wallet || t.toUserAccount === wallet
    ) ||
    nativeTransfers.some(
      (n: any) => n.fromUserAccount === wallet || n.toUserAccount === wallet
    );

  if (!walletInvolved) return false;

  // Musí to vypadat jako token swap – minimálně 2 různé tokeny
  // nebo kombinace token + native transfer.
  const uniqueMints = new Set<string>(tokenTransfers.map((t: any) => t.mint).filter(Boolean));
  const looksLikeTokenSwap =
    uniqueMints.size >= 2 || (uniqueMints.size === 1 && nativeTransfers.length > 0);

  if (!looksLikeTokenSwap) return false;

  // Source jen jako hint – pokud je uveden a není v allowlistu, raději přeskočíme.
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
   * Naplánuje RPC volání přes limiter
   */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = async () => {
        // Počkej na minTime od posledního volání
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
          // Spusť další z fronty, pokud je místo
          if (this.queue.length > 0 && this.running < this.maxConcurrency) {
            const next = this.queue.shift()!;
            next();
          }
        }
      };

      // Pokud máme místo, spusť hned, jinak přidej do fronty
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
 * Periodicky sbírá transakce pro tracked smart wallets a ukládá swapy do databáze.
 * 
 * Datový tok:
 * 1. Načte seznam sledovaných adres z databáze (smart_wallets.address)
 * 2. Pro každou adresu stáhne poslední transakce z Solana RPC
 * 3. Najde swap-like transakce (SPL token ↔ SOL/WSOL/stable)
 * 4. Uloží je do tabulky trades
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

  // Globální RPC limiter (společný pro všechna volání na Solana RPC)
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
    
    // SOL price service pro převod na USD
    this.solPriceService = new SolPriceService();
    
    if (this.useHelius) {
      console.log('✅ Helius API enabled - using Enhanced API for better swap detection');
    } else {
      console.log('⚠️  Helius API not configured - using standard RPC parsing');
    }
    
    // Konfigurace z .env nebo defaultní hodnoty
    // Default: 5 minut (300s) místo 60s pro snížení API requestů
    this.intervalSeconds = parseInt(process.env.COLLECTOR_INTERVAL_SECONDS || '300');
    this.maxTransactionsPerWallet = parseInt(process.env.COLLECTOR_MAX_TX_PER_WALLET || '50');

    this.rpcMaxConcurrency = parseInt(process.env.SOLANA_RPC_MAX_CONCURRENCY || '3');
    this.rpcMinTimeMs = parseInt(process.env.SOLANA_RPC_MIN_TIME_MS || '300'); // min 300ms mezi requesty
    this.rpcMaxRetries = parseInt(process.env.SOLANA_RPC_MAX_RETRIES || '5');
    this.rpcBaseDelayMs = parseInt(process.env.SOLANA_RPC_BASE_DELAY_MS || '1000'); // 1s základní delay pro backoff

    this.rpcLimiter = new RpcLimiter(this.rpcMaxConcurrency, this.rpcMinTimeMs);
  }

  /**
   * Obecný wrapper pro RPC volání s globálním limiterem + retry logikou
   */
  private async rpcCallWithRetry<T>(
    opName: 'getSignaturesForAddress' | 'getTransaction' | 'getParsedTransaction',
    fn: () => Promise<T>
  ): Promise<T> {
    let attempt = 0;

    // Pomocná funkce na zjištění, jestli je to rate-limit chyba
    const isRateLimitError = (error: any) => {
      const msg = String(error?.message || '');
      return msg.includes('429') || msg.toLowerCase().includes('too many requests');
    };

    while (true) {
      try {
        // Všechna RPC volání jdou přes globální limiter
        return await this.rpcLimiter.schedule(fn);
      } catch (error: any) {
        attempt++;
        if (!isRateLimitError(error) || attempt > this.rpcMaxRetries) {
          console.error(`❌ RPC ${opName} failed after ${attempt} attempts:`, error?.message || error);
          throw error;
        }

        // Exponenciální backoff – 1s, 2s, 4s, 8s, ...
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
    // Použij getParsedTransaction - vrací lepší strukturovaná data s token balances
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
      // Pokud getParsedTransaction selže, zkus normální getTransaction
      console.warn(`⚠️  getParsedTransaction failed for ${signature.substring(0, 8)}..., trying getTransaction: ${error.message}`);
    }
    
    // Fallback na normální getTransaction
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
   * Podle zadání: spuštění periodického sběru pomocí setInterval
   */
  start(): void {
    if (this.isRunning) {
      console.log('⚠️  Collector is already running');
      return;
    }

    this.isRunning = true;
    console.log(`🚀 Starting Solana Collector...`);
    console.log(`📊 Config: interval=${this.intervalSeconds}s, maxTxPerWallet=${this.maxTransactionsPerWallet}`);

    // Spusť první kolo hned
    this.collectOnce().catch(error => {
      console.error('❌ Error in initial collection:', error);
    });

    // Pak periodicky
    this.intervalId = setInterval(async () => {
      if (!this.isRunning) {
        if (this.intervalId) {
          clearInterval(this.intervalId);
          this.intervalId = null;
        }
        return;
      }
      await this.collectOnce();
    }, this.intervalSeconds * 1000);

    console.log(`✅ Collector started with ${this.intervalSeconds}s interval`);
  }

  /**
   * Interně – jedno kolo sběru
   * 
   * Podle zadání: projde všechny walletky a zpracuje jejich transakce
   */
  private async collectOnce(): Promise<void> {
    try {
    // 1. Načti seznam sledovaných adres z databáze
    const addresses = await this.smartWalletRepo.getAllAddresses();
      
    if (addresses.length === 0) {
      console.log('⚠️  No wallets to track. Add wallets first via API.');
      return;
    }

      console.log(`📊 Starting collection round for ${addresses.length} wallets...`);

      let totalProcessed = 0;
      let totalTrades = 0;
      let totalSkipped = 0;
      let totalErrors = 0;

      // 2. Pro každou adresu zpracuj transakce
    for (const address of addresses) {
      try {
          const result = await this.processWallet(address);
          totalProcessed += result.processed;
          totalTrades += result.trades;
          totalSkipped += result.skipped;
          
          // Delay between wallets to avoid rate limiting
          // Helius Enhanced API má dobré rate limits, ale stále potřebujeme delay
          const delayMs = this.useHelius ? 2000 : 5000; // 2s pro Helius, 5s pro RPC
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } catch (error: any) {
          // Speciální handling pro Helius rate limit - ukonči run a dej pauzu
          if (error instanceof HeliusRateLimitError) {
            console.warn(`⚠️  Helius rate limited - sleeping for ${error.retryAfterMs}ms and ending this run.`);
            console.warn(`   Processed ${totalProcessed} wallets before rate limit.`);
            await new Promise(resolve => setTimeout(resolve, error.retryAfterMs));
            break; // Ukonči aktuální run collectoru
          }
          
          totalErrors++;
          console.error(`❌ Error processing wallet ${address}:`, error.message);
          
          // Delay even on error (ale ne pro rate limit - ten už máme ošetřený výše)
          const delayMs = this.useHelius ? 2000 : 5000;
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      console.log(`✅ Collection round completed:`);
      console.log(`   - Wallets: ${addresses.length}`);
      console.log(`   - Transactions processed: ${totalProcessed}`);
      console.log(`   - New trades: ${totalTrades}`);
      console.log(`   - Skipped (duplicates/non-swaps): ${totalSkipped}`);
      console.log(`   - Errors: ${totalErrors}`);
    } catch (error: any) {
      console.error(`❌ Error in collectOnce:`, error.message);
    }
  }

  /**
   * Zpracování transakcí pro jednu adresu
   * 
   * Použije Helius Enhanced API pokud je dostupné, jinak fallback na RPC parsing
   * 
   * @param address Wallet address
   * @param limit Optional: number of transactions to fetch
   * @param ignoreLastTradeTimestamp Optional: if true, ignore lastTradeTimestamp and fetch all swaps (for manual refresh)
   * 
   * @throws HeliusRateLimitError pokud Helius rate-limitne (429) - NEPOUŽÍVÁME RPC fallback pro 429!
   */
  private async processWallet(address: string, limit?: number, ignoreLastTradeTimestamp = false): Promise<{
    processed: number;
    trades: number;
    skipped: number;
  }> {
    // Pokud máme Helius, použij Enhanced API
    if (this.useHelius) {
      try {
        return await this.processWalletWithHelius(address, limit, ignoreLastTradeTimestamp);
      } catch (error: any) {
        // Pokud je to 429 rate limit, propaguj chybu nahoru (NEPOUŽÍVÁME RPC fallback!)
        if (error instanceof HeliusRateLimitError) {
          throw error; // Propaguj nahoru - hlavní loop to ošetří
        }
        
        // Pokud je to 401 (neplatný API key), deaktivuj Helius pro další volání
        if (error.message?.includes('401') || error.message?.includes('Unauthorized') || error.message?.includes('invalid api key')) {
          console.error(`❌ Helius API key is invalid. Disabling Helius and using RPC fallback.`);
          console.error(`   Please check your HELIUS_API_KEY in .env file.`);
          (this as any).useHelius = false; // Deaktivuj Helius pro další volání
        } else {
          console.error(`❌ Helius error for ${address}, falling back to RPC:`, error.message);
        }
        // Fallback na RPC pokud Helius selže (ale NE pro 429!)
      }
    }

    // Fallback na standardní RPC parsing
    return await this.processWalletWithRPC(address);
  }

  /**
   * Zpracování walletky pomocí Helius Enhanced API
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
      // DEBUG: Log adresu, kterou trackujeme
      console.log(`\n🔍 Collector is tracking wallet: ${address}`);
      console.log(`   📋 Requested limit: ${limit || 'default (20)'}`);
      
      // Získej poslední zpracovaný trade pro tracking
      const wallet = await this.smartWalletRepo.findByAddress(address);
      if (!wallet) {
        console.log(`   ⚠️  Wallet not found in database`);
        return { processed: 0, trades: 0, skipped: 0 };
      }
      console.log(`   ✅ Wallet found in DB: ${wallet.id}`);

      // Získej všechny existující signature z DB pro kontrolu duplikátů a zastavení paginace
      // Tato logika funguje pro manual refresh i automatický refresh:
      // - Načteme všechny nové trades (které ještě nejsou v DB)
      // - Zastavíme paginaci, když narazíme na první trade, který už je v DB
      // - Tím pádem nenačteme žádné starší trades než ty, které už máme
      let lastTradeTimestamp: number | undefined = undefined;
      let lastSignature: string | undefined = undefined;
      let existingSignaturesForStop: Set<string> | null = null;

      // Načteme všechny existující trades z DB pro kontrolu duplikátů
      const allExistingTrades = await this.tradeRepo.findByWalletId(wallet.id, {
        page: 1,
        pageSize: 10000,
      });

      if (allExistingTrades.trades.length > 0) {
        // Získej poslední trade (nejnovější) pro logování
        const lastTrade = allExistingTrades.trades[0]; // Trades jsou seřazené od nejnovějších
        lastTradeTimestamp = new Date(lastTrade.timestamp).getTime() / 1000;
        lastSignature = lastTrade.txSignature;
        
        // Vytvoř Set všech existujících signature pro rychlou kontrolu
        existingSignaturesForStop = new Set<string>();
        allExistingTrades.trades.forEach(t => {
          if (t.txSignature) {
            existingSignaturesForStop.add(t.txSignature);
          }
        });
        
        console.log(`   📅 Found ${allExistingTrades.trades.length} existing trades in DB`);
        console.log(`   📅 Last trade: ${new Date(lastTrade.timestamp).toISOString()} (${lastSignature.substring(0, 16)}...)`);
        console.log(`   🔍 Will stop pagination when we hit any existing trade signature`);
      } else {
        console.log(`   📅 No trades in DB yet - will fetch all recent swaps`);
      }

      // Robustní stránkování: projíždíme dozadu po stránkách a bereme jen swapové transakce
      // UNIVERZÁLNÍ LOGIKA: Pro manual refresh i automatický refresh používáme stejnou logiku:
      // - Načteme všechny nové trades (které ještě nejsou v DB)
      // - Zastavíme paginaci, když narazíme na první trade, který už je v DB
      // - Tím pádem nenačteme žádné starší trades než ty, které už máme
      const pageSize = Math.min(Math.max(limit ?? DEFAULT_HELIUS_PAGE_SIZE, 20), 200);
      
      let maxPages: number;
      if (ignoreLastTradeTimestamp || !limit) {
        // Manual refresh nebo automatický refresh bez limitu: načteme všechny swapy (bez limitu na počet stránek)
        // Zastavíme, když narazíme na trade, který už je v DB
        maxPages = 9999; // Velké číslo, aby se načetly všechny nové swapy
        console.log(`   📡 Will fetch all new swaps (no limit on pages, will stop when hitting existing trade)`);
      } else {
        // Automatický refresh s limitem: použijeme limit (pro rychlejší skenování)
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
          // UNIVERZÁLNÍ LOGIKA: Zastav paginaci, když narazíme na jakýkoliv trade, který už je v DB
          // Tato logika funguje pro manual refresh i automatický refresh:
          // - Helius vrací transakce od nejnovějších k nejstarším
          // - Nejdřív načteme všechny nové trades (které ještě nejsou v DB) → ty se uloží
          // - Pak narazíme na trade, který už je v DB (duplikát) → zastavíme paginaci
          // - Tím pádem nenačteme žádné starší trades než ty, které už máme
          if (existingSignaturesForStop && existingSignaturesForStop.has(tx.signature)) {
            // Našli jsme trade, který už je v DB - zastavíme paginaci
            // Tím pádem nenačteme žádné starší trades než ty, které už máme
            reachedHistory = true;
            console.log(`   ⏹️  Reached existing trade signature (${tx.signature.substring(0, 16)}...), stopping pagination`);
            console.log(`      This means we've loaded all newer trades and now we're hitting older ones that are already in DB`);
            break; // Zastav zpracování této stránky
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

          // DŮLEŽITÉ: Zkusme nejdřív isWalletSwap (rychlé)
          let isSwap = isWalletSwap(tx, address);
          let normalizedSwap: any = null; // Cache pro normalizeSwap výsledek
          
          // Pokud isWalletSwap vrátí false, ale transakce vypadá jako swap kandidát
          // (má token transfers + native transfers a peněženka je účastník),
          // zkusme zavolat normalizeSwap - pokud vrátí swap, považujme to za swap
          if (!isSwap) {
            const tokenTransfers = tx.tokenTransfers ?? [];
            const nativeTransfers = tx.nativeTransfers ?? [];
            
            // Peněženka se musí účastnit
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
            
            // Pokud má token transfers + native transfers a peněženka je účastník,
            // zkusme normalizeSwap (může to být swap, který Helius neoznačil jako type='SWAP')
            if (walletInvolved && (tokenTransfers.length > 0 || nativeTransfers.length > 0)) {
              normalizedSwap = this.heliusClient.normalizeSwap(tx as any, address);
              if (normalizedSwap) {
                // normalizeSwap dokázal zpracovat → je to swap!
                isSwap = true;
                console.log(`      ✅ Swap detected via normalizeSwap (Helius type: ${tx.type || 'unknown'}): ${tx.signature.substring(0, 8)}...`);
              }
            }
          }
          
          if (!isSwap) {
            nonSwapCount++;
            // Loguj jen někdy, aby to nebylo příliš verbose
            if (Math.random() < 0.1) {
              console.log(`      ⏭️  Non-swap: ${tx.signature.substring(0, 8)}... - type: ${tx.type || 'unknown'}, source: ${tx.source || 'unknown'}`);
            }
            continue;
          }

          // DEBUG: Log každý swap, který prošel filtry
          const source = getTransactionSource(tx);
          const hasEventsSwap = !!(tx as any).events?.swap;
          const swapReason = tx.type === 'SWAP' ? 'type=SWAP' : (hasEventsSwap ? 'events.swap' : `normalizeSwap success`);
          console.log(`      ✅ Swap candidate: ${tx.signature.substring(0, 8)}... - ${swapReason}, timestamp: ${new Date(tx.timestamp * 1000).toISOString()}`);
          
          // Ulož normalized swap do tx objektu, aby se nemusel volat znovu při zpracování
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

      // Filtrování podle lastTradeTimestamp
      // Pro manual refresh bez limitu: načteme všechny nové swapy od posledního trade (filtrujeme podle timestampu i duplikátů)
      // Pro manual refresh s limitem: načteme swapy podle limitu (filtrujeme jen duplikáty)
      // Pro automatický refresh: filtrujeme jen novější než lastTradeTimestamp
      let newTransactions: any[];
      
      if (ignoreLastTradeTimestamp) {
        // Manual refresh: načteme všechny swapy a filtrujeme jen podle duplikátů (NE podle timestampu)
        // Důvod: chceme načíst všechny nové swapy, které ještě nejsou v DB, bez ohledu na timestamp
        console.log(`   🔄 Manual refresh: filtering swaps by duplicates only (ignoring timestamp)...`);
        
        // Zkontroluj všechny existující signature pro kontrolu duplikátů
        const allExistingTrades = await this.tradeRepo.findByWalletId(wallet.id, {
          page: 1,
          pageSize: 10000, // Získej všechny trady pro kontrolu duplikátů
        });
        
        const existingSignatures = new Set<string>();
        allExistingTrades.trades.forEach(t => {
          if (t.txSignature) {
            existingSignatures.add(t.txSignature);
          }
        });
        
        console.log(`   🔄 Manual refresh: found ${allExistingTrades.trades.length} existing trades in DB`);
        console.log(`   🔄 Manual refresh: checking ${swapTransactions.length} swap candidates against ${existingSignatures.size} existing signatures...`);
        
        // Filtruj: jen duplikáty (NE podle timestampu - chceme všechny nové swapy)
        const duplicateSignatures: string[] = [];
        newTransactions = swapTransactions.filter(tx => {
          // Filtruj jen duplikáty - pokud už máme tento swap v DB, přeskočíme ho
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
        // Nemáme žádný trade v DB - vezmeme všechny swapy (kromě duplikátů)
        const existingSignatures = new Set<string>();
        if (lastSignature) {
          existingSignatures.add(lastSignature);
        }
        newTransactions = swapTransactions.filter(tx => !existingSignatures.has(tx.signature));
        console.log(`   ⚠️  No lastTradeTimestamp - taking ALL ${newTransactions.length} swaps (${swapTransactions.length - newTransactions.length} duplicates skipped)`);
      } else {
        // Máme poslední trade a NENÍ to manual refresh - filtrujeme podle signature a timestampu
        newTransactions = swapTransactions.filter(tx => {
          // Filtruj podle signature - nesmí být stejná jako poslední trade
          if (tx.signature === lastSignature) {
            return false; // Stejná transakce
          }
          
          // Filtruj podle timestampu - jen novější než poslední trade
          // Helius vrací timestamp v sekundách (Unix timestamp)
          const txTimestamp = tx.timestamp;
          
          // Pokud má transakce stejný timestamp jako poslední trade, ale jinou signature,
          // může to být transakce, která proběhla ve stejném bloku - zkontrolujme signature
          if (txTimestamp === lastTradeTimestamp) {
            // Stejný timestamp - přeskočíme jen pokud je to stejná transakce (už jsme to zkontrolovali výše)
            // Pokud je jiná signature, může to být validní swap ze stejného bloku
            // Ale pro jistotu je přeskočíme, protože už máme trade se stejným timestampem
            return false;
          }
          
          // Přidáme malou toleranci (1 sekunda) pro případné zaokrouhlovací chyby
          if (txTimestamp < lastTradeTimestamp) {
            return false; // Starší než poslední trade
          }
          
          return true;
        });
        
        // DEBUG: Log filtrování
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

      // OŠETŘENÍ: Když nejsou žádné swapy, vrať prázdný výsledek BEZ práce s timestampem
      if (newTransactions.length === 0) {
        if (lastTradeTimestamp !== undefined) {
          console.log(`   ⏭️  Wallet ${address.substring(0, 8)}...: No new swaps (last trade: ${new Date(lastTradeTimestamp * 1000).toISOString()})`);
        } else {
          console.log(`   ⏭️  Wallet ${address.substring(0, 8)}...: No swaps found in recent transactions`);
        }
        return { processed: 0, trades: 0, skipped: 0 };
      }

      // OŠETŘENÍ: Zkontroluj, že máme alespoň jeden swap před přístupem k timestampu
      const newestSwap = newTransactions[0];
      if (!newestSwap || !newestSwap.timestamp) {
        console.log(`   ⏭️  Wallet ${address.substring(0, 8)}...: No valid swaps found`);
        return { processed: 0, trades: 0, skipped: 0 };
      }

      // Helius vrací timestamp v sekundách (Unix timestamp)
      const newestSwapTime = new Date(newestSwap.timestamp * 1000);
      if (isNaN(newestSwapTime.getTime())) {
        console.error(`   ❌ Invalid timestamp for swap ${newestSwap.signature.substring(0, 8)}...: ${newestSwap.timestamp}`);
        return { processed: 0, trades: 0, skipped: 0 };
      }

      console.log(`   📊 Wallet ${address.substring(0, 8)}...: Found ${newTransactions.length} new swaps (from ${inspectedTransactions.length} total${lastTradeTimestamp !== undefined ? `, last trade: ${new Date(lastTradeTimestamp * 1000).toISOString()}` : ''})`);

      // OPTIMALIZACE: Batch token info fetching
      // 1. Získej všechny unikátní token mints z nových swapů
      const uniqueTokenMints = new Set<string>();
      const swaps: Array<{ tx: any; swap: any }> = [];

      let skippedExisting = 0;
      let skippedNormalize = 0;
      
      console.log(`   🔄 Processing ${newTransactions.length} swap transactions...`);

      for (const tx of newTransactions) {
        // Zkontroluj, jestli už existuje
        const existing = await this.tradeRepo.findBySignature(tx.signature);
        if (existing) {
          skippedExisting++;
          console.log(`   ⏭️  Skipping existing trade: ${tx.signature.substring(0, 16)}... (already in DB)`);
          continue;
        }

        // Normalizuj swap (použij cache, pokud existuje z fallback logiky)
        let swap = (tx as any)._normalizedSwap;
        if (!swap) {
          // Pokud nemáme cache, zavolej normalizeSwap
          swap = this.heliusClient.normalizeSwap(tx as any, address);
        }
        
        if (!swap) {
          skippedNormalize++;
          // Podrobnější logování pro debugging - loguj KAŽDÝ přeskočený swap
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

      // 2. Zkontroluj, které tokeny už máme v DB s symbol/name
      const tokensToFetch = new Set<string>();
      const tokenCache = new Map<string, { symbol?: string; name?: string; decimals?: number }>();
      
      // Helper funkce pro detekci garbage symbolů (vypadají jako contract adresy)
      const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;
      const isGarbageSymbol = (symbol: string | null | undefined, mintAddress?: string): boolean => {
        if (!symbol) return false;
        const sym = symbol.trim();
        if (!sym) return false;
        
        // Dlouhý čistý base58 string (pravděpodobně plná CA)
        if (sym.length > 15 && BASE58_REGEX.test(sym)) {
          return true;
        }
        
        // Zkrácená adresa s "..."
        if (sym.includes('...')) {
          return true;
        }
        
        // Symbol, který se rovná mint adrese
        if (mintAddress && sym.toLowerCase() === mintAddress.toLowerCase()) {
          return true;
        }
        
        return false;
      };
      
      for (const mintAddress of uniqueTokenMints) {
        const WSOL_MINT = 'So11111111111111111111111111111111111111112';
        if (mintAddress === WSOL_MINT) {
          // SOL máme hardcoded
          tokenCache.set(mintAddress, { symbol: 'SOL', name: 'Solana', decimals: 9 });
          continue;
        }
        
        // Zkontroluj, jestli už máme token v DB s symbol/name
        const existingToken = await this.tokenRepo.findByMintAddress(mintAddress);
        if (existingToken) {
          // Máme token v DB
          const hasValidSymbol = existingToken.symbol && !isGarbageSymbol(existingToken.symbol, mintAddress);
          const hasValidName = !!existingToken.name;
          
          if (hasValidSymbol || hasValidName) {
            // Máme validní symbol/name - použijeme ho
            tokenCache.set(mintAddress, {
              symbol: existingToken.symbol || undefined,
              name: existingToken.name || undefined,
              decimals: existingToken.decimals || 9,
            });
          } else {
            // Nemáme validní symbol/name nebo máme garbage symbol - zkusíme načíst z API (i když už token existuje)
            tokensToFetch.add(mintAddress);
          }
        } else {
          // Token neexistuje v DB - potřebujeme načíst z API
          tokensToFetch.add(mintAddress);
        }
      }

      // 3. Batch fetch token info pro tokeny, které nemáme v DB
      // Použij nový TokenMetadataBatchService s rate limitingem a cachováním v DB
      if (tokensToFetch.size > 0) {
        console.log(`   🔍 Batch fetching token info for ${tokensToFetch.size} tokens...`);
        
        try {
          // Import TokenMetadataBatchService dynamicky (aby se vyhnul circular dependency)
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
          // Pokud je to 429 rate limit, propaguj chybu nahoru
          if (error instanceof HeliusRateLimitError) {
            throw error;
          }
          // Jiné chyby ignorujeme - tokeny budou bez symbolu/name
          console.warn(`   ⚠️  Error fetching token metadata: ${error.message}`);
        }
      }

      let newTrades = 0;
      let skipped = 0;
      
      console.log(`   📊 Starting to process ${newTransactions.length} new swap transactions...`);
      
      // 4. Seřaď swapy chronologicky podle timestamp (důležité pro správný výpočet currentPosition)
      swaps.sort((a, b) => {
        const timeA = a.swap.timestamp.getTime();
        const timeB = b.swap.timestamp.getTime();
        return timeA - timeB; // Od nejstaršího k nejnovějšímu
      });

      console.log(`   📅 Swaps sorted chronologically (${swaps.length} total)`);

      // 5. Zpracuj swapy s cachovanými token info (nyní v chronologickém pořadí)
      for (const { tx, swap } of swaps) {
        // Debug: Zkontroluj strukturu transakce
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

        // Použij cachované token info
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
        
        // Debug: Zkontroluj, jestli se symbol uložil
        if (tokenSymbol && !token.symbol) {
          console.log(`   ⚠️  WARNING: Token symbol ${tokenSymbol} was not saved to DB for ${swap.tokenMint.substring(0, 8)}...`);
        } else if (token.symbol) {
          console.log(`   ✅ Token symbol in DB: ${token.symbol} (${swap.tokenMint.substring(0, 8)}...)`);
        }

        // Převod hodnoty na USD pomocí ceny tokenu z Birdeye API
        // DŮLEŽITÉ: Použij historickou cenu tokenu z doby transakce, ne aktuální cenu
        // valueUsd = amountToken * tokenPriceUsd (z Birdeye)
        let valueUsd = 0;
        
        // Import TokenPriceService dynamicky (aby se vyhnul circular dependency)
        const { TokenPriceService } = await import('./token-price.service.js');
        const tokenPriceService = new TokenPriceService();
        
        const tokenPriceUsd = await tokenPriceService.getTokenPriceAtDate(swap.tokenMint, swap.timestamp);
        if (tokenPriceUsd !== null && tokenPriceUsd > 0) {
          valueUsd = swap.amountToken * tokenPriceUsd;
          console.log(`   💰 Token price from Birdeye: $${tokenPriceUsd.toFixed(6)} (historical at ${swap.timestamp.toISOString()})`);
        } else {
          // Fallback: použij SOL cenu pokud Birdeye nemá cenu tokenu
          console.warn(`   ⚠️  No token price from Birdeye for ${swap.tokenMint.substring(0, 8)}..., falling back to SOL price`);
          valueUsd = await this.solPriceService.solToUsdAtDate(swap.amountBase, swap.timestamp);
        }

        // MIN_NOTIONAL_USD filtr - pouze pokud je nastaveno > 0
        if (MIN_NOTIONAL_USD > 0 && valueUsd < MIN_NOTIONAL_USD) {
          skipped++;
          console.log(
            `   ⏭️  Skipping trade ${swap.txSignature.substring(0, 8)}... - value ${valueUsd.toFixed(
              2
            )} USD is below threshold $${MIN_NOTIONAL_USD}`
          );
          continue;
        }

        // Výpočet % změny pozice (kolik % tokenů přidal/odebral)
        let positionChangePercent: number | undefined = undefined;
        
        // Najdi všechny předchozí trady pro tento token od této walletky (před aktuálním trade)
        const allTrades = await this.tradeRepo.findAllForMetrics(wallet.id);
        const tokenTrades = allTrades
          .filter(t => t.tokenId === token.id)
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()); // Seřaď chronologicky
        
        // Vypočti aktuální pozici před tímto trade
        let currentPosition = 0;
        for (const prevTrade of tokenTrades) {
          if (prevTrade.txSignature === swap.txSignature) {
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
        const MIN_POSITION_THRESHOLD = swap.amountToken * 0.01; // 1% z amountToken
        
        if (swap.side === 'buy') {
          // Koupil tokeny - přidal k pozici
          if (currentPosition > MIN_POSITION_THRESHOLD) {
            // Normální výpočet
            positionChangePercent = (swap.amountToken / currentPosition) * 100;
            // Omez na maximálně 1000% (10x) - pokud je více, je to pravděpodobně chyba
            if (positionChangePercent > 1000) {
              positionChangePercent = 100; // Považuj za novou pozici
            }
          } else {
            // První koupě nebo velmi malá pozice - 100% nová pozice
            positionChangePercent = 100;
          }
        } else if (swap.side === 'sell') {
          // Prodal tokeny - odebral z pozice
          if (currentPosition > MIN_POSITION_THRESHOLD) {
            // Normální výpočet
            positionChangePercent = -(swap.amountToken / currentPosition) * 100;
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
            if (swap.amountToken > currentPosition) {
              positionChangePercent = -100; // Prodej celé (malé) pozice
            } else {
              positionChangePercent = currentPosition > 0 
                ? -(swap.amountToken / currentPosition) * 100 
                : 0;
            }
          }
        }

        // Výpočet PnL pro uzavřené pozice (sell)
        let pnlUsd: number | undefined = undefined;
        let pnlPercent: number | undefined = undefined;

        if (swap.side === 'sell') {
          // Najdi nejnovější buy trade, který ještě není uzavřený
          const openBuys = tokenTrades
            .filter(t => t.side === 'buy' && t.txSignature !== swap.txSignature)
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          
          // Najdi odpovídající buy (FIFO - první koupený, první prodaný)
          const matchingBuy = openBuys.find(buy => {
            // Zkontroluj, jestli už není tento buy uzavřený jiným sell
            const sellsAfterBuy = tokenTrades.filter(t => 
              t.side === 'sell' && 
              new Date(t.timestamp) > new Date(buy.timestamp) &&
              t.txSignature !== swap.txSignature // Neaktuální sell
            );
            return sellsAfterBuy.length === 0; // Buy není uzavřený
          });

          if (matchingBuy) {
            // NOVÝ PŘÍSTUP: Realized PnL v base měně (proceedsBase - costBase)
            // proceedsBase = amountBase z SELL trade (co jsme dostali)
            // costBase = amountBase z BUY trade (co jsme zaplatili)
            const proceedsBase = swap.amountBase; // Co jsme dostali za prodej
            const costBase = Number(matchingBuy.amountBase); // Co jsme zaplatili za nákup
            
            // Realized PnL v base měně
            const realizedPnlBase = proceedsBase - costBase;
            const realizedPnlPercentBase = costBase > 0 ? (realizedPnlBase / costBase) * 100 : 0;
            
            // Pro kompatibilitu: převeď na USD pouze pro zobrazení (volitelné)
            // Použij aktuální SOL cenu pro převod (ne historickou, protože PnL je v base měně)
            // POZNÁMKA: Toto funguje pouze pro SOL jako base token
            // Pro USDC/USDT by bylo pnlUsd = realizedPnlBase (protože 1 USDC = 1 USD)
            try {
              const currentSolPrice = await this.solPriceService.getSolPriceUsd();
              if (currentSolPrice > 0) {
                // Pokud baseToken je SOL, převeď na USD
                // Pokud baseToken je USDC/USDT, pnlUsd = realizedPnlBase (1:1 s USD)
                const baseToken = swap.baseToken || 'SOL';
                if (baseToken === 'USDC' || baseToken === 'USDT') {
                  pnlUsd = realizedPnlBase; // 1:1 s USD
                } else {
                  pnlUsd = realizedPnlBase * currentSolPrice; // SOL → USD
                }
                pnlPercent = realizedPnlPercentBase; // Procento je stejné v base i USD
              }
            } catch (error) {
              // Pokud se nepodaří získat SOL cenu, nech pnlUsd undefined
            }
          }
        }

        // Debug: log positionChangePercent před uložením
        if (positionChangePercent !== undefined) {
          const multiplier = positionChangePercent / 100;
          const multiplierStr = `${multiplier >= 0 ? '+' : ''}${multiplier.toFixed(2)}x`;
          console.log(`   📊 Position change calculated: ${positionChangePercent.toFixed(2)}% (${multiplierStr})`);
          console.log(`      - currentPosition: ${currentPosition.toFixed(6)}`);
          console.log(`      - amountToken: ${swap.amountToken.toFixed(6)}`);
        } else {
          console.log(`   ⚠️  Position change NOT calculated for ${swap.txSignature.substring(0, 8)}...`);
        }

        // Ulož trade
        try {
          console.log(`   💾 Saving trade to DB: ${swap.txSignature.substring(0, 16)}...`);
          console.log(`      - side: ${swap.side}, token: ${swap.tokenMint.substring(0, 16)}..., amount: ${swap.amountToken.toFixed(4)}, base: ${swap.amountBase.toFixed(6)} SOL`);
          console.log(`      - valueUsd: ${valueUsd.toFixed(2)}, timestamp: ${swap.timestamp.toISOString()}`);
          
          const createdTrade = await this.tradeRepo.create({
            txSignature: swap.txSignature,
            walletId: wallet.id,
            tokenId: token.id,
            side: swap.side,
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
              baseToken: swap.baseToken || 'SOL', // Ulož baseToken do meta
            },
          });
          
          console.log(`   ✅ Trade saved to DB with ID: ${createdTrade.id}`);

          // Debug: ověř, že positionChangePercent se uložil
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
          // Chyba při ukládání trade - loguj, ale pokračuj s dalšími swapy
          console.error(`   ❌ Error saving trade ${swap.txSignature.substring(0, 16)}... to DB:`, error.message);
          if (error.code) {
            console.error(`      Error code: ${error.code}`);
          }
          if (error.details) {
            console.error(`      Details: ${error.details}`);
          }
          skipped++;
          // Pokračuj s dalším swapem - neukončuj zpracování celé walletky
        }

        // Poznámka: currentPosition se počítá znovu pro každý swap z databáze,
        // což zajišťuje správnost i při paralelním zpracování nebo při restartu
        // Cache není potřeba, protože výpočet je rychlý a zajišťuje konzistenci

        // Helius Enhanced API má dobré rate limits, delay není potřeba
        // Ukládáme swapy rychle bez zbytečného čekání
      }
      
      // Loguj souhrn po zpracování
      console.log(`   📊 Processing summary:`);
      console.log(`      - Total swap transactions to process: ${swaps.length}`);
      console.log(`      - Successfully saved: ${newTrades}`);
      console.log(`      - Total skipped: ${skipped}`);
      
      if (newTrades === 0 && swaps.length > 0) {
        console.log(`   ⚠️  WARNING: No trades were saved despite having ${swaps.length} swap transactions!`);
        console.log(`      This might indicate a problem with duplicate detection or normalization.`);
      }

      // Automaticky přepočítej metriky a vytvoř closed lots po přidání nových tradeů
      if (newTrades > 0) {
        try {
          // 1. Vytvoř closed lots (FIFO matching)
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
          
          // 2. Přepočítej metriky
          console.log(`   📊 Recalculating metrics after ${newTrades} new trades...`);
          // Dynamicky importujeme MetricsCalculatorService (aby se vyhnul circular dependency)
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
          // Nechceme, aby selhal celý proces kvůli chybě v metrikách
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
   * Zpracování walletky pomocí standardního RPC (fallback)
   */
  private async processWalletWithRPC(address: string): Promise<{
    processed: number;
    trades: number;
    skipped: number;
  }> {
    try {
      const publicKey = new PublicKey(address);
      // Sníženo na 10 pro snížení rate limitů při jednorázovém zpracování
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
          // Zkontroluj, jestli už není v DB
          const existingTrade = await this.tradeRepo.findBySignature(sigInfo.signature);
          if (existingTrade) {
            duplicateCount++;
            skipped++;
            continue; // Už zpracováno
          }

          // Zpracuj transakci
          const hadTrade = await this.processTransaction(sigInfo.signature, address);
          if (hadTrade) {
            trades++;
          } else {
            nonSwapCount++;
            skipped++; // Není swap
          }
          processed++;

          // Malý bezpečnostní delay mezi transakcemi (většinu throttlingu řeší limiter)
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error: any) {
          console.error(`❌ Error processing transaction ${sigInfo.signature.substring(0, 8)}...:`, error.message);
          skipped++;
        }
      }

      if (processed > 0) {
        console.log(`   Wallet ${address.substring(0, 8)}...: ${trades} trades, ${duplicateCount} duplicates, ${nonSwapCount} non-swaps`);
      }

      // Automaticky přepočítej metriky po přidání nových tradeů
      if (trades > 0) {
        try {
          const wallet = await this.smartWalletRepo.findByAddress(address);
          if (wallet) {
            console.log(`   📊 Recalculating metrics after ${trades} new trades...`);
            // Dynamicky importujeme MetricsCalculatorService (aby se vyhnul circular dependency)
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
          // Nechceme, aby selhal celý proces kvůli chybě v metrikách
        }
      }
      
      return { processed, trades, skipped };
    } catch (error: any) {
      console.error(`❌ Error in processWallet for ${address}:`, error.message);
      throw error;
    }
  }

  /**
   * Zpracování konkrétní transakce (signatura)
   * 
   * Podle zadání: parsování transakce pomocí jednoduché heuristiky
   */
  async processTransaction(signature: string, walletAddress: string): Promise<boolean> {
    try {
      const tx = await this.getTransactionWithRetry(signature);
      if (!tx || !tx.meta) {
        return false; // Neplatná transakce
      }

      // Pokud je chyba, přeskoč
      if (tx.meta.err) {
        return false; // Failed transaction
      }

      // Extrahuj swap data pomocí heuristiky
      const swapData = this.extractSwapData(tx, walletAddress);
      
      if (!swapData) {
        // Debug: log proč to není swap
        const preTokenCount = tx.meta.preTokenBalances?.length || 0;
        const postTokenCount = tx.meta.postTokenBalances?.length || 0;
        const hasPreBalances = (tx.meta.preBalances?.length || 0) > 0;
        const hasPostBalances = (tx.meta.postBalances?.length || 0) > 0;
        
        // Najdi wallet account index pro SOL balance change
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
        
        // Zkontroluj, jestli má innerInstructions s token transfers
        let tokenTransferCount = 0;
        if (hasInnerInstructions && tx.meta.innerInstructions) {
          const innerIxCount = tx.meta.innerInstructions.reduce((sum: number, ix: any) => sum + (ix.instructions?.length || 0), 0);
          // Počítej token transfers
          for (const innerIx of tx.meta.innerInstructions) {
            if (innerIx.instructions) {
              for (const ix of innerIx.instructions) {
                if (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked') {
                  tokenTransferCount++;
                }
              }
            }
          }
          
          // Log jen první 3 transakce pro debugging
          if (Math.random() < 0.03) { // 3% chance
            console.log(`   🔍 TX ${signature.substring(0, 8)}...: no swap detected`);
            console.log(`      - preTokenBalances: ${preTokenCount}, postTokenBalances: ${postTokenCount}`);
            console.log(`      - SOL balance change: ${solBalanceChange} SOL`);
            console.log(`      - innerInstructions: ${hasInnerInstructions}, token transfers: ${tokenTransferCount}`);
          }
        }
        
        return false; // Není swap
      }
      
      console.log(`   ✅ Found swap: ${signature.substring(0, 8)}... - ${swapData.side} ${swapData.amountToken.toFixed(4)} tokens`);

      // Najdi wallet v DB
      const wallet = await this.smartWalletRepo.findByAddress(walletAddress);
      if (!wallet) {
        console.warn(`⚠️  Wallet not found in database: ${walletAddress}`);
        return false;
      }

      // Ověř, jestli token mint_address už existuje v tabulce tokens
          // Získej token info z Helius Token Metadata API
          let tokenSymbol: string | undefined = undefined;
          let tokenName: string | undefined = undefined;
          let tokenDecimals: number | undefined = undefined;
          
          // Speciální případ: Native SOL
          const WSOL_MINT = 'So11111111111111111111111111111111111111112';
          if (swapData.tokenMint === WSOL_MINT) {
            tokenSymbol = 'SOL';
            tokenName = 'Solana';
            tokenDecimals = 9;
          } else if (this.useHelius) {
            // Použij Helius Token Metadata API
            try {
              const tokenInfo = await this.heliusClient.getTokenInfo(swapData.tokenMint);
              if (tokenInfo) {
                tokenSymbol = tokenInfo.symbol;
                tokenName = tokenInfo.name;
                tokenDecimals = tokenInfo.decimals;
              }
            } catch (error: any) {
              // Ignoruj chyby při získávání token info - není kritické
            }
      }

      const token = await this.tokenRepo.findOrCreate({
        mintAddress: swapData.tokenMint,
            symbol: tokenSymbol,
            name: tokenName,
            decimals: tokenDecimals,
          });

      // Zajisti, aby tx_signature + wallet_id + token_id + side kombinace nebyla uložena dvakrát
      // (ochrana proti duplicitám - už kontrolujeme podle signature, ale pro jistotu)
      const existingTrade = await this.tradeRepo.findBySignature(signature);
      if (existingTrade) {
        console.log(`   ℹ️  Trade already exists in DB: ${signature.substring(0, 8)}...`);
        return true; // Už existuje
      }

      // Vytvoř záznam v trades
      const timestamp = tx.blockTime 
        ? new Date(tx.blockTime * 1000)
        : new Date();

      // Výpočet % změny pozice (kolik % tokenů přidal/odebral)
      let positionChangePercent: number | undefined = undefined;
      
      // Najdi všechny předchozí trady pro tento token od této walletky (před aktuálním trade)
      const allTrades = await this.tradeRepo.findAllForMetrics(wallet.id);
      const tokenTrades = allTrades
        .filter(t => t.tokenId === token.id)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()); // Seřaď chronologicky
      
      // Vypočti aktuální pozici před tímto trade
      let currentPosition = 0;
      for (const prevTrade of tokenTrades) {
        if (prevTrade.txSignature === signature) {
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

      console.log(`   💾 Saving trade to DB: ${signature.substring(0, 8)}... (${swapData.side}, ${swapData.amountToken.toFixed(4)} tokens, position change: ${positionChangePercent?.toFixed(2)}%)`);
      
      const createdTrade = await this.tradeRepo.create({
        txSignature: signature,
        walletId: wallet.id,
        tokenId: token.id,
        side: swapData.side,
        amountToken: swapData.amountToken,
        amountBase: swapData.amountBase,
        priceBasePerToken: swapData.priceBasePerToken,
        timestamp,
        dex: 'unknown', // Zatím "unknown" (DEX detekci doděláme později)
        positionChangePercent,
        meta: {
          slot: tx.slot,
          fee: tx.meta.fee,
          baseToken: swapData.baseToken || 'SOL', // Ulož baseToken do meta
        },
      });

      console.log(`   ✅ Trade saved successfully: ${createdTrade.id}`);

      return true; // Trade uložen
    } catch (error: any) {
      // Nechytáme chyby - radši log a continue
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

    // --- 1) Najdi index walletky v accountKeys (kvůli SOL změně) ---
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

    // --- 2) Spočítej změny SPL tokenů pro tuhle walletku ---
    type TokenChange = { mint: string; delta: number };

    const tokenMap = new Map<string, { pre: number; post: number }>();

    // pre
    for (const b of preTokenBalances) {
      const mint = b.mint;
      const owner = b.owner;
      if (owner !== walletAddress) continue; // trackujeme jen tokeny, které fakt patří té walletce

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

    // žádná změna tokenu → nebude to swap tokenu
    if (tokenChanges.length === 0) {
      return null;
    }

    // --- 3) Rozděl tokeny na base (USDC/USDT) a ostatní ---
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

    // Potřebujeme aspoň jeden „non-base“ token – čisté USDC/USDT pohyby nás nezajímají
    if (nonBaseTokenChanges.length === 0) {
      return null;
    }

    // --- 4) Vyber hlavní token (největší absolutní změna mezi non-base tokeny) ---
    nonBaseTokenChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const main = nonBaseTokenChanges[0];
    const tokenMint = main.mint;
    const tokenDelta = main.delta;

    // --- 5) Najdi base změnu: nejprve SOL, pak případně USDC/USDT ---
    const EPS = 1e-6;
    let baseDelta = 0;

    // 5a) Primárně SOL (native)
    if (Math.abs(solDelta) > EPS) {
      baseDelta = solDelta;
    }

    // 5b) Pokud není SOL změna, zkus USDC/USDT změnu pro wallet
    if (Math.abs(baseDelta) <= EPS && baseTokenChanges.length > 0) {
      // Vezmi base token s největší absolutní změnou
      baseTokenChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      baseDelta = baseTokenChanges[0].delta;
    }

    // Pořád žádná rozumná base změna → nechceme to
    if (Math.abs(baseDelta) <= EPS) {
      return null;
    }

    // Token a base by se měly hýbat opačným směrem:
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
              // Pro transfer musíme najít mint z account keys
              // Zatím přeskočíme, protože nemáme mint
              continue;
            }
            
            if (mint && amount > 0) {
              const from = info.source || info.authority;
              const to = info.destination;
              
              tokenTransfers.push({
                mint,
                from,
                to,
                amount: from === walletAddress ? -amount : amount, // Negativní pokud odchází z wallet
              });
            }
          }
        }
      }
    }

    if (tokenTransfers.length === 0) {
    return null;
    }

    // Najdi hlavní token transfer (největší změna)
    tokenTransfers.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    const mainTransfer = tokenTransfers[0];
    
    // Base tokens
    const baseTokens = new Set([
      'So11111111111111111111111111111111111111112', // SOL/WSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ]);

    // Pokud je hlavní transfer base token, použij další
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
          // Zkontroluj, jestli už není v DB
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

          // Malý bezpečnostní delay mezi transakcemi
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
      
      // Zkus použít cache, pokud je ještě platný
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

      // Načti seznam všech tokenů z Jupiter API
      // Zkus různé endpointy
      let response = await fetch('https://token.jup.ag/all', {
        headers: { 'Accept': 'application/json' }
      });
      
      if (!response.ok) {
        // Fallback na jiný endpoint
        response = await fetch('https://api.jup.ag/tokens/v1', {
          headers: { 'Accept': 'application/json' }
        });
      }
      
      if (!response.ok) {
        console.warn(`⚠️  Jupiter Token List API error: ${response.status}`);
        return null;
      }

      let tokens = await response.json();
      
      // Jupiter může vrátit objekt s tokens array nebo přímo array
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

      // Ulož do cache
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

      // Zkontroluj, jestli už máme tento trade v DB
      const existing = await this.tradeRepo.findBySignature(tx.signature);
      if (existing) {
        return { saved: false, reason: 'Trade already exists' };
      }

      // Normalizuj swap
      const swap = this.heliusClient.normalizeSwap(tx, walletAddress);
      if (!swap) {
        return { saved: false, reason: 'Failed to normalize swap' };
      }

      // Získej nebo vytvoř token
      const { TokenMetadataBatchService } = await import('./token-metadata-batch.service.js');
      const tokenMetadataBatchService = new TokenMetadataBatchService(
        this.heliusClient,
        this.tokenRepo
      );

      // Získej token metadata
      const tokenMetadata = await tokenMetadataBatchService.getTokenMetadataBatch([swap.tokenMint]);
      const metadata = tokenMetadata.get(swap.tokenMint) || {};

      const token = await this.tokenRepo.findOrCreate({
        mintAddress: swap.tokenMint,
        symbol: metadata.symbol,
        name: metadata.name,
        decimals: metadata.decimals,
      });

      // Převod hodnoty na USD pomocí ceny tokenu z Birdeye API
      let valueUsd = 0;
      const { TokenPriceService } = await import('./token-price.service.js');
      const tokenPriceService = new TokenPriceService();
      
      const tokenPriceUsd = await tokenPriceService.getTokenPriceAtDate(swap.tokenMint, swap.timestamp);
      if (tokenPriceUsd !== null && tokenPriceUsd > 0) {
        valueUsd = swap.amountToken * tokenPriceUsd;
      } else {
        // Fallback: použij SOL cenu
        valueUsd = await this.solPriceService.solToUsdAtDate(swap.amountBase, swap.timestamp);
      }

      // MIN_NOTIONAL_USD filtr
      if (MIN_NOTIONAL_USD > 0 && valueUsd < MIN_NOTIONAL_USD) {
        return { saved: false, reason: `Value ${valueUsd.toFixed(2)} USD below threshold $${MIN_NOTIONAL_USD}` };
      }

      // Výpočet % změny pozice
      let positionChangePercent: number | undefined = undefined;
      const allTrades = await this.tradeRepo.findAllForMetrics(wallet.id);
      const tokenTrades = allTrades
        .filter(t => t.tokenId === token.id)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      let currentPosition = 0;
      for (const prevTrade of tokenTrades) {
        if (prevTrade.txSignature === swap.txSignature) {
          break;
        }
        if (prevTrade.side === 'buy') {
          currentPosition += Number(prevTrade.amountToken);
        } else if (prevTrade.side === 'sell') {
          currentPosition -= Number(prevTrade.amountToken);
        }
      }

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

      // Výpočet PnL pro uzavřené pozice (sell)
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

      // Ulož trade
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
        valueUsd,
        pnlUsd,
        pnlPercent,
        positionChangePercent,
        meta: {
          source: 'helius-webhook',
          heliusType: tx.type,
          heliusSource: tx.source,
          baseToken: swap.baseToken || 'SOL',
        },
      });

      // Automaticky přepočítej metriky po přidání nového trade
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
