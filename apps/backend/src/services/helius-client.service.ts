/**
 * HeliusClient - Wrapper pro Helius Enhanced API
 * 
 * Helius Enhanced API poskytuje už rozparsované swapy, což je mnohem jednodušší
 * než parsovat raw RPC transakce.
 * 
 * Dokumentace: https://docs.helius.dev/
 */

export type HeliusSwap = {
  signature: string;
  timestamp: number;
  type: 'SWAP';
  source: string; // DEX identifier (JUPITER, RAYDIUM, etc.)
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
    tokenStandard: string;
  }>;
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      userAccount: string;
      tokenAccount: string;
      mint: string;
      rawTokenAmount: {
        tokenAmount: string;
        decimals: number;
      };
      tokenAmount: number;
    }>;
  }>;
  events?: {
    swap?: {
      tokenInputs?: Array<{
        userAccount?: string;
        fromUserAccount?: string;
        mint: string;
        rawTokenAmount: {
          tokenAmount: string;
          decimals: number;
        };
        tokenAmount?: number;
      }>;
      tokenOutputs?: Array<{
        userAccount?: string;
        toUserAccount?: string;
        mint: string;
        rawTokenAmount: {
          tokenAmount: string;
          decimals: number;
        };
        tokenAmount?: number;
      }>;
      nativeInput?: {
        account: string;
        amount: string | number;
      };
      nativeOutput?: {
        account: string;
        amount: string | number;
      };
      innerSwaps?: Array<{
        tokenInputs?: Array<{
          userAccount?: string;
          fromUserAccount?: string;
          mint: string;
          rawTokenAmount: {
            tokenAmount: string;
            decimals: number;
          };
          tokenAmount?: number;
        }>;
        tokenOutputs?: Array<{
          userAccount?: string;
          toUserAccount?: string;
          mint: string;
          rawTokenAmount: {
            tokenAmount: string;
            decimals: number;
          };
          tokenAmount?: number;
        }>;
      }>;
    };
  };
};

export type HeliusTransaction = {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  description?: string; // Helius description (např. "transferred 0.376455 TRUMP")
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    mint: string;
    tokenStandard: string;
  }>;
  accountData?: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      userAccount: string;
      tokenAccount: string;
      mint: string;
      rawTokenAmount: {
        tokenAmount: string;
        decimals: number;
      };
      tokenAmount: number;
    }>;
  }>;
};

/**
 * Custom error pro Helius rate limiting
 */
export class HeliusRateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super(`Helius rate limited - retry after ${retryAfterMs}ms`);
    this.name = 'HeliusRateLimitError';
  }
}

export class HeliusClient {
  private baseUrl: string;
  private apiKey: string;
  private lastRequestTime = 0;
  private readonly MIN_DELAY_BETWEEN_REQUESTS_MS = 300; // Globální rate-limiter: min 300ms mezi requesty

  constructor(apiKey?: string) {
    const rawKey = apiKey || process.env.HELIUS_API_KEY || process.env.HELIUS_API || '';
    
    // Extrahuj API key z URL, pokud je to celá URL
    // Podporuje formáty:
    // - "9cfb2e97-39ce-44ce-86e0-326b608060e8" (jen API key)
    // - "https://mainnet.helius-rpc.com/?api-key=9cfb2e97-39ce-44ce-86e0-326b608060e8" (RPC URL)
    // - "https://api.helius.xyz/v0/...?api-key=..." (Enhanced API URL)
    this.apiKey = this.extractApiKey(rawKey);
    this.baseUrl = `https://api.helius.xyz/v0`;
    
    if (!this.apiKey) {
      console.warn('⚠️  HELIUS_API_KEY not set - Helius features will be disabled');
    } else {
      console.log(`✅ Helius API key configured (length: ${this.apiKey.length})`);
    }
  }

  /**
   * Extrahuje API key z různých formátů
   */
  private extractApiKey(rawKey: string): string {
    if (!rawKey) return '';
    
    // Odstraň uvozovky
    let key = rawKey.trim().replace(/^["']|["']$/g, '');
    
    // Pokud je to URL, extrahuj api-key parametr
    if (key.includes('api-key=')) {
      const match = key.match(/[?&]api-key=([^&]+)/);
      if (match && match[1]) {
        return match[1].split('&')[0].split('#')[0]; // Vezmi jen API key, bez dalších parametrů
      }
    }
    
    // Pokud je to jen API key, vrať ho
    return key;
  }

  /**
   * Zkontroluj, jestli je Helius API dostupné
   */
  isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Batch získání token info z Helius Token Metadata API
   * Vrací mapu mintAddress -> token info
   * Optimalizace: místo jednoho requestu na token, načteme více najednou
   */
  async getTokenInfoBatch(mintAddresses: string[]): Promise<Map<string, {
    symbol?: string;
    name?: string;
    decimals?: number;
  }>> {
    const result = new Map<string, { symbol?: string; name?: string; decimals?: number }>();
    
    if (!this.apiKey || mintAddresses.length === 0) {
      return result;
    }

    // Globální rate-limiter: zajisti min delay mezi requesty
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.MIN_DELAY_BETWEEN_REQUESTS_MS) {
      const delay = this.MIN_DELAY_BETWEEN_REQUESTS_MS - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    try {
      // Helius Token Metadata API podporuje batch requests
      const url = `https://api-mainnet.helius-rpc.com/v0/token-metadata?api-key=${this.apiKey}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mintAccounts: mintAddresses,
          includeOffChain: true, // Podle návodu: includeOffChain: true
        }),
      });

      this.lastRequestTime = Date.now();

      if (!response.ok) {
        // Speciální handling pro 429 rate limit
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '', 10) * 1000 || 15000;
          console.warn(`⚠️  Helius Token Metadata API rate limited (429) - retry after ${retryAfter}ms`);
          throw new HeliusRateLimitError(retryAfter);
        }
        
        console.warn(`⚠️  Helius Token Metadata API batch error: ${response.status}`);
        return result;
      }

      const data = await response.json();
      
      if (!Array.isArray(data)) {
        console.warn(`   ⚠️  Helius API returned non-array response:`, typeof data, data ? Object.keys(data).slice(0, 5) : 'null');
        return result;
      }

      // Debug: log první odpověď pro debugging
      if (data.length > 0 && mintAddresses.length > 0) {
        console.log(`   🔍 Helius API response sample for ${mintAddresses[0].substring(0, 8)}...:`, JSON.stringify(data[0]).substring(0, 500));
      }

      // Zpracuj výsledky podle Helius API struktury
      // Odpověď je pole objektů, kde každý objekt má:
      // - account: mint address (nebo mint, pokud existuje)
      // - onChainAccountInfo.data: { name, symbol, decimals }
      // - legacyMetadata: { symbol, name, decimals }
      data.forEach((meta: any, index: number) => {
        if (!meta) {
          console.warn(`   ⚠️  Empty metadata at index ${index}`);
          return;
        }
        
        // Helius API vrací 'account' místo 'mint' v některých případech
        const mintAddress = meta.mint || meta.account;
        if (!mintAddress) {
          console.warn(`   ⚠️  No mint/account address in metadata at index ${index}:`, JSON.stringify(meta).substring(0, 200));
          return;
        }
        
        // Normalizuj na lowercase pro porovnání
        const normalizedMint = mintAddress.toLowerCase();
        const requestedMints = mintAddresses.map(m => m.toLowerCase());
        
        if (!requestedMints.includes(normalizedMint)) {
          // Možná Helius vrátil token, který jsme nepožadovali (může se stát)
          return;
        }

        const tokenInfo: {
          symbol?: string;
          name?: string;
          decimals?: number;
        } = {};

        // Podle návodu: legacyMetadata.symbol a legacyMetadata.name
        // A také onChainAccountInfo.data: { name, symbol, decimals }
        const legacy = meta.legacyMetadata ?? {};
        const onChainData = meta.onChainAccountInfo?.data ?? {};
        const onChainAccountInfo = meta.onChainAccountInfo?.accountInfo?.data?.parsed?.info ?? {};
        
        // Prioritizuj legacyMetadata (podle návodu), pak onChainAccountInfo.data, pak accountInfo
        tokenInfo.symbol = legacy.symbol || onChainData.symbol || onChainAccountInfo.symbol || undefined;
        tokenInfo.name = legacy.name || onChainData.name || onChainAccountInfo.name || undefined;
        tokenInfo.decimals = legacy.decimals ?? onChainData.decimals ?? onChainAccountInfo.decimals ?? 9;

        // Debug: log pokud nemáme symbol/name
        if (!tokenInfo.symbol && !tokenInfo.name) {
          console.warn(`   ⚠️  No symbol/name for ${mintAddress.substring(0, 8)}... - legacy: ${JSON.stringify(legacy).substring(0, 100)}, onChainData: ${JSON.stringify(onChainData).substring(0, 100)}`);
        }

        // Ulož i když nemáme symbol/name (pro pozdější doplnění)
        // Použij původní case z mintAddresses pro konzistenci
        const originalMint = mintAddresses.find(m => m.toLowerCase() === normalizedMint) || mintAddress;
        result.set(originalMint, tokenInfo);
      });

      return result;
    } catch (error: any) {
      console.warn(`⚠️  Error fetching batch token info:`, error.message);
      return result;
    }
  }

  /**
   * Získání token info z Helius Token Metadata API
   * Vrací symbol, name, decimals pro token
   * Používá Helius Token Metadata endpoint (deprecated, ale funguje)
   * 
   * @deprecated Použij getTokenInfoBatch pro lepší výkon
   */
  async getTokenInfo(mintAddress: string): Promise<{
    symbol?: string;
    name?: string;
    decimals?: number;
  } | null> {
    if (!this.apiKey) {
      return null;
    }

    // Globální rate-limiter: zajisti min delay mezi requesty
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.MIN_DELAY_BETWEEN_REQUESTS_MS) {
      const delay = this.MIN_DELAY_BETWEEN_REQUESTS_MS - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    try {
      // Helius Token Metadata API endpoint
      const url = `https://api-mainnet.helius-rpc.com/v0/token-metadata?api-key=${this.apiKey}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mintAccounts: [mintAddress],
          includeOffChain: true, // Podle návodu: includeOffChain: true
        }),
      });

      this.lastRequestTime = Date.now();

      if (!response.ok) {
        // Speciální handling pro 429 rate limit
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '', 10) * 1000 || 15000;
          console.warn(`⚠️  Helius Token Metadata API rate limited (429) for token ${mintAddress.substring(0, 8)}... - retry after ${retryAfter}ms`);
          throw new HeliusRateLimitError(retryAfter);
        }
        
        console.warn(`⚠️  Helius Token Metadata API error for token ${mintAddress.substring(0, 8)}...: ${response.status}`);
        return null;
      }

      const data = await response.json();
      
      if (!Array.isArray(data) || data.length === 0) {
        return null;
      }

      // Podle návodu: odpověď je pole objektů, kde každý objekt má mint/account a metadata
      // Helius API může vracet 'account' místo 'mint'
      const normalizedMint = mintAddress.toLowerCase();
      const meta = data.find((m: any) => 
        (m.mint && m.mint.toLowerCase() === normalizedMint) || 
        (m.account && m.account.toLowerCase() === normalizedMint)
      ) || data[0];
      if (!meta) {
        return null;
      }

      // Podle návodu: legacyMetadata.symbol a legacyMetadata.name
      const legacy = meta.legacyMetadata ?? {};
      const onChainData = meta.onChainAccountInfo?.data ?? {};

      const result: {
        symbol?: string;
        name?: string;
        decimals?: number;
      } = {};

      // Prioritizuj legacyMetadata (podle návodu)
      result.symbol = legacy.symbol || onChainData.symbol || undefined;
      result.name = legacy.name || onChainData.name || undefined;
      
      // Decimals: legacy > accountInfo > 9 (default)
      result.decimals = legacy.decimals ?? onChainData.decimals ?? 9;

      // Pokud nemáme symbol ani name, vrať null
      if (!result.symbol && !result.name) {
        return null;
      }

      return result;
    } catch (error: any) {
      console.warn(`⚠️  Error fetching token info for ${mintAddress.substring(0, 8)}...:`, error.message);
      return null;
    }
  }

  /**
   * Získání transakcí pro wallet pomocí Helius Enhanced API
   * 
   * Dokumentace: https://docs.helius.dev/compression-and-das-api/digital-asset-standard-das-api/get-assets
   * Enhanced Transactions: https://docs.helius.dev/solana-apis/enhanced-transactions-api
   * 
   * @param address Wallet address
   * @param before Optional: signature před kterou hledat (pro pagination)
   * @param limit Počet transakcí (max 1000)
   * @param type Typ transakce (SWAP, TRANSFER, atd.)
   * @returns Array of parsed transactions
   */
  async getTransactionsForAddress(
    address: string,
    options?: {
      before?: string;
      limit?: number;
      type?: 'SWAP' | 'TRANSFER' | 'NFT_SALE' | 'NFT_MINT' | 'NFT_TRANSFER';
    }
  ): Promise<HeliusTransaction[]> {
    if (!this.apiKey) {
      throw new Error('Helius API key not configured');
    }

    const requestedLimit = options?.limit || 20;
    // DŮLEŽITÉ: NEPOUŽÍVÁME type filtr - může odfiltrovat nové swapy!
    // Filtrujeme swapy až v našem kódu v normalizeSwap
    // const type = options?.type; // Ignorujeme type filtr

    // Helius Enhanced Transactions API endpoint
    // Podle dokumentace: https://docs.helius.dev/solana-apis/enhanced-transactions-api
    // Helius NEPODPORUJE limit jako query parametr - vrací defaultně omezený počet (obvykle 50-100)
    // Pro více transakcí musíme použít pagination s 'before' parametrem
    // Implementujeme pagination loop, dokud nezískáme požadovaný počet transakcí

    const allTransactions: HeliusTransaction[] = [];
    let before: string | undefined = options?.before;
    const maxRequests = Math.ceil(requestedLimit / 50) + 2; // Helius vrací ~50-100 transakcí na request
    let requestCount = 0;

    while (allTransactions.length < requestedLimit && requestCount < maxRequests) {
    // Globální rate-limiter: zajisti min delay mezi requesty
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.MIN_DELAY_BETWEEN_REQUESTS_MS) {
      const delay = this.MIN_DELAY_BETWEEN_REQUESTS_MS - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

      const url = `${this.baseUrl}/addresses/${address}/transactions`;
      const params = new URLSearchParams({
        'api-key': this.apiKey,
      });

      // before parametr pro pagination
      if (before) {
        params.set('before', before);
      }

      const fullUrl = `${url}?${params.toString()}`;

      // DEBUG: Log request details (jen pro první request)
      if (requestCount === 0) {
    console.log(`   🔍 Querying Helius for address: ${address.substring(0, 8)}...`);
    console.log(`   📡 URL: ${this.baseUrl}/addresses/${address.substring(0, 8)}.../transactions`);
        console.log(`   📋 Requesting up to ${requestedLimit} transactions (using pagination)`);
      }

    try {
      const response = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      this.lastRequestTime = Date.now();
        requestCount++;
      
      if (!response.ok) {
        const errorText = await response.text();
        
        // Speciální handling pro 429 rate limit
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '', 10) * 1000 || 15000;
          console.error(`   ⚠️  Helius rate limited (429) - retry after ${retryAfter}ms`);
          throw new HeliusRateLimitError(retryAfter);
        }
        
        console.error(`   ❌ Helius API error: ${response.status} ${response.statusText}`);
        console.error(`   Response: ${errorText}`);
        throw new Error(`Helius API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      
      // Helius vrací buď array nebo objekt s transactions
      let transactions: HeliusTransaction[] = [];
      if (Array.isArray(data)) {
        transactions = data;
      } else if (typeof data === 'object' && data !== null) {
        const dataObj = data as { transactions?: HeliusTransaction[]; result?: HeliusTransaction[] };
        if (dataObj.transactions) {
          transactions = dataObj.transactions;
        } else if (dataObj.result) {
          transactions = dataObj.result;
        }
      }

        if (transactions.length === 0) {
          // Žádné další transakce - ukončíme pagination
          break;
        }

        // Přidej transakce do výsledku
        allTransactions.push(...transactions);

        // Nastav 'before' pro další request (signature poslední transakce)
        before = transactions[transactions.length - 1].signature;

        // Pokud Helius vrátil méně transakcí, než jsme požadovali, pravděpodobně už nemá více
        if (transactions.length < 50) {
          break;
        }

        // Malý delay mezi pagination requesty
        await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error: any) {
        // Pokud je to první request, propaguj chybu
        if (requestCount === 1) {
      console.error(`   ❌ Error fetching transactions from Helius:`, error.message);
      throw error;
    }
        // Pokud je to další request v pagination, loguj varování a vrať co máme
        console.warn(`   ⚠️  Error in pagination request ${requestCount}:`, error.message);
        break;
      }
    }

    // Omezíme na požadovaný limit
    const result = allTransactions.slice(0, requestedLimit);

    // DEBUG: Log response - detailnější
    console.log(`   ✅ Received ${result.length} transactions from Helius API (${requestCount} request${requestCount !== 1 ? 's' : ''})`);
    if (result.length > 0) {
      const newest = result[0];
      const oldest = result[result.length - 1];
      console.log(`   📅 Newest: ${new Date(newest.timestamp * 1000).toISOString()} (${newest.type || 'unknown'}, source: ${newest.source || 'unknown'}) - ${newest.signature.substring(0, 16)}...`);
      console.log(`   📅 Oldest: ${new Date(oldest.timestamp * 1000).toISOString()} (${oldest.type || 'unknown'}, source: ${oldest.source || 'unknown'}) - ${oldest.signature.substring(0, 16)}...`);
    }
    
    return result;
  }

  /**
   * Normalizace Helius swap do našeho Trade formátu
   * 
   * Používá events.swap strukturu, která obsahuje správné informace o swapu,
   * včetně innerSwaps a nativeInput/nativeOutput.
   */
  normalizeSwap(
    heliusTx: HeliusSwap,
    walletAddress: string
  ): {
    txSignature: string;
    tokenMint: string;
    side: 'buy' | 'sell';
    amountToken: number;
    amountBase: number;
    priceBasePerToken: number;
    baseToken: string; // SOL, USDC, USDT
    timestamp: Date;
    dex: string;
  } | null {
    try {
      const BASE_MINTS = new Set([
        // SOL (native / WSOL)
        'So11111111111111111111111111111111111111112',
        // USDC
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        // USDT
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      ]);

      // Mapování mint address → symbol base tokenu
      const BASE_MINT_TO_SYMBOL: Record<string, string> = {
        'So11111111111111111111111111111111111111112': 'SOL', // WSOL
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
      };

      // Funkce pro získání baseToken symbolu z mint address
      const getBaseTokenSymbol = (mint: string | undefined): string => {
        if (!mint) return 'SOL'; // Default
        if (BASE_MINT_TO_SYMBOL[mint]) {
          return BASE_MINT_TO_SYMBOL[mint];
        }
        return 'SOL'; // Default pro native SOL
      };

      const swap = heliusTx.events?.swap;
      if (!swap) {
        // Pokud má source z allowlistu DEXů, je to swap (Helius už to identifikoval)
        // Použijeme legacy metodu pro normalizaci
        const source = heliusTx.source?.toUpperCase();
        if (source) {
          const ALLOWED_SOURCES = ['JUPITER', 'JUPITER_LIMIT', 'RAYDIUM', 'PUMP_FUN', 'PUMP_AMM', 'METEORA', 'OKX', 'ORCA', 'ORCA_V2', 'ORCA_WHIRLPOOL', 'WHIRLPOOL', 'LIFINITY', 'PHOENIX', 'MERCURIAL', 'DRIFT', 'MANGO', 'ALDRIN', 'SABER', 'GOOSEFX', 'MARINADE', 'STEP', 'GMGN', 'BONK_DEX', 'BLOOM', 'DFLOW', 'BACKPACK', 'PHANTOM'];
          if (ALLOWED_SOURCES.includes(source)) {
            console.log(`   ℹ️  No events.swap in TX ${heliusTx.signature.substring(0, 8)}... but source=${source} indicates swap, using legacy method`);
            return this.normalizeSwapLegacy(heliusTx, walletAddress);
          }
        }
        console.log(`   ⚠️  No events.swap in TX ${heliusTx.signature.substring(0, 8)}..., using legacy method`);
        // Fallback na starou metodu, pokud events.swap není k dispozici
        return this.normalizeSwapLegacy(heliusTx, walletAddress);
      }

      // 1) Najdi token input/output pro tuto peněženku
      // Zkombinuj tokenInputs/tokenOutputs z top-levelu i z innerSwaps
      const allTokenInputs = [
        ...(swap.tokenInputs ?? []),
        ...((swap.innerSwaps ?? []).flatMap((s: any) => s.tokenInputs ?? [])),
      ];

      const allTokenOutputs = [
        ...(swap.tokenOutputs ?? []),
        ...((swap.innerSwaps ?? []).flatMap((s: any) => s.tokenOutputs ?? [])),
      ];

      // Najdi token input/output pro tuto walletku
      // innerSwaps mohou mít tokenAmount místo rawTokenAmount
      const tokenIn = allTokenInputs.find(
        (t: any) => {
          const matchesWallet = t.userAccount === walletAddress || t.fromUserAccount === walletAddress;
          const hasAmount = (t.rawTokenAmount && t.rawTokenAmount.tokenAmount) || t.tokenAmount;
          return matchesWallet && hasAmount;
        }
      );

      const tokenOut = allTokenOutputs.find(
        (t: any) => {
          const matchesWallet = t.userAccount === walletAddress || t.toUserAccount === walletAddress;
          const hasAmount = (t.rawTokenAmount && t.rawTokenAmount.tokenAmount) || t.tokenAmount;
          return matchesWallet && hasAmount;
        }
      );

      // Najdi native input/output pro tuto walletku
      // DŮLEŽITÉ: nativeInput/nativeOutput může být pro jinou walletku v multi-sig transakcích
      const nativeIn = swap.nativeInput?.account === walletAddress
        ? Number(swap.nativeInput.amount) / 1e9
        : 0;

      const nativeOut = swap.nativeOutput?.account === walletAddress
        ? Number(swap.nativeOutput.amount) / 1e9
        : 0;

      // Pokud nemáme žádný token input/output pro tuto walletku, swap není pro ni
      if (!tokenIn && !tokenOut && nativeIn === 0 && nativeOut === 0) {
        console.log(`   ⚠️  Swap ${heliusTx.signature.substring(0, 8)}... - no matching transfers for wallet ${walletAddress.substring(0, 8)}...`);
        return null;
      }

      // DŮLEŽITÉ: Pokud má type='SWAP' nebo source z allowlistu, je to swap (Solscan "TOKEN SWAP")
      // Ale i tak musíme filtrovat čisté transfery - swap musí mít změnu mezi tokenem a base tokenem
      const isConfirmedSwap = heliusTx.type === 'SWAP' || 
        (heliusTx.source && ['JUPITER', 'JUPITER_LIMIT', 'RAYDIUM', 'PUMP_FUN', 'PUMP_AMM', 'METEORA', 'OKX', 'ORCA', 'ORCA_V2', 'ORCA_WHIRLPOOL', 'WHIRLPOOL', 'LIFINITY', 'PHOENIX', 'MERCURIAL', 'DRIFT', 'MANGO', 'ALDRIN', 'SABER', 'GOOSEFX', 'MARINADE', 'STEP', 'GMGN', 'BONK_DEX', 'BLOOM', 'DFLOW', 'BACKPACK', 'PHANTOM'].includes(heliusTx.source.toUpperCase()));
      
      // Helper funkce pro zjištění, jestli je mint base token (použijeme ji i před definicí)
      const isBaseToken = (mint: string | undefined): boolean => {
        if (!mint) return false;
        return BASE_MINTS.has(mint);
      };
      
      // DŮLEŽITÉ: Filtrujeme čisté transfery - swap musí mít změnu mezi tokenem a base tokenem (SOL/USDC/USDT)
      // Tato kontrola se aplikuje i na potvrzené swapy, protože Helius může označit i transfer jako SWAP
      
      // 1. Pokud máme jen token input nebo jen token output (ne oba), a žádný native/base transfer, je to transfer
        if ((tokenIn && !tokenOut && nativeIn === 0 && nativeOut === 0) || 
            (!tokenIn && tokenOut && nativeIn === 0 && nativeOut === 0)) {
        // Jen jeden token transfer bez native/base transferu - je to čistý transfer, ne swap
        console.log(`   ⚠️  Transfer (not swap) ${heliusTx.signature.substring(0, 8)}... - only one token transfer, no native/base transfer`);
          return null;
        }
        
      // 2. Pokud máme token input a output, ale jsou to stejné tokeny (a žádný base transfer), je to transfer
        if (tokenIn && tokenOut && tokenIn.mint === tokenOut.mint && nativeIn === 0 && nativeOut === 0) {
        console.log(`   ⚠️  Transfer (not swap) ${heliusTx.signature.substring(0, 8)}... - same token in and out, no base transfer`);
        return null;
      }
      
      // 3. Pokud máme token → token, ale oba jsou ne-base tokeny (a žádný base transfer), je to transfer, ne swap
      // Swap musí mít změnu mezi tokenem a base tokenem (SOL/USDC/USDT)
      if (tokenIn && tokenOut) {
        const inMint = tokenIn.mint;
        const outMint = tokenOut.mint;
        const inIsBase = isBaseToken(inMint);
        const outIsBase = isBaseToken(outMint);
        
        // Pokud jsou oba tokeny ne-base a nemáme žádný native/base transfer, je to token → token transfer
        if (!inIsBase && !outIsBase && nativeIn === 0 && nativeOut === 0) {
          console.log(`   ⚠️  Transfer (not swap) ${heliusTx.signature.substring(0, 8)}... - token → token transfer (both non-base), no base transfer`);
          return null;
        }
      }

      // Debug logging (only for first few swaps to avoid spam)
      const shouldLog = Math.random() < 0.1; // Log 10% of swaps for debugging
      if (shouldLog) {
      console.log(`   🔍 normalizeSwap for ${walletAddress.substring(0, 8)}...:`);
      console.log(`      - tokenIn: ${tokenIn ? `${tokenIn.mint.substring(0, 8)}... (${(tokenIn.userAccount || tokenIn.fromUserAccount || '').substring(0, 8)}...)` : 'none'}`);
      console.log(`      - tokenOut: ${tokenOut ? `${tokenOut.mint.substring(0, 8)}... (${(tokenOut.userAccount || tokenOut.toUserAccount || '').substring(0, 8)}...)` : 'none'}`);
      console.log(`      - nativeIn: ${nativeIn > 0 ? `${nativeIn} SOL` : 'none'}`);
      console.log(`      - nativeOut: ${nativeOut > 0 ? `${nativeOut} SOL` : 'none'}`);
      }

      // 2) Urči, který asset je "token" a který "base"
      const inMint = tokenIn?.mint;
      const outMint = tokenOut?.mint;

      // isBaseToken je už definováno výše

      // DŮLEŽITÉ: Filtrujeme swapy mezi base tokeny (SOL/WSOL/USDC/USDT)
      // Tyto swapy nejsou relevantní pro tracking tokenových pozic
      // Kontrola probíhá na začátku, před jakýmkoliv dalším zpracováním
      if (inMint && outMint) {
        const inIsBase = isBaseToken(inMint);
        const outIsBase = isBaseToken(outMint);
        
        // Pokud jsou oba base tokeny, ignorujeme tento swap
        if (inIsBase && outIsBase) {
          // Loguj jen někdy, aby to nebylo příliš verbose
          if (Math.random() < 0.1) {
            console.log(`   ⚠️  Ignoring base ↔ base swap (${inMint.substring(0, 8)}... ↔ ${outMint.substring(0, 8)}...) - not a token trade`);
          }
          return null;
        }
      }
      
      // Také zkontroluj, jestli máme jen native transfers (SOL) bez token transfers
      // To je také base ↔ base swap (např. SOL → WSOL nebo jen SOL transfer)
      if (!tokenIn && !tokenOut && (nativeIn > 0 || nativeOut > 0)) {
        // Loguj jen někdy, aby to nebylo příliš verbose
        if (Math.random() < 0.1) {
          console.log(`   ⚠️  Ignoring native-only swap (${nativeIn > 0 ? `${nativeIn} SOL in` : ''} ${nativeOut > 0 ? `${nativeOut} SOL out` : ''}) - no token involved`);
        }
        return null;
      }

      // DŮLEŽITÉ: Získej celkovou SOL změnu z accountData jako fallback/verifikaci
      // accountData.nativeBalanceChange je nejspolehlivější zdroj pro celkovou SOL změnu
      let accountDataNativeChange = 0;
      if (heliusTx.accountData) {
        const walletAccountData = heliusTx.accountData.find((acc: any) => acc.account === walletAddress);
        if (walletAccountData && walletAccountData.nativeBalanceChange) {
          // nativeBalanceChange je v lamports, převedeme na SOL
          accountDataNativeChange = Math.abs(walletAccountData.nativeBalanceChange) / 1e9;
        }
      }

      /**
       * Fallback parser: zkusí vytáhnout celkovou base částku (SOL/WSOL/USDC/USDT)
       * z human-friendly description, kterou Helius přidává k transakci.
       *
       * Příklad: "Swapped 4.55 SOL for 123456 $CTO on Trojan"
       * → vrátí 4.55
       *
       * To je užitečné zejména pro agregátory (Trojan apod.), kde
       * accountData.nativeBalanceChange obsahuje pouze netto fees
       * (např. 0.047074 SOL), ale description obsahuje brutto hodnotu swapu.
       */
      const parseBaseAmountFromDescription = (): number => {
        const desc = (heliusTx as any).description;
        if (!desc || typeof desc !== 'string') {
          return 0;
        }

        const BASE_SYMBOLS = new Set(['SOL', 'WSOL', 'USDC', 'USDT']);
        // Najdi dvojice "číslo + symbol" (např. "4.55 SOL", "12345 USDC")
        const regex = /([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z$][A-Za-z0-9$/]*)/g;
        let match: RegExpExecArray | null;
        const candidates: Array<{ amount: number; symbol: string }> = [];

        while ((match = regex.exec(desc)) !== null) {
          const amount = parseFloat(match[1]);
          if (!isFinite(amount) || amount <= 0) continue;

          let symbol = match[2].trim();
          // Odstraň prefix '$' (např. "$CTO" → "CTO")
          symbol = symbol.replace(/^\$/, '');
          // Odstraň případnou čárku na konci
          symbol = symbol.replace(/,$/, '');
          symbol = symbol.toUpperCase();

          if (!BASE_SYMBOLS.has(symbol)) continue;

          // WSOL bereme jako SOL (base měna)
          const normalizedSymbol = symbol === 'WSOL' ? 'SOL' : symbol;
          candidates.push({ amount, symbol: normalizedSymbol });
        }

        if (candidates.length === 0) {
          return 0;
        }

        // Vem kandidáta s největší částkou – to je typicky hlavní swap
        const best = candidates.reduce((a, b) => (b.amount > a.amount ? b : a));
        console.log(
          `   🔍 Parsed base amount from description for ${heliusTx.signature.substring(0, 8)}...: ${best.amount} ${best.symbol}`
        );
        return best.amount;
      };

      // Helper funkce pro získání amount z token transferu
      const getTokenAmount = (transfer: any): number => {
        if (transfer.rawTokenAmount && transfer.rawTokenAmount.tokenAmount) {
          return Number(transfer.rawTokenAmount.tokenAmount) / (10 ** transfer.rawTokenAmount.decimals);
        }
        if (transfer.tokenAmount) {
          return Number(transfer.tokenAmount);
        }
        return 0;
      };

      // Hlavní logika: Trackujeme swapy kde je token ↔ base (SOL/WSOL/USDC/USDT)
      // Token = cokoliv, co NENÍ base
      // Base = SOL, WSOL, USDC, USDT
      // IGNORUJEME: base ↔ base (např. SOL ↔ USDC)
      // 
      // DŮLEŽITÉ: Prioritizujeme SELL tokenu před BUY base tokenu
      // Když někdo prodá token za SOL, který se pak převádí na USDC,
      // chceme detekovat SELL tokenu, ne BUY USDC

      // Scénář 2: Token → Base (SELL) - prodáváš token za base
      // PRIORITA: Toto kontrolujeme PRVNÍ, abychom správně detekovali prodej tokenu
      // Může být:
      // - tokenIn (token) → nativeOutput (SOL)
      // - tokenIn (token) → tokenOut (USDC/USDT/WSOL)
      // - tokenIn (token) → tokenOut (WSOL) v innerSwaps
      if (inMint && !isBaseToken(inMint)) {
        // Input je token (ne base) → SELL
        let amountBase = 0;
        let amountToken = getTokenAmount(tokenIn);
        
        // DŮLEŽITÉ: Pro SELL musíme brát CELKOVOU hodnotu swapu, ne jen transfer část
        // V multi-step swapech může být nativeOutput jen část celkové hodnoty
        // Musíme sečíst všechny base outputs (native + token outputs, které jsou base)
        
        // 1. Sečti všechny native outputs (SOL)
        const allNativeOutputs = [
          swap.nativeOutput,
          ...((swap.innerSwaps ?? []).map((s: any) => s.nativeOutput).filter(Boolean)),
        ];
        const totalNativeOut = allNativeOutputs
          .filter((n: any) => n?.account === walletAddress)
          .reduce((sum: number, n: any) => sum + (Number(n.amount) / 1e9), 0);
        
        // 2. Sečti všechny token outputs, které jsou base tokeny
        const baseTokenOutputs = allTokenOutputs.filter((t: any) => {
          const matchesWallet = t.userAccount === walletAddress || t.toUserAccount === walletAddress;
          const isBase = isBaseToken(t.mint);
          return matchesWallet && isBase;
        });
        const totalBaseTokenOut = baseTokenOutputs.reduce((sum: number, t: any) => {
          return sum + getTokenAmount(t);
        }, 0);
        
        // Celková hodnota = native outputs + base token outputs
        // DŮLEŽITÉ: Použij hodnotu z events.swap (brutto, bez fees) - to odpovídá Solscan
        // accountData.nativeBalanceChange zahrnuje fees (netto), takže ho NEPOUŽÍVÁME pro amountBase
        amountBase = totalNativeOut + totalBaseTokenOut;
        
        // PRIORITA: Zkus vytáhnout hodnotu z description (brutto swap value z Heliusu)
        // To je důležité pro agregátory (Trojan apod.), kde events.swap může obsahovat jen malé fees
        // Description obvykle obsahuje správnou brutto hodnotu swapu
        const descAmount = parseBaseAmountFromDescription();
        if (descAmount > 0) {
          // Pokud description má hodnotu, použij ji pokud je větší než to, co máme z events.swap
          // nebo pokud máme jen velmi malou hodnotu (pravděpodobně fees)
          const MIN_REALISTIC_SWAP = 0.01; // 0.01 SOL - méně než to je pravděpodobně jen fees
          if (descAmount > amountBase || (amountBase > 0 && amountBase < MIN_REALISTIC_SWAP && descAmount >= MIN_REALISTIC_SWAP)) {
            console.log(
              `   ✅ Using description-based base amount (brutto swap value): ${descAmount} SOL (was ${amountBase} SOL from events.swap)`
            );
            amountBase = descAmount;
          } else if (amountBase === 0) {
            // Pokud nemáme žádnou hodnotu z events.swap, použij description
            amountBase = descAmount;
            console.log(
              `   ⚠️  Using description-based base amount (brutto swap value): ${amountBase} SOL (no value from events.swap)`
            );
          }
        }
        
        // Fallback 2: pokud nemáme žádné base outputs z events.swap ani description,
        // použij accountData jako poslední možnost.
        // POZOR: accountData je netto (po fees), takže to nebude přesně odpovídat Solscan.
        if (amountBase === 0 && accountDataNativeChange > 0) {
          amountBase = accountDataNativeChange;
          console.log(`   ⚠️  Using accountData.nativeBalanceChange as fallback (netto, includes fees): ${amountBase} SOL`);
        }
        
        // Fallback 3: pokud stále nemáme žádné base outputs, zkus použít nativeOut nebo tokenOut
        if (amountBase === 0) {
          if (nativeOut > 0) {
            // Token → SOL
            amountBase = nativeOut;
          } else if (outMint && isBaseToken(outMint)) {
            // Token → Base token (USDC/USDT/WSOL)
            amountBase = getTokenAmount(tokenOut);
          }
        }
        
        if (amountBase > 0 && amountToken > 0) {
          // Pro SELL: baseToken je to, co jsme dostali (outMint nebo native SOL)
          let baseToken = 'SOL'; // Default
          if (outMint && isBaseToken(outMint)) {
            baseToken = getBaseTokenSymbol(outMint);
          } else if (totalNativeOut > 0) {
            baseToken = 'SOL';
          } else if (totalBaseTokenOut > 0 && baseTokenOutputs.length > 0) {
            baseToken = getBaseTokenSymbol(baseTokenOutputs[0].mint);
          }
          
          return {
            txSignature: heliusTx.signature,
            tokenMint: inMint,
            side: 'sell',
            amountToken: Math.abs(amountToken),
            amountBase: amountBase,
            priceBasePerToken: amountBase / Math.abs(amountToken),
            baseToken, // SOL, USDC, USDT
            timestamp: new Date(heliusTx.timestamp * 1000),
            dex: heliusTx.source.toLowerCase() || 'unknown',
          };
        }
      }

      // Scénář 1: Base → Token (BUY) - kupuješ token za base
      // Toto kontrolujeme DRUHÉ, aby se SELL tokenu měl prioritu
      // Může být:
      // - nativeInput (SOL) → tokenOut (token)
      // - tokenIn (WSOL/USDC/USDT) → tokenOut (token)
      // - tokenIn (WSOL) → tokenOut (token) v innerSwaps
      if (outMint && !isBaseToken(outMint)) {
        // Output je token (ne base) → BUY
        // DEBUG: Log pro Pump.fun AMM
        if (heliusTx.source === 'PUMP_AMM' || heliusTx.source === 'PUMP_FUN') {
          console.log(`   🔍 [PUMP] BUY candidate: ${heliusTx.signature.substring(0, 8)}...`);
          console.log(`      - outMint: ${outMint.substring(0, 16)}...`);
          console.log(`      - tokenOut: ${tokenOut ? 'exists' : 'null'}`);
          console.log(`      - nativeInput: ${swap.nativeInput ? `${Number(swap.nativeInput.amount) / 1e9} SOL` : 'none'}`);
          console.log(`      - tokenInputs: ${allTokenInputs.length}`);
          console.log(`      - tokenOutputs: ${allTokenOutputs.length}`);
        }
        
        let amountBase = 0;
        let amountToken = getTokenAmount(tokenOut);
        
        // DŮLEŽITÉ: Pro BUY musíme brát CELKOVOU hodnotu swapu, ne jen transfer část
        // V multi-step swapech může být nativeInput jen část celkové hodnoty
        // Musíme sečíst všechny base inputs (native + token inputs, které jsou base)
        
        // 1. Sečti všechny native inputs (SOL)
        const allNativeInputs = [
          swap.nativeInput,
          ...((swap.innerSwaps ?? []).map((s: any) => s.nativeInput).filter(Boolean)),
        ];
        const totalNativeIn = allNativeInputs
          .filter((n: any) => n?.account === walletAddress)
          .reduce((sum: number, n: any) => sum + (Number(n.amount) / 1e9), 0);
        
        // 2. Sečti všechny token inputs, které jsou base tokeny
        const baseTokenInputs = allTokenInputs.filter((t: any) => {
          const matchesWallet = t.userAccount === walletAddress || t.fromUserAccount === walletAddress;
          const isBase = isBaseToken(t.mint);
          return matchesWallet && isBase;
        });
        const totalBaseTokenIn = baseTokenInputs.reduce((sum: number, t: any) => {
          return sum + getTokenAmount(t);
        }, 0);
        
        // Celková hodnota = native inputs + base token inputs
        // DŮLEŽITÉ: Použij hodnotu z events.swap (brutto, bez fees) - to odpovídá Solscan
        // accountData.nativeBalanceChange zahrnuje fees (netto), takže ho NEPOUŽÍVÁME pro amountBase
        amountBase = totalNativeIn + totalBaseTokenIn;
        
        // PRIORITA: Zkus vytáhnout hodnotu z description (brutto swap value z Heliusu)
        // To je důležité pro agregátory (Trojan apod.), kde events.swap může obsahovat jen malé fees
        // Description obvykle obsahuje správnou brutto hodnotu swapu
        const descAmount = parseBaseAmountFromDescription();
        if (descAmount > 0) {
          // Pokud description má hodnotu, použij ji pokud je větší než to, co máme z events.swap
          // nebo pokud máme jen velmi malou hodnotu (pravděpodobně fees)
          const MIN_REALISTIC_SWAP = 0.01; // 0.01 SOL - méně než to je pravděpodobně jen fees
          if (descAmount > amountBase || (amountBase > 0 && amountBase < MIN_REALISTIC_SWAP && descAmount >= MIN_REALISTIC_SWAP)) {
            console.log(
              `   ✅ Using description-based base amount (brutto swap value): ${descAmount} SOL (was ${amountBase} SOL from events.swap)`
            );
            amountBase = descAmount;
          } else if (amountBase === 0) {
            // Pokud nemáme žádnou hodnotu z events.swap, použij description
            amountBase = descAmount;
            console.log(
              `   ⚠️  Using description-based base amount (brutto swap value): ${amountBase} SOL (no value from events.swap)`
            );
          }
        }
        
        // Fallback 2: pokud nemáme žádné base inputs z events.swap ani description,
        // použij accountData jako poslední možnost.
        // POZOR: accountData je netto (po fees), takže to nebude přesně odpovídat Solscan.
        if (amountBase === 0 && accountDataNativeChange > 0) {
          amountBase = Math.abs(accountDataNativeChange); // accountDataNativeChange už je absolutní hodnota
          console.log(`   ⚠️  Using accountData.nativeBalanceChange as fallback (netto, includes fees): ${amountBase} SOL`);
        }
        
        // Fallback 3: pokud stále nemáme žádné base inputs, zkus použít nativeIn nebo tokenIn
        if (amountBase === 0) {
          if (nativeIn > 0) {
            // SOL → Token
            amountBase = nativeIn;
          } else if (inMint && isBaseToken(inMint)) {
            // Base token (WSOL/USDC/USDT) → Token
            amountBase = getTokenAmount(tokenIn);
          }
        }
        
        if (amountBase > 0 && amountToken > 0) {
          // Pro BUY: baseToken je to, co jsme zaplatili (inMint nebo native SOL)
          let baseToken = 'SOL'; // Default
          if (inMint && isBaseToken(inMint)) {
            baseToken = getBaseTokenSymbol(inMint);
          } else if (totalNativeIn > 0) {
            baseToken = 'SOL';
          } else if (totalBaseTokenIn > 0 && baseTokenInputs.length > 0) {
            baseToken = getBaseTokenSymbol(baseTokenInputs[0].mint);
          }
          
          // DEBUG: Log pro Pump.fun AMM
          if (heliusTx.source === 'PUMP_AMM' || heliusTx.source === 'PUMP_FUN') {
            console.log(`   ✅ [PUMP] BUY detected: ${amountToken.toFixed(4)} tokens for ${amountBase.toFixed(4)} ${baseToken}`);
          }
          
          return {
            txSignature: heliusTx.signature,
            tokenMint: outMint,
            side: 'buy',
            amountToken: Math.abs(amountToken),
            amountBase: amountBase,
            priceBasePerToken: amountBase / Math.abs(amountToken),
            baseToken, // SOL, USDC, USDT
            timestamp: new Date(heliusTx.timestamp * 1000),
            dex: heliusTx.source.toLowerCase() || 'unknown',
          };
        } else {
          // DEBUG: Log proč BUY selhalo
          if (heliusTx.source === 'PUMP_AMM' || heliusTx.source === 'PUMP_FUN') {
            console.log(`   ⚠️  [PUMP] BUY failed: amountBase=${amountBase}, amountToken=${amountToken}`);
            console.log(`      - totalNativeIn: ${totalNativeIn}`);
            console.log(`      - totalBaseTokenIn: ${totalBaseTokenIn}`);
            console.log(`      - accountDataNativeChange: ${accountDataNativeChange}`);
          }
        }
      }

      // Scénář d) Token → Token přes base (např. Token → USDC → SOL)
      // Tato část už není potřeba, protože base ↔ base swapy jsme odfiltrovali na začátku
      if (inMint && outMint) {
        const inIsBase = BASE_MINTS.has(inMint);
        const outIsBase = BASE_MINTS.has(outMint);

        // Pokud oba jsou base, přeskočíme (to není token swap)
        // Toto by se nemělo stát, protože jsme to odfiltrovali na začátku, ale pro jistotu
        if (inIsBase && outIsBase) {
          return null;
        }

        // Token → Base (prodáváš token)
        if (!inIsBase && outIsBase) {
          const amountToken = getTokenAmount(tokenIn);
          const amountBase = getTokenAmount(tokenOut);
          
          if (amountToken === 0 || amountBase === 0) {
            return null;
          }

          const baseToken = getBaseTokenSymbol(outMint);

          return {
            txSignature: heliusTx.signature,
            tokenMint: inMint,
            side: 'sell',
            amountToken: Math.abs(amountToken),
            amountBase: Math.abs(amountBase),
            priceBasePerToken: Math.abs(amountBase) / Math.abs(amountToken),
            baseToken, // SOL, USDC, USDT
            timestamp: new Date(heliusTx.timestamp * 1000),
            dex: heliusTx.source.toLowerCase() || 'unknown',
          };
        }

        // Base → Token (kupuješ token)
        if (inIsBase && !outIsBase) {
          const amountBase = getTokenAmount(tokenIn);
          const amountToken = getTokenAmount(tokenOut);
          
          if (amountBase === 0 || amountToken === 0) {
            return null;
          }

          const baseToken = getBaseTokenSymbol(inMint);

          return {
            txSignature: heliusTx.signature,
            tokenMint: outMint,
            side: 'buy',
            amountToken: Math.abs(amountToken),
            amountBase: Math.abs(amountBase),
            priceBasePerToken: Math.abs(amountBase) / Math.abs(amountToken),
            baseToken, // SOL, USDC, USDT
            timestamp: new Date(heliusTx.timestamp * 1000),
            dex: heliusTx.source.toLowerCase() || 'unknown',
          };
        }
      }

      // Pokud jsme se sem dostali, swap není podporovaný formát
      console.warn(`⚠️  Swap ${heliusTx.signature.substring(0, 8)}... - unsupported format (inMint: ${inMint}, outMint: ${outMint}, nativeIn: ${nativeIn}, nativeOut: ${nativeOut})`);
      return null;
    } catch (error: any) {
      console.warn(`⚠️  Error normalizing Helius swap ${heliusTx.signature.substring(0, 8)}...:`, error.message);
      if (error.stack) {
        console.warn(`   Stack:`, error.stack.split('\n').slice(0, 3).join('\n'));
      }
      return null;
    }
  }

  /**
   * Vypočítá netto změnu tokenů pro peněženku
   * 
   * Prioritně používá accountData.tokenBalanceChanges (přesnější), 
   * fallback na tokenTransfers pokud accountData není k dispozici
   * 
   * @param heliusTx Helius transaction
   * @param walletAddress Wallet address
   * @returns Record mapping mint address to net change (positive = received, negative = sent)
   */
  private getNetTokenChangesForWallet(
    heliusTx: HeliusSwap,
    walletAddress: string
  ): Record<string, bigint> {
    const net: Record<string, bigint> = {};

    // PRIORITA 1: Použij accountData.tokenBalanceChanges (nejpřesnější)
    if (heliusTx.accountData) {
      const walletAccountData = heliusTx.accountData.find(
        (acc: any) => acc.account === walletAddress
      );
      
      if (walletAccountData && walletAccountData.tokenBalanceChanges) {
        for (const change of walletAccountData.tokenBalanceChanges) {
          const mint = change.mint;
          const rawAmount = change.rawTokenAmount;
          
          if (rawAmount && rawAmount.tokenAmount) {
            const amountBigInt = BigInt(String(rawAmount.tokenAmount));
            
            if (!net[mint]) {
              net[mint] = 0n;
            }
            
            // accountData.tokenBalanceChanges už obsahuje netto změnu (kladná = přibylo, záporná = ubylo)
            net[mint] += amountBigInt;
          }
        }
        
        // Pokud jsme našli změny v accountData, použijeme je
        if (Object.keys(net).length > 0) {
          return net;
        }
      }
    }

    // PRIORITA 2: Fallback na tokenTransfers (pokud accountData není k dispozici)
    const tokenTransfers = heliusTx.tokenTransfers.filter(
      t => t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress
    );

    for (const t of tokenTransfers) {
      const mint = t.mint;
      
      // Zkus najít rawTokenAmount pro přesnější výpočet
      const rawAmount = (t as any).rawTokenAmount;
      let amountBigInt: bigint;
      if (rawAmount && rawAmount.tokenAmount) {
        // Použij rawTokenAmount (je to přesnější, protože už je v raw formátu)
        amountBigInt = BigInt(String(rawAmount.tokenAmount));
      } else {
        // Fallback: použij tokenAmount * 10^decimals
        const decimals = rawAmount?.decimals ?? 6; // Default 6 decimals
        amountBigInt = BigInt(Math.round(t.tokenAmount * Math.pow(10, decimals)));
      }

      if (!net[mint]) {
        net[mint] = 0n;
      }

      if (t.toUserAccount === walletAddress) {
        net[mint] += amountBigInt; // wallet token dostala
      }
      if (t.fromUserAccount === walletAddress) {
        net[mint] -= amountBigInt; // wallet token poslala
      }
    }

    return net;
  }

  /**
   * Detekuje hlavní obchodovaný token z netto změn
   * 
   * @param netByMint Netto změny tokenů per mint
   * @param quoteMints Set of quote token mints (SOL, USDC, USDT) - ty ignorujeme
   * @returns Hlavní obchodovaný token nebo null
   */
  private detectTradedToken(
    netByMint: Record<string, bigint>,
    quoteMints: Set<string>
  ): { mint: string; direction: 'buy' | 'sell'; amount: bigint; decimals?: number } | null {
    // Odfiltruj quote tokeny a nulové změny
    const candidates = Object.entries(netByMint)
      .filter(([mint, delta]) => delta !== 0n && !quoteMints.has(mint));

    if (candidates.length === 0) {
      return null; // Možná čistě SOL trade, nebo jen přesun
    }

    // Když je víc kandidátů (airdrop + trade v jedné tx),
    // vem ten s největším absolutním delta
    candidates.sort((a, b) => {
      const absA = a[1] < 0n ? -a[1] : a[1];
      const absB = b[1] < 0n ? -b[1] : b[1];
      return Number(absB - absA);
    });

    const [mint, delta] = candidates[0];

    return {
      mint,
      direction: delta > 0n ? 'buy' : 'sell',
      amount: delta > 0n ? delta : -delta,
    };
  }

  /**
   * Legacy metoda pro normalizaci swapu (fallback, pokud events.swap není k dispozici)
   */
  private normalizeSwapLegacy(
    heliusTx: HeliusSwap,
    walletAddress: string
  ): {
    txSignature: string;
    tokenMint: string;
    side: 'buy' | 'sell';
    amountToken: number;
    amountBase: number;
    priceBasePerToken: number;
    baseToken: string; // SOL, USDC, USDT
    timestamp: Date;
    dex: string;
  } | null {
    try {
      const QUOTE_MINTS = new Set([
        // SOL (native / WSOL)
        'So11111111111111111111111111111111111111112',
        // USDC
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        // USDT
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      ]);
      
      const BASE_MINTS = QUOTE_MINTS; // Alias pro kompatibilitu
      
      // Mapování mint address → symbol base tokenu
      const BASE_MINT_TO_SYMBOL: Record<string, string> = {
        'So11111111111111111111111111111111111111112': 'SOL', // WSOL
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
      };

      // Funkce pro získání baseToken symbolu z mint address
      const getBaseTokenSymbol = (mint: string | undefined): string => {
        if (!mint) return 'SOL'; // Default
        if (BASE_MINT_TO_SYMBOL[mint]) {
          return BASE_MINT_TO_SYMBOL[mint];
        }
        return 'SOL'; // Default pro native SOL
      };

      // Najdi token transfers pro tuto walletku
      const walletTokenTransfers = heliusTx.tokenTransfers.filter(
        t => t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress
      );

      // Najdi native transfers (SOL) pro tuto walletku
      const walletNativeTransfers = heliusTx.nativeTransfers.filter(
        t => t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress
      );

      // Pokud nemáme žádné token transfers, není to swap
      if (walletTokenTransfers.length === 0) {
        if (walletNativeTransfers.length > 0) {
          console.log(`   ⚠️  Transfer (not swap) ${heliusTx.signature.substring(0, 8)}... - only native transfer, no token transfer`);
        }
        return null;
      }

      // NOVÁ LOGIKA: Počítej netto změnu tokenů pro peněženku
      const netByMint = this.getNetTokenChangesForWallet(heliusTx, walletAddress);
      
      // DEBUG: Log netto změny
      if (Object.keys(netByMint).length > 0) {
        console.log(`   📊 Netto changes for ${heliusTx.signature.substring(0, 8)}...:`);
        Object.entries(netByMint).forEach(([mint, delta]) => {
          const isQuote = QUOTE_MINTS.has(mint);
          const deltaStr = delta > 0n ? `+${delta}` : `${delta}`;
          console.log(`      - ${mint.substring(0, 16)}...: ${deltaStr} ${isQuote ? '(QUOTE)' : ''}`);
        });
      } else {
        console.log(`   ⚠️  No netto changes detected for ${heliusTx.signature.substring(0, 8)}...`);
      }
      
      // Detekuj hlavní obchodovaný token (ignoruje quote tokeny a nulové změny)
      const traded = this.detectTradedToken(netByMint, QUOTE_MINTS);
      
      if (!traded) {
        // Není žádný obchodovaný token (možná čistě SOL trade, nebo jen přesun)
        console.log(`   ⚠️  No traded token detected ${heliusTx.signature.substring(0, 8)}... - skipping (all tokens are quote or have zero net change)`);
        return null;
      }
      
      console.log(`   ✅ Traded token detected: ${traded.mint.substring(0, 16)}... (${traded.direction}, amount: ${traded.amount})`);

      // Získej decimals pro převod z raw amount na human-readable
      const tradedTransfer = walletTokenTransfers.find(t => t.mint === traded.mint);
      const rawAmount = (tradedTransfer as any)?.rawTokenAmount;
      const decimals = rawAmount?.decimals ?? 6; // Default 6 decimals
      
      // Převod z raw amount (bigint) na human-readable amount
      const amountToken = Number(traded.amount) / Math.pow(10, decimals);
      const tokenMint = traded.mint;
      const side = traded.direction;

      // Spočítej SOL delta z native transfers
      const nativeOutTotal = walletNativeTransfers
        .filter(transfer => transfer.fromUserAccount === walletAddress)
        .reduce((sum, transfer) => sum + transfer.amount / 1e9, 0);

      const nativeInTotal = walletNativeTransfers
        .filter(transfer => transfer.toUserAccount === walletAddress)
        .reduce((sum, transfer) => sum + transfer.amount / 1e9, 0);

      let solDelta = nativeInTotal - nativeOutTotal;

      // accountData.nativeBalanceChange bývá kompletnější než nativeTransfers
      let accountDataNativeChange = 0;
      if (heliusTx.accountData) {
        const walletAccountData = heliusTx.accountData.find(
          (acc: any) => acc.account === walletAddress
        );
        if (walletAccountData && walletAccountData.nativeBalanceChange) {
          accountDataNativeChange = walletAccountData.nativeBalanceChange / 1e9;
        }
      }

      const absSolDelta = Math.abs(solDelta);
      const absAccountData = Math.abs(accountDataNativeChange);

      if (absAccountData > 0) {
        if (absSolDelta === 0) {
          solDelta = accountDataNativeChange;
          console.log(
            `   ⚠️  Using accountData.nativeBalanceChange (${absAccountData} SOL) as base amount (no native transfers captured)`
          );
        } else if (absAccountData > absSolDelta * 1.1) {
          solDelta = accountDataNativeChange;
          console.log(
            `   ⚠️  accountData.nativeBalanceChange (${absAccountData} SOL) significantly larger than native transfers (${absSolDelta} SOL), using accountData`
          );
        }
      }
      
      // Pro BUY: amountBase = kolik SOL jsme poslali (abs(solDelta) nebo nativeOutTotal)
      // Pro SELL: amountBase = kolik SOL jsme dostali (abs(solDelta) nebo nativeInTotal)
      let amountBase = 0;
      
      if (side === 'buy') {
        // BUY: použij nativeOutTotal (kolik SOL jsme poslali) - brutto hodnota bez fees
        // DŮLEŽITÉ: Použij hodnotu z nativeTransfers (brutto), ne accountData (netto s fees)
        amountBase = nativeOutTotal > 0 ? nativeOutTotal : Math.abs(solDelta);
        
        // Fallback: pokud nemáme nativeOutTotal, použij accountData jako poslední možnost
        // Ale POZOR: accountData je netto (po fees), takže to nebude přesně odpovídat Solscan
        if (amountBase === 0 && accountDataNativeChange < 0) {
          amountBase = Math.abs(accountDataNativeChange);
          console.log(`   ⚠️  Using accountData.nativeBalanceChange as fallback (netto, includes fees): ${amountBase} SOL`);
        }
      } else {
        // SELL: použij nativeInTotal (kolik SOL jsme dostali) - brutto hodnota bez fees
        // DŮLEŽITÉ: Použij hodnotu z nativeTransfers (brutto), ne accountData (netto s fees)
        amountBase = nativeInTotal > 0 ? nativeInTotal : Math.abs(solDelta);
        
        // Fallback: pokud nemáme nativeInTotal, použij accountData jako poslední možnost
        // Ale POZOR: accountData je netto (po fees), takže to nebude přesně odpovídat Solscan
        if (amountBase === 0 && accountDataNativeChange > 0) {
          amountBase = accountDataNativeChange;
          console.log(`   ⚠️  Using accountData.nativeBalanceChange as fallback (netto, includes fees): ${amountBase} SOL`);
        }
        
        // POZNÁMKA: NEPŘIDÁVÁME nativeOutTotal zpět, protože to jsou fees
        // Solscan zobrazuje hodnotu swapu bez fees, takže to chceme také
      }

      // Pokud nemáme ani token ani base amount, není to swap
      if (amountToken === 0 || amountBase === 0) {
        // Pokud máme token transfer, ale žádný native transfer, je to transfer
        if (amountToken > 0 && amountBase === 0) {
          console.log(`   ⚠️  Transfer (not swap) ${heliusTx.signature.substring(0, 8)}... - token transfer without base amount`);
        }
        return null;
      }

      const priceBasePerToken = amountBase / amountToken;

      // Detekuj baseToken - v legacy metodě většinou SOL, ale zkontroluj token transfers
      let baseToken = 'SOL'; // Default
      // Zkontroluj, jestli nejsou použity USDC/USDT jako base
      for (const transfer of walletTokenTransfers) {
        if (BASE_MINTS.has(transfer.mint)) {
          baseToken = getBaseTokenSymbol(transfer.mint);
          break; // Použij první nalezený base token
        }
      }

      // DEBUG: Log pro novou logiku s netto změnami
      console.log(`   ✅ [NETTO CHANGE] ${side.toUpperCase()}: ${amountToken.toFixed(4)} tokens (${tokenMint.substring(0, 16)}...), amountBase: ${amountBase.toFixed(6)} ${baseToken}, price: ${priceBasePerToken.toFixed(8)} ${baseToken}/token`);

      return {
        txSignature: heliusTx.signature,
        tokenMint: tokenMint,
        side,
        amountToken,
        amountBase,
        priceBasePerToken,
        baseToken, // SOL, USDC, USDT
        timestamp: new Date(heliusTx.timestamp * 1000),
        dex: heliusTx.source.toLowerCase() || 'unknown',
      };
    } catch (error: any) {
      // Změňme na warn - může to být nekompletní test data nebo skutečná chyba
      // V reálných webhook notifikacích by data měla být kompletní
      console.warn(`⚠️  Error normalizing Helius swap (legacy) ${heliusTx.signature?.substring(0, 16) || 'unknown'}...:`, error.message);
      if (error.stack) {
        console.warn(`   Stack:`, error.stack.split('\n').slice(0, 3).join('\n'));
      }
      return null;
    }
  }
}

