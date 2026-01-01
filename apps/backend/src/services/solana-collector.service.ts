import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { NormalizedTradeRepository } from '../repositories/normalized-trade.repository.js';
// HeliusClient removed - using QuickNode only
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
  side: 'buy' | 'sell' | 'void';
  amountToken: number;
  amountBase: number; // V USD (přepočteno z SOL/USDC/USDT nebo sekundárního tokenu), 0 pro void trades
  priceBasePerToken: number; // V USD za 1 token, 0 pro void trades
  baseToken: string; // SOL, USDC, USDT, nebo 'VOID' pro token-to-token swapy
  timestamp: Date;
  dex: string;
  liquidityType?: 'ADD' | 'REMOVE'; // ADD nebo REMOVE pro liquidity operations
};

// Minimum trade value in USD to consider valid (filter out dust/fees)
// Trades under this value are likely just transaction fees, not real trades
const MIN_TRADE_VALUE_USD = 1.0; // $1 USD minimum

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
    const sig = tx.transaction?.signatures?.[0]?.substring(0, 16) || 'unknown';

    // Map account index -> pubkey
    // Get account keys - try multiple sources (CRITICAL for versioned transactions)
    let accountKeys: string[] = [];

    // Source 1: Standard accountKeys (legacy transactions)
    if (message.accountKeys && Array.isArray(message.accountKeys)) {
      accountKeys = message.accountKeys.map((k: any) =>
        typeof k === 'string' ? k : k?.pubkey
      ).filter(Boolean);
    }

    // Source 2: staticAccountKeys (versioned transactions V0)
    if (accountKeys.length === 0 && message.staticAccountKeys && Array.isArray(message.staticAccountKeys)) {
      accountKeys = message.staticAccountKeys.map((k: any) =>
        typeof k === 'string' ? k : k?.pubkey
      ).filter(Boolean);
    }

    // Source 3: Try loadedAddresses (some RPC responses include resolved ATL addresses)
    if (meta.loadedAddresses) {
      const writable = meta.loadedAddresses.writable || [];
      const readonly = meta.loadedAddresses.readonly || [];
      const loadedKeys = [...writable, ...readonly].map((k: any) =>
        typeof k === 'string' ? k : k?.pubkey
      ).filter(Boolean);
      if (loadedKeys.length > 0) {
        accountKeys = [...accountKeys, ...loadedKeys];
      }
    }

    // Source 4: Fallback - try to get from transaction directly
    if (accountKeys.length === 0 && tx.transaction?.message?.accountKeys) {
      accountKeys = (tx.transaction.message.accountKeys || []).map((k: any) =>
        typeof k === 'string' ? k : k?.pubkey
      ).filter(Boolean);
    }

    // VERSIONED TRANSACTION DETECTION: Check for addressTableLookups
    // If we have addressTableLookups but no loadedAddresses, the webhook didn't resolve them
    // In this case, we can still process based on token balance changes (owner field is always present)
    const hasUnresolvedATL = message.addressTableLookups &&
                             Array.isArray(message.addressTableLookups) &&
                             message.addressTableLookups.length > 0 &&
                             (!meta.loadedAddresses ||
                              (meta.loadedAddresses.writable?.length === 0 && meta.loadedAddresses.readonly?.length === 0));

    // Flag for whether we can map SOL balances to wallet
    let canMapSolBalances = accountKeys.length >= (meta.preBalances?.length || 0) ||
                            accountKeys.some(k => k.toLowerCase() === walletLower);

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
    let walletAccountIndices: number[] = [];
    let solNetFromAccountKeys = false;

    if (accountKeys.length > 0) {
      // Standard path: map accountKeys to balances
      for (let i = 0; i < accountKeys.length; i++) {
        const pk = accountKeys[i];
        if (!pk || pk.toLowerCase() !== walletLower) continue;
        walletAccountIndices.push(i);
        solNetFromAccountKeys = true;
        const preLamports = preBalances[i] ?? 0;
        const postLamports = postBalances[i] ?? preLamports;
        const deltaLamports = postLamports - preLamports;
        if (deltaLamports !== 0) {
          const deltaSol = deltaLamports / 1e9;
          solNet += deltaSol;
        }
      }
    }

    // VERSIONED TX FALLBACK: If we have token changes but couldn't find wallet in accountKeys,
    // try to infer SOL change from balance analysis
    // This is crucial for versioned transactions with unresolved address table lookups
    if (!solNetFromAccountKeys && tokenNetByMint.size > 0 && preBalances.length > 0) {
      // For versioned transactions, we can't directly map balances to wallet
      // But we can use heuristics: find the largest SOL change that makes sense for the trade
      // Typically, the fee payer (index 0) is the wallet, and SOL changes there are relevant

      // Heuristic 1: Check first account (usually fee payer = wallet)
      if (preBalances.length > 0 && postBalances.length > 0) {
        const delta0 = (postBalances[0] - preBalances[0]) / 1e9;
        // Only use if it's a significant change (> 0.001 SOL, not just fees)
        if (Math.abs(delta0) > 0.001) {
          solNet = delta0;
          console.log(`   ⚠️  [QuickNode] Versioned tx ${sig}...: Using account[0] SOL change as fallback: ${solNet.toFixed(6)} SOL`);
        }
      }

      // Heuristic 2: If account[0] didn't have significant change, look for largest change
      // that correlates with token movement direction
      if (Math.abs(solNet) < 0.001) {
        // Determine expected direction from token changes
        const primaryTokenDelta = Array.from(tokenNetByMint.entries())
          .filter(([mint]) => !BASE_MINTS.has(mint))
          .reduce((max, [, d]) => Math.abs(d) > Math.abs(max) ? d : max, 0);

        if (primaryTokenDelta !== 0) {
          // If token increased (BUY), expect SOL to decrease
          const expectedDirection = primaryTokenDelta > 0 ? -1 : 1;

          let bestChange = 0;
          for (let i = 0; i < Math.min(preBalances.length, postBalances.length); i++) {
            const delta = (postBalances[i] - preBalances[i]) / 1e9;
            // Only consider changes > 0.01 SOL and in expected direction
            if (Math.sign(delta) === expectedDirection && Math.abs(delta) > 0.01 && Math.abs(delta) > Math.abs(bestChange)) {
              bestChange = delta;
            }
          }

          if (Math.abs(bestChange) > 0.01) {
            solNet = bestChange;
            console.log(`   ⚠️  [QuickNode] Versioned tx ${sig}...: Inferred SOL change from balance analysis: ${solNet.toFixed(6)} SOL`);
          }
        }
      }
    }

    // Debug: log token net changes (only if there are changes)
    if (tokenNetByMint.size > 0 || Math.abs(solNet) > 0.001) {
      const tokenChanges = Array.from(tokenNetByMint.entries()).map(([mint, delta]) => {
        const isBase = BASE_MINTS.has(mint);
        const symbol = isBase ? (mint === 'So11111111111111111111111111111111111111112' ? 'WSOL' : 
                                 mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 'USDC' : 'USDT') : 'TOKEN';
        return `${symbol}(${mint.substring(0, 8)}...): ${delta.toFixed(6)}`;
      }).join(', ');
      console.log(`   [QuickNode] Token net changes for wallet ${walletAddress.substring(0, 8)}...: ${tokenChanges || 'none'}`);
      console.log(`   [QuickNode] SOL net change: ${solNet.toFixed(6)}`);
    }

    // DETECT LIQUIDITY OPERATIONS: ADD/REMOVE LIQUIDITY
    // Liquidity operations typically involve:
    // - Multiple tokens changing simultaneously (both sides of LP pair)
    // - Both tokens going in same direction (both increasing for ADD, both decreasing for REMOVE)
    // - Or one token increasing and one decreasing (which is a swap, not liquidity)
    // NOTE: LP pairs can be:
    //   1. Token/Token (both non-base) - e.g., BONK/SOL
    //   2. Token/Base (one non-base, one base) - e.g., BONK/USDC
    //   3. Base/Base (both base) - e.g., USDC/USDT (rare)
    const nonBaseTokenChanges = Array.from(tokenNetByMint.entries())
      .filter(([mint]) => !BASE_MINTS.has(mint))
      .filter(([, delta]) => Math.abs(delta) > 1e-9);
    
    const baseTokenChanges = Array.from(tokenNetByMint.entries())
      .filter(([mint]) => BASE_MINTS.has(mint))
      .filter(([, delta]) => Math.abs(delta) > 1e-9);
    
    // All token changes (for liquidity detection, we consider both base and non-base)
    const allTokenChanges = Array.from(tokenNetByMint.entries())
      .filter(([, delta]) => Math.abs(delta) > 1e-9);
    
    // If we have 2+ tokens changing in the same direction, it's likely a liquidity operation
    // ADD LIQUIDITY: both tokens increase (user adds both to pool)
    // REMOVE LIQUIDITY: both tokens decrease (user removes both from pool)
    let isLiquidityOperation = false;
    let liquidityType: 'ADD' | 'REMOVE' | null = null;
    
    // Strategy 1: Check if we have 2+ non-base tokens (classic LP pair)
    if (nonBaseTokenChanges.length >= 2) {
      const allPositive = nonBaseTokenChanges.every(([, delta]) => delta > 0);
      const allNegative = nonBaseTokenChanges.every(([, delta]) => delta < 0);
      
      if (allPositive || allNegative) {
        isLiquidityOperation = true;
        liquidityType = allPositive ? 'ADD' : 'REMOVE';
        console.log(`   🟣 [QuickNode] Detected ${liquidityType} LIQUIDITY operation (non-base tokens) - creating void trade (wallet ${walletAddress.substring(0, 8)}...)`);
        console.log(`      Token changes: ${nonBaseTokenChanges.map(([m, d]) => `${m.substring(0, 8)}...: ${d.toFixed(6)}`).join(', ')}`);
      }
    }
    
    // Strategy 2: Check if we have 1 non-base + 1 base token (token/stablecoin LP pair)
    // This is common for token/USDC or token/USDT pairs
    if (!isLiquidityOperation && nonBaseTokenChanges.length >= 1 && baseTokenChanges.length >= 1 && allTokenChanges.length >= 2) {
      const allPositive = allTokenChanges.every(([, delta]) => delta > 0);
      const allNegative = allTokenChanges.every(([, delta]) => delta < 0);
      
      if (allPositive || allNegative) {
        isLiquidityOperation = true;
        liquidityType = allPositive ? 'ADD' : 'REMOVE';
        console.log(`   🟣 [QuickNode] Detected ${liquidityType} LIQUIDITY operation (token/base pair) - creating void trade (wallet ${walletAddress.substring(0, 8)}...)`);
        console.log(`      Token changes: ${allTokenChanges.map(([m, d]) => `${m.substring(0, 8)}...: ${d.toFixed(6)}`).join(', ')}`);
      }
    }
    
    // Strategy 3: Check for known liquidity pool program IDs (strong signal)
    const LIQUIDITY_PROGRAM_IDS = new Set([
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
      '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca Whirlpool
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool (legacy)
      'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', // Orca
      '9KEPoZmtHUrBbhWN1v1KWLMkkwY6WtG6c3qP9EcX4bL1', // Orca V2
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter (swap aggregator, not liquidity)
      'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter v4
      'JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph', // Jupiter v3
    ]);
    const involvesLiquidityProgram = accountKeys.some(key => LIQUIDITY_PROGRAM_IDS.has(key));
    
    // If we have a liquidity program AND 2+ tokens changing in same direction, it's almost certainly liquidity
    if (involvesLiquidityProgram && allTokenChanges.length >= 2) {
      const allPositive = allTokenChanges.every(([, delta]) => delta > 0);
      const allNegative = allTokenChanges.every(([, delta]) => delta < 0);
      if (allPositive || allNegative) {
        isLiquidityOperation = true;
        liquidityType = allPositive ? 'ADD' : 'REMOVE';
        console.log(`   🟣 [QuickNode] Confirmed ${liquidityType} LIQUIDITY via liquidity program (wallet ${walletAddress.substring(0, 8)}...)`);
        console.log(`      Token changes: ${allTokenChanges.map(([m, d]) => `${m.substring(0, 8)}...: ${d.toFixed(6)}`).join(', ')}`);
      }
    }

    // 3) Compute base side (SOL / USDC / USDT / WSOL) net amounts FIRST
    // (needed for checking significant base changes below)
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

    // IMPORTANT: WSOL can be wrapped/unwrapped, so if we see native SOL change
    // but no WSOL in token balances, treat native SOL change as WSOL change
    // This handles swaps where WSOL is used but not explicitly in token balances
    // NOTE: If we set wsolNet = solNet, then solTotalNet = solNet + wsolNet = 2*solNet (WRONG!)
    // Instead, we should just use solNet directly as the base amount
    let solTotalNet = solNet + wsolNet;
    
    if (Math.abs(wsolNet) < 1e-9 && Math.abs(solNet) > 0.001 && tokenNetByMint.size > 0) {
      // There's a native SOL change and token changes, but no WSOL in token balances
      // This is likely a WSOL swap where WSOL was wrapped/unwrapped
      // Use native SOL change directly (don't double-count by adding to wsolNet)
      solTotalNet = solNet; // Use native SOL as total (WSOL is just wrapped SOL)
      console.log(`   ⚠️  [QuickNode] No WSOL in token balances, but native SOL change detected (${solNet.toFixed(6)}). Using as base amount.`);
    }
    
    // Debug: log WSOL changes if present
    if (Math.abs(wsolNet) > 1e-9) {
      console.log(`   [QuickNode] WSOL net change: ${wsolNet.toFixed(6)}, SOL total net: ${solTotalNet.toFixed(6)}`);
    }

    // 4) Pick main traded (non-base) token by absolute net change
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

    // IMPROVED: Also check if there's significant SOL/USDC/USDT movement even without clear token change
    // This can happen in edge cases where token balance changes are not properly detected
    const significantBaseChange = Math.abs(solTotalNet) > 0.001 || Math.abs(usdcNet) > 0.001 || Math.abs(usdtNet) > 0.001;
    const hasTokenChanges = tokenNetByMint.size > 0;
    
    if (!primaryMint || Math.abs(primaryDelta) < 1e-9) {
      // No clear non-base token movement for this wallet
      // But if there's significant base change, it might still be a trade we should log
      if (significantBaseChange && hasTokenChanges) {
        // Try to find ANY token change, even if small
        for (const [mint, delta] of tokenNetByMint.entries()) {
          if (BASE_MINTS.has(mint)) continue;
          if (Math.abs(delta) > 1e-12) { // Very small threshold
            primaryMint = mint;
            primaryDelta = delta;
            console.log(`   ⚠️  [QuickNode] Using small token change as primary: ${mint.substring(0, 8)}... delta=${delta.toFixed(9)}`);
            break;
          }
        }
      }
      
      if (!primaryMint || Math.abs(primaryDelta) < 1e-12) {
        // Still no primary token - log for debugging but don't save
        console.log(`   ⚠️  [QuickNode] No primary token found for wallet ${walletAddress.substring(0, 8)}...`);
        console.log(`      Token net changes: ${tokenNetByMint.size > 0 ? Array.from(tokenNetByMint.entries()).map(([m, d]) => `${m.substring(0, 8)}...: ${d.toFixed(6)}`).join(', ') : 'none'}`);
        console.log(`      SOL net change: ${solTotalNet.toFixed(6)}, USDC: ${usdcNet.toFixed(6)}, USDT: ${usdtNet.toFixed(6)}`);
        console.log(`      Signature: ${tx.transaction?.signatures?.[0]?.substring(0, 16) || 'none'}...`);
        return null;
      }
    }

    // Pokud je to liquidity operation, označ jako void
    let side: 'buy' | 'sell' | 'void' = isLiquidityOperation ? 'void' : (primaryDelta > 0 ? 'buy' : 'sell');
    const amountToken = Math.abs(primaryDelta);

    // DŮLEŽITÉ: VŽDY použij SOL/USDC/USDT hodnotu z balance changes
    // NIKDY nepoužívej sekundární token jako base - to vede k špatným hodnotám!
    // Pro token-to-token swapy musíme najít ekvivalentní SOL hodnotu
    let baseAmount = 0;
    let baseToken = 'SOL';
    
    // Pro liquidity operations nastav baseAmount = 0 (void trade)
    if (isLiquidityOperation) {
      baseAmount = 0;
      baseToken = 'VOID';
    } else if (side === 'buy') {
      // BUY: user spent base => negative net
      const solSpent = solTotalNet < 0 ? -solTotalNet : 0;
      const usdcSpent = usdcNet < 0 ? -usdcNet : 0;
      const usdtSpent = usdtNet < 0 ? -usdtNet : 0;
      baseAmount = Math.max(solSpent, usdcSpent, usdtSpent);
      
      // IMPROVED: Check for very small base changes that might be missed due to rounding
      // For fast trades, even small SOL changes (0.0001-0.001) should be considered valid
      const MIN_BASE_CHANGE = 0.0001; // Lower threshold for fast trades
      
      if (baseAmount <= 0) {
        // Try to find ANY base change, even very small ones
        const allBaseChanges = [
          { token: 'SOL', amount: solTotalNet, spent: solTotalNet < 0 ? -solTotalNet : 0 },
          { token: 'USDC', amount: usdcNet, spent: usdcNet < 0 ? -usdcNet : 0 },
          { token: 'USDT', amount: usdtNet, spent: usdtNet < 0 ? -usdtNet : 0 },
        ];
        
        // Find the largest base change, even if very small
        const largestBaseChange = allBaseChanges.reduce((max, curr) => 
          curr.spent > max.spent ? curr : max
        , allBaseChanges[0]);
        
        if (largestBaseChange.spent >= MIN_BASE_CHANGE) {
          // Found a small but valid base change - use it
          baseAmount = largestBaseChange.spent;
          baseToken = largestBaseChange.token;
          console.log(`   ⚠️  [QuickNode] Using small base change: ${baseAmount.toFixed(6)} ${baseToken} (wallet ${walletAddress.substring(0, 8)}...)`);
        } else {
          // Token-to-token swap bez SOL/USDC/USDT změny → označit jako VOID
          console.log(`   🟣 [QuickNode] Token-to-token swap detected (no SOL/USDC/USDT change) - marking as VOID (wallet ${walletAddress.substring(0, 8)}...)`);
          console.log(`      Primary token: ${primaryMint?.substring(0, 16)}..., delta: ${primaryDelta.toFixed(6)}`);
          console.log(`      SOL net: ${solNet.toFixed(6)}, USDC net: ${usdcNet.toFixed(6)}, USDT net: ${usdtNet.toFixed(6)}`);
          console.log(`      Token net changes: ${tokenNetByMint.size > 0 ? Array.from(tokenNetByMint.entries()).map(([m, d]) => `${m.substring(0, 8)}...: ${d.toFixed(6)}`).join(', ') : 'none'}`);
          
          // Vrať trade s side='void' - bude zobrazen, ale nepočítá se do PnL
          side = 'void';
          baseAmount = 0; // Žádná hodnota
          baseToken = 'VOID';
        }
      }
      
      // Urči base token podle největší změny
      if (baseAmount === usdcSpent) baseToken = 'USDC';
      else if (baseAmount === usdtSpent) baseToken = 'USDT';
      else baseToken = 'SOL';
    } else {
      // SELL: user received base => positive net
      const solReceived = solTotalNet > 0 ? solTotalNet : 0;
      const usdcReceived = usdcNet > 0 ? usdcNet : 0;
      const usdtReceived = usdtNet > 0 ? usdtNet : 0;
      baseAmount = Math.max(solReceived, usdcReceived, usdtReceived);
      
      // IMPROVED: Check for very small base changes that might be missed due to rounding
      // For fast trades, even small SOL changes (0.0001-0.001) should be considered valid
      const MIN_BASE_CHANGE = 0.0001; // Lower threshold for fast trades
      
      if (baseAmount <= 0) {
        // Try to find ANY base change, even very small ones
        const allBaseChanges = [
          { token: 'SOL', amount: solTotalNet, received: solTotalNet > 0 ? solTotalNet : 0 },
          { token: 'USDC', amount: usdcNet, received: usdcNet > 0 ? usdcNet : 0 },
          { token: 'USDT', amount: usdtNet, received: usdtNet > 0 ? usdtNet : 0 },
        ];
        
        // Find the largest base change, even if very small
        const largestBaseChange = allBaseChanges.reduce((max, curr) => 
          curr.received > max.received ? curr : max
        , allBaseChanges[0]);
        
        if (largestBaseChange.received >= MIN_BASE_CHANGE) {
          // Found a small but valid base change - use it
          baseAmount = largestBaseChange.received;
          baseToken = largestBaseChange.token;
          console.log(`   ⚠️  [QuickNode] Using small base change: ${baseAmount.toFixed(6)} ${baseToken} (wallet ${walletAddress.substring(0, 8)}...)`);
        } else {
          // Token-to-token swap bez SOL/USDC/USDT změny → označit jako VOID
          console.log(`   🟣 [QuickNode] Token-to-token swap detected (no SOL/USDC/USDT change) - marking as VOID (wallet ${walletAddress.substring(0, 8)}...)`);
          console.log(`      Primary token: ${primaryMint?.substring(0, 16)}..., delta: ${primaryDelta.toFixed(6)}`);
          console.log(`      SOL net: ${solNet.toFixed(6)}, USDC net: ${usdcNet.toFixed(6)}, USDT net: ${usdtNet.toFixed(6)}`);
          console.log(`      Token net changes: ${tokenNetByMint.size > 0 ? Array.from(tokenNetByMint.entries()).map(([m, d]) => `${m.substring(0, 8)}...: ${d.toFixed(6)}`).join(', ') : 'none'}`);
          
          // Vrať trade s side='void' - bude zobrazen, ale nepočítá se do PnL
          side = 'void';
          baseAmount = 0; // Žádná hodnota
          baseToken = 'VOID';
        }
      }
      
      // Urči base token podle největší změny
      if (baseAmount === usdcReceived) baseToken = 'USDC';
      else if (baseAmount === usdtReceived) baseToken = 'USDT';
      else baseToken = 'SOL';
    }

    // Pro void trades (token-to-token swapy) povolíme baseAmount = 0
    if (side === 'void') {
      // Void trade - nemá hodnotu, ale má amountToken
      if (amountToken <= 0) {
        console.log(`   ⚠️  [QuickNode] Invalid amountToken for VOID trade (wallet ${walletAddress.substring(0, 8)}...)`);
        return null;
      }
    } else {
      // Normální trade - musí mít baseAmount > 0
      if (baseAmount <= 0 || amountToken <= 0) {
        console.log(`   ⚠️  [QuickNode] Invalid baseAmount or amountToken for wallet ${walletAddress.substring(0, 8)}...`);
        console.log(`      Primary token: ${primaryMint?.substring(0, 16)}..., delta: ${primaryDelta.toFixed(6)}`);
        console.log(`      Base amount: ${baseAmount.toFixed(6)}, Base token: ${baseToken}`);
        console.log(`      SOL net: ${solNet.toFixed(6)}, USDC net: ${usdcNet.toFixed(6)}, USDT net: ${usdtNet.toFixed(6)}`);
        return null;
      }
    }

    const priceBasePerToken = side === 'void' ? 0 : baseAmount / amountToken;

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
    
    // LIQUIDITY PROGRAMS - tyto programy se typicky používají pro ADD/REMOVE LIQUIDITY
    // Pokud vidíme tyto programy + detekovali jsme liquidity pattern, je to téměř jistě ADD/REMOVE
    const LIQUIDITY_PROGRAMS = new Set([
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
      '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca Whirlpool
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool (legacy)
      'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', // Orca
      '9KEPoZmtHUrBbhWN1v1KWLMkkwY6WtG6c3qP9EcX4bL1', // Orca V2
    ]);
    
    // Zkontroluj, jestli transakce obsahuje liquidity programy
    const hasLiquidityProgram = Array.from(keySet).some(key => LIQUIDITY_PROGRAMS.has(key));
    
    // Pokud máme liquidity program + detekovali jsme liquidity pattern (2+ tokeny stejným směrem),
    // je to téměř jistě ADD/REMOVE LIQUIDITY - už jsme to filtrovali výše, ale můžeme to ještě potvrdit
    if (hasLiquidityProgram && nonBaseTokenChanges.length >= 2) {
      const allPositive = nonBaseTokenChanges.every(([, delta]) => delta > 0);
      const allNegative = nonBaseTokenChanges.every(([, delta]) => delta < 0);
      if (allPositive || allNegative) {
        // Už jsme to filtrovali výše, ale můžeme přidat další log
        console.log(`   ⚠️  [QuickNode] Confirmed ${allPositive ? 'ADD' : 'REMOVE'} LIQUIDITY via liquidity program (wallet ${walletAddress.substring(0, 8)}...)`);
      }
    }
    
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
      liquidityType: isLiquidityOperation && liquidityType ? liquidityType : undefined,
    };
  } catch (err: any) {
    console.warn('⚠️  [QuickNode] Error normalizing transaction:', err?.message || err);
    console.warn(`   Wallet: ${walletAddress.substring(0, 8)}...`);
    console.warn(`   Signature: ${tx.transaction?.signatures?.[0]?.substring(0, 16) || 'unknown'}...`);
    if (err?.stack) {
      console.warn(`   Stack: ${err.stack.split('\n').slice(0, 3).join('\n')}`);
    }
    return null;
  }
}

/**
 * Normalize a Helius Enhanced transaction into our internal NormalizedSwap format.
 *
 * Helius Enhanced webhook payload structure:
 * {
 *   type: "SWAP",
 *   signature: "...",
 *   timestamp: 1234567890,
 *   feePayer: "...",
 *   tokenTransfers: [{ fromUserAccount, toUserAccount, tokenAmount, mint, ... }],
 *   nativeTransfers: [{ fromUserAccount, toUserAccount, amount (in lamports), ... }],
 *   accountData: [{ account, nativeBalanceChange (lamports), tokenBalanceChanges: [...] }],
 *   source: "JUPITER" | "RAYDIUM" | ...,
 *   ...
 * }
 */
export function normalizeHeliusSwap(
  tx: any,
  walletAddress: string
): NormalizedSwap | null {
  try {
    if (tx.type !== 'SWAP') {
      return null;
    }

    const walletLower = walletAddress.toLowerCase();
    const sig = tx.signature?.substring(0, 16) || 'unknown';

    // Base tokens
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const BASE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

    // 1) Collect token balance changes for wallet from accountData
    // This is the most reliable source for Helius Enhanced
    let tokenChanges: Map<string, number> = new Map(); // mint -> delta (positive = received, negative = sent)
    let solChange = 0; // SOL/lamports change (in SOL, not lamports)

    if (Array.isArray(tx.accountData)) {
      for (const acc of tx.accountData) {
        const accAddr = typeof acc.account === 'string' ? acc.account : '';
        if (accAddr.toLowerCase() !== walletLower) continue;

        // Native SOL change (convert from lamports to SOL)
        if (typeof acc.nativeBalanceChange === 'number') {
          solChange = acc.nativeBalanceChange / 1e9;
        }

        // Token balance changes
        if (Array.isArray(acc.tokenBalanceChanges)) {
          for (const tbc of acc.tokenBalanceChanges) {
            const mint = tbc.mint as string | undefined;
            if (!mint) continue;

            // Parse token amount change
            let delta = 0;
            if (tbc.rawTokenAmount) {
              const decimals = tbc.rawTokenAmount.decimals || 0;
              const amount = parseFloat(tbc.rawTokenAmount.tokenAmount || '0');
              delta = amount / Math.pow(10, decimals);
            }

            if (delta !== 0) {
              tokenChanges.set(mint, (tokenChanges.get(mint) || 0) + delta);
            }
          }
        }
      }
    }

    // 2) Fallback: Use tokenTransfers if accountData didn't have balance changes
    if (tokenChanges.size === 0 && Array.isArray(tx.tokenTransfers)) {
      for (const transfer of tx.tokenTransfers) {
        const mint = transfer.mint as string | undefined;
        if (!mint) continue;

        const fromAddr = (transfer.fromUserAccount || '').toLowerCase();
        const toAddr = (transfer.toUserAccount || '').toLowerCase();
        const amount = parseFloat(transfer.tokenAmount || '0');

        if (fromAddr === walletLower) {
          tokenChanges.set(mint, (tokenChanges.get(mint) || 0) - amount);
        }
        if (toAddr === walletLower) {
          tokenChanges.set(mint, (tokenChanges.get(mint) || 0) + amount);
        }
      }
    }

    // 3) Fallback: Use nativeTransfers for SOL if accountData didn't have it
    if (solChange === 0 && Array.isArray(tx.nativeTransfers)) {
      for (const transfer of tx.nativeTransfers) {
        const fromAddr = (transfer.fromUserAccount || '').toLowerCase();
        const toAddr = (transfer.toUserAccount || '').toLowerCase();
        const amount = (transfer.amount || 0) / 1e9; // Convert lamports to SOL

        if (fromAddr === walletLower) {
          solChange -= amount;
        }
        if (toAddr === walletLower) {
          solChange += amount;
        }
      }
    }

    // Add WSOL as a pseudo-token for SOL changes (for unified processing)
    if (Math.abs(solChange) > 0.0001) {
      const existingWsol = tokenChanges.get(WSOL_MINT) || 0;
      tokenChanges.set(WSOL_MINT, existingWsol + solChange);
    }

    // 4) Separate base tokens from other tokens
    const baseChanges: Array<{ mint: string; symbol: string; delta: number }> = [];
    const otherTokenChanges: Array<{ mint: string; delta: number }> = [];

    for (const [mint, delta] of tokenChanges) {
      if (mint === WSOL_MINT) {
        baseChanges.push({ mint, symbol: 'SOL', delta });
      } else if (mint === USDC_MINT) {
        baseChanges.push({ mint, symbol: 'USDC', delta });
      } else if (mint === USDT_MINT) {
        baseChanges.push({ mint, symbol: 'USDT', delta });
      } else {
        otherTokenChanges.push({ mint, delta });
      }
    }

    // 5) Determine the primary token (non-base token with largest absolute change)
    if (otherTokenChanges.length === 0) {
      // No non-base tokens changed - this might be a SOL<->USDC swap, skip for now
      console.log(`   ⚠️  [Helius] No non-base tokens in swap for wallet ${walletAddress.substring(0, 8)}... sig: ${sig}`);
      return null;
    }

    // Sort by absolute delta to find primary token
    otherTokenChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const primaryToken = otherTokenChanges[0];

    // 6) Determine side: BUY if we received the primary token, SELL if we sent it
    const side: 'buy' | 'sell' | 'void' = primaryToken.delta > 0 ? 'buy' : 'sell';
    const amountToken = Math.abs(primaryToken.delta);

    // 7) Determine base amount from base token changes
    // For BUY: we spent base (negative change)
    // For SELL: we received base (positive change)
    let baseAmount = 0;
    let baseToken = 'SOL';

    // Sort base changes by absolute value
    baseChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    if (side === 'buy') {
      // Look for negative base change (we spent base to buy tokens)
      const spentBase = baseChanges.find(b => b.delta < 0);
      if (spentBase) {
        baseAmount = Math.abs(spentBase.delta);
        baseToken = spentBase.symbol;
      }
    } else {
      // Look for positive base change (we received base for selling tokens)
      const receivedBase = baseChanges.find(b => b.delta > 0);
      if (receivedBase) {
        baseAmount = receivedBase.delta;
        baseToken = receivedBase.symbol;
      }
    }

    // If no base amount found, mark as void (token-to-token swap)
    if (baseAmount <= 0) {
      console.log(`   🟣 [Helius] Token-to-token swap detected - marking as VOID (wallet ${walletAddress.substring(0, 8)}...)`);
      return {
        txSignature: tx.signature,
        tokenMint: primaryToken.mint,
        side: 'void',
        amountToken,
        amountBase: 0,
        priceBasePerToken: 0,
        baseToken: 'VOID',
        timestamp: new Date((tx.timestamp || 0) * 1000),
        dex: tx.source?.toLowerCase() || 'unknown',
      };
    }

    // 8) Calculate price
    const priceBasePerToken = baseAmount / amountToken;

    // 9) Timestamp
    const timestamp = tx.timestamp
      ? new Date(tx.timestamp * 1000)
      : new Date();

    // 10) DEX detection from source
    const dex = tx.source?.toLowerCase() || 'unknown';

    console.log(`   📊 [Helius] Parsed swap: ${side.toUpperCase()} ${amountToken.toFixed(4)} tokens for ${baseAmount.toFixed(6)} ${baseToken} (wallet ${walletAddress.substring(0, 8)}...)`);

    return {
      txSignature: tx.signature,
      tokenMint: primaryToken.mint,
      side,
      amountToken,
      amountBase: baseAmount,
      priceBasePerToken,
      baseToken,
      timestamp,
      dex,
    };
  } catch (err: any) {
    console.warn('⚠️  [Helius] Error normalizing transaction:', err?.message || err);
    console.warn(`   Wallet: ${walletAddress.substring(0, 8)}...`);
    console.warn(`   Signature: ${tx.signature?.substring(0, 16) || 'unknown'}...`);
    return null;
  }
}

/**
 * Service for processing Solana transactions from webhooks
 * This service normalizes transactions and saves them as trades
 */
export class SolanaCollectorService {
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
    this.tokenMetadataBatchService = new TokenMetadataBatchService(this.tokenRepo);
    this.tokenPriceService = new TokenPriceService();
    this.solPriceService = new SolPriceService();
    this.binancePriceService = new BinancePriceService();
  }

  /**
   * @deprecated This method is no longer used. Use processQuickNodeTransaction instead.
   */
  async processWebhookTransaction(
    tx: any,
    walletAddress: string
  ): Promise<{ saved: boolean; reason?: string }> {
    console.warn('⚠️  processWebhookTransaction is deprecated and should not be used');
    return { saved: false, reason: 'deprecated - Helius no longer used' };
    /* Legacy code removed - Helius no longer used
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
      if (!token || !token.symbol || !token.name) {
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

      if (!token) {
        console.error(`❌ Token not found/created for ${normalized.tokenMint}`);
        return { saved: false, reason: 'token_not_found' };
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
          source: 'quicknode-webhook',
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
    */
  }

  /**
   * Process a single Helius Enhanced webhook transaction.
   * Uses the Enhanced format (tokenTransfers, nativeTransfers, accountData).
   */
  async processHeliusTransaction(
    tx: any,
    walletAddress: string
  ): Promise<{ saved: boolean; reason?: string; normalizedTradeId?: string }> {
    try {
      const normalized = normalizeHeliusSwap(tx, walletAddress);
      if (!normalized) {
        return { saved: false, reason: 'not a swap' };
      }

      const amountBaseRaw = normalized.amountBase;

      // Find wallet in DB
      const wallet = await this.smartWalletRepo.findByAddress(walletAddress);
      if (!wallet) {
        return { saved: false, reason: 'wallet not found' };
      }

      // Build debug meta
      const heliusDebugMeta: any = {
        source: 'helius',
        wallet: walletAddress,
        signature: tx.signature ?? null,
        type: tx.type ?? null,
        heliusSource: tx.source ?? null,
      };

      // Find or create token
      let token = await this.tokenRepo.findOrCreate({
        mintAddress: normalized.tokenMint,
      });

      // Fetch token metadata if missing
      if (!token || !token.symbol || !token.name) {
        try {
          console.log(
            `   🔍 [Helius] Token ${normalized.tokenMint.substring(0, 8)}... missing metadata, fetching...`
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
                `   ✅ [Helius] Token metadata fetched: ${token.symbol || 'N/A'} / ${token.name || 'N/A'}`
              );
            }
          }
        } catch (e: any) {
          console.warn(`   ⚠️  [Helius] Failed to fetch token metadata:`, e.message);
        }
      }

      if (!token) {
        return { saved: false, reason: 'token not found' };
      }

      // Check for duplicate via signature
      const existingTrade = await this.tradeRepo.findBySignature(normalized.txSignature);
      if (existingTrade) {
        return { saved: false, reason: 'duplicate signature (already saved)' };
      }

      // Check for duplicate in NormalizedTrade table
      const existingNormalized = await this.normalizedTradeRepo.findBySignatureAndWallet(
        normalized.txSignature,
        wallet.id,
        normalized.side
      );
      if (existingNormalized) {
        return { saved: false, reason: 'duplicate signature (in normalized_trades)' };
      }

      // Calculate balance before/after (not available in Helius Enhanced format directly)
      const balanceBefore: number | null = null;
      const balanceAfter: number | null = null;

      // DISABLED: Trade data storage disabled - web UI no longer used
      // const normalizedTrade = await this.normalizedTradeRepo.create({...});

      console.log(
        `   ⏭️ [Helius] Trade storage DISABLED: ${normalized.side} ${normalized.amountToken.toFixed(6)} tokens, ${amountBaseRaw.toFixed(6)} ${normalized.baseToken}`
      );

      return { saved: false, reason: 'storage_disabled' };
    } catch (error: any) {
      console.error(`❌ [Helius] Error processing transaction:`, error);
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
      if (!token || !token.symbol || !token.name) {
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

      // 5. Calculate estimated USD value for minimum trade filter
      // amountBase is in SOL/USDC/USDT - need to convert to USD
      let estimatedValueUsd = normalized.amountBase;
      if (normalized.baseToken === 'SOL' && normalized.side !== 'void') {
        try {
          const solPrice = await this.solPriceService.getSolPriceUsd();
          estimatedValueUsd = normalized.amountBase * solPrice;
        } catch {
          // Fallback: assume ~$150 SOL
          estimatedValueUsd = normalized.amountBase * 150;
        }
      }
      // USDC/USDT are already in USD, no conversion needed

      // Filter out tiny trades (likely just fees, not real trades)
      // Only filter non-void trades - void trades (liquidity) should always be stored for tracking
      if (normalized.side !== 'void' && estimatedValueUsd < MIN_TRADE_VALUE_USD) {
        console.log(
          `   ⏭️  [QuickNode] Skipping tiny trade: ${normalized.txSignature.substring(0, 16)}... ` +
          `(${normalized.amountBase.toFixed(4)} ${normalized.baseToken} ≈ $${estimatedValueUsd.toFixed(2)} < $${MIN_TRADE_VALUE_USD} min)`
        );
        return { saved: false, reason: `value < $${MIN_TRADE_VALUE_USD} USD (likely fee)` };
      }

      const existing = await this.tradeRepo.findBySignature(normalized.txSignature);
      if (existing) {
        return { saved: false, reason: 'duplicate' };
      }

      // Ensure token exists after metadata fetch
      if (!token) {
        console.error(`❌ Token not found/created for ${normalized.tokenMint}`);
        return { saved: false, reason: 'token_not_found' };
      }

      // DISABLED: Trade data storage disabled - web UI no longer used
      // const normalizedRecord = await this.normalizedTradeRepo.create({...});

      console.log(
        `   ⏭️ [QuickNode] Trade storage DISABLED: ${normalized.side} ${normalized.amountToken} tokens, ${normalized.amountBase} ${normalized.baseToken}`
      );

      return { saved: false, reason: 'storage_disabled' };
    } catch (error: any) {
      console.error(`❌ Error processing QuickNode webhook transaction:`, error);
      return { saved: false, reason: error.message || 'unknown error' };
    }
  }
}

