/**
 * Debug script to analyze a specific transaction for liquidity operations
 * Usage: pnpm debug:liquidity-tx <signature>
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';

const QUICKNODE_RPC_URL = process.env.QUICKNODE_RPC_URL;
if (!QUICKNODE_RPC_URL) {
  console.error('❌ QUICKNODE_RPC_URL not set');
  process.exit(1);
}

const connection = new Connection(QUICKNODE_RPC_URL, 'confirmed');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function analyzeTransaction(signature: string, walletAddress?: string) {
  console.log(`\n🔍 Analyzing transaction: ${signature}\n`);
  if (walletAddress) {
    console.log(`   Wallet: ${walletAddress}\n`);
  }

  try {
    // 1. Get transaction from RPC
    console.log('📡 Fetching transaction from RPC...');
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      console.error('❌ Transaction not found');
      return;
    }

    console.log('✅ Transaction found');
    console.log(`   Block time: ${tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : 'N/A'}`);
    console.log(`   Slot: ${tx.slot}`);

    // 2. Analyze transaction structure
    const meta = tx.meta;
    const message = tx.transaction?.message;

    if (!meta || !message) {
      console.error('❌ Missing transaction meta or message');
      return;
    }

    // Get account keys - try multiple sources
    let accountKeys: string[] = [];
    if (message.accountKeys && Array.isArray(message.accountKeys)) {
      accountKeys = message.accountKeys.map((k: any) =>
        typeof k === 'string' ? k : k?.pubkey
      ).filter(Boolean);
    }
    // Fallback: try staticAccountKeys (for versioned transactions)
    if (accountKeys.length === 0 && (message as any).staticAccountKeys && Array.isArray((message as any).staticAccountKeys)) {
      accountKeys = (message as any).staticAccountKeys.map((k: any) =>
        typeof k === 'string' ? k : k?.pubkey
      ).filter(Boolean);
    }
    // Fallback: try to get from transaction directly
    if (accountKeys.length === 0 && tx.transaction?.message?.accountKeys) {
      accountKeys = (tx.transaction.message.accountKeys || []).map((k: any) =>
        typeof k === 'string' ? k : k?.pubkey
      ).filter(Boolean);
    }

    console.log(`\n📋 Account Keys (${accountKeys.length}):`);
    accountKeys.slice(0, 10).forEach((key: string, idx: number) => {
      console.log(`   [${idx}] ${key.substring(0, 16)}...${key.substring(key.length - 8)}`);
    });
    if (accountKeys.length > 10) {
      console.log(`   ... and ${accountKeys.length - 10} more`);
    }

    // Check for known liquidity programs
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

    const liquidityPrograms = accountKeys.filter((key: string) => LIQUIDITY_PROGRAM_IDS.has(key));
    console.log(`\n🏊 Liquidity Programs (${liquidityPrograms.length}):`);
    if (liquidityPrograms.length > 0) {
      liquidityPrograms.forEach((key: string) => {
        console.log(`   ✅ ${key}`);
      });
    } else {
      console.log('   ❌ No known liquidity programs found');
    }

    // 3. Analyze token balances
    console.log(`\n💰 Token Balance Changes:`);
    const preTokenBalances = meta.preTokenBalances || [];
    const postTokenBalances = meta.postTokenBalances || [];

    const tokenChanges = new Map<string, { mint: string; owner: string; pre: number; post: number; delta: number }>();

    // Process pre balances
    preTokenBalances.forEach((tb: any) => {
      const key = `${tb.accountIndex}_${tb.mint}`;
      const amount = parseFloat(tb.uiTokenAmount?.uiAmountString || '0');
      tokenChanges.set(key, {
        mint: tb.mint,
        owner: tb.owner || '',
        pre: amount,
        post: 0,
        delta: 0,
      });
    });

    // Process post balances
    postTokenBalances.forEach((tb: any) => {
      const key = `${tb.accountIndex}_${tb.mint}`;
      const existing = tokenChanges.get(key);
      if (existing) {
        existing.post = parseFloat(tb.uiTokenAmount?.uiAmountString || '0');
        existing.delta = existing.post - existing.pre;
      } else {
        tokenChanges.set(key, {
          mint: tb.mint,
          owner: tb.owner || '',
          pre: 0,
          post: parseFloat(tb.uiTokenAmount?.uiAmountString || '0'),
          delta: parseFloat(tb.uiTokenAmount?.uiAmountString || '0'),
        });
      }
    });

    // Group by mint and owner
    const changesByMint = new Map<string, { owner: string; delta: number }[]>();
    tokenChanges.forEach((change, key) => {
      if (change.delta !== 0) {
        if (!changesByMint.has(change.mint)) {
          changesByMint.set(change.mint, []);
        }
        changesByMint.get(change.mint)!.push({
          owner: change.owner,
          delta: change.delta,
        });
      }
    });

    // If wallet address provided, filter changes for that wallet
    let walletTokenChanges = new Map<string, number>();
    if (walletAddress) {
      const walletLower = walletAddress.toLowerCase();
      tokenChanges.forEach((change) => {
        if (change.owner.toLowerCase() === walletLower && Math.abs(change.delta) > 1e-12) {
          walletTokenChanges.set(change.mint, (walletTokenChanges.get(change.mint) || 0) + change.delta);
        }
      });
    }

    console.log(`   Total token changes: ${changesByMint.size} unique mints`);
    changesByMint.forEach((changes, mint) => {
      const totalDelta = changes.reduce((sum, c) => sum + c.delta, 0);
      console.log(`   ${mint.substring(0, 16)}...: ${totalDelta > 0 ? '+' : ''}${totalDelta.toFixed(6)}`);
      changes.forEach(c => {
        if (Math.abs(c.delta) > 0.000001) {
          console.log(`      Owner ${c.owner.substring(0, 8)}...: ${c.delta > 0 ? '+' : ''}${c.delta.toFixed(6)}`);
        }
      });
    });

    // 4. Check for liquidity operation pattern
    const BASE_MINTS = new Set([
      'So11111111111111111111111111111111111111112', // WSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ]);

    // Use wallet-specific changes if wallet address provided
    const tokenChangesToAnalyze = walletAddress && walletTokenChanges.size > 0
      ? Array.from(walletTokenChanges.entries())
      : Array.from(changesByMint.entries())
          .map(([mint, changes]) => [mint, changes.reduce((sum, c) => sum + c.delta, 0)] as [string, number])
          .filter(([, delta]) => Math.abs(delta) > 0.000001);

    const nonBaseTokenChanges = tokenChangesToAnalyze
      .filter(([mint]) => !BASE_MINTS.has(mint))
      .filter(([, delta]) => Math.abs(delta) > 0.000001);

    console.log(`\n🔍 Non-base token changes${walletAddress ? ` for wallet ${walletAddress.substring(0, 8)}...` : ''} (${nonBaseTokenChanges.length}):`);
    if (nonBaseTokenChanges.length > 0) {
      nonBaseTokenChanges.forEach(([mint, delta]) => {
        console.log(`   ${mint.substring(0, 16)}...: ${delta > 0 ? '+' : ''}${delta.toFixed(6)}`);
      });
    } else {
      console.log('   None');
    }

    // Also show base token changes for context
    const baseTokenChanges = tokenChangesToAnalyze
      .filter(([mint]) => BASE_MINTS.has(mint))
      .filter(([, delta]) => Math.abs(delta) > 0.000001);
    
    if (baseTokenChanges.length > 0) {
      console.log(`\n💰 Base token changes${walletAddress ? ` for wallet ${walletAddress.substring(0, 8)}...` : ''} (${baseTokenChanges.length}):`);
      baseTokenChanges.forEach(([mint, delta]) => {
        const symbol = mint === 'So11111111111111111111111111111111111111112' ? 'WSOL' :
                      mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 'USDC' : 'USDT';
        console.log(`   ${symbol} (${mint.substring(0, 16)}...): ${delta > 0 ? '+' : ''}${delta.toFixed(6)}`);
      });
    }

    // Check if it's a liquidity operation
    // Liquidity operations can involve:
    // 1. 2+ non-base tokens changing in same direction (classic LP pair)
    // 2. 1 non-base token + 1 base token changing in same direction (LP pair with stablecoin)
    // 3. 2+ tokens total (including base) changing in same direction
    
    const allTokenChanges = [...nonBaseTokenChanges, ...baseTokenChanges];
    
    console.log(`\n🏊 Liquidity Operation Detection:`);
    console.log(`   Non-base tokens: ${nonBaseTokenChanges.length}`);
    console.log(`   Base tokens: ${baseTokenChanges.length}`);
    console.log(`   Total tokens: ${allTokenChanges.length}`);
    
    if (allTokenChanges.length >= 2) {
      const allPositive = allTokenChanges.every(([, delta]) => delta > 0);
      const allNegative = allTokenChanges.every(([, delta]) => delta < 0);

      console.log(`   All positive: ${allPositive}`);
      console.log(`   All negative: ${allNegative}`);

      if (allPositive || allNegative) {
        const liquidityType = allPositive ? 'ADD' : 'REMOVE';
        console.log(`   ✅ DETECTED: ${liquidityType} LIQUIDITY (${allTokenChanges.length} tokens)`);
      } else {
        console.log(`   ❌ NOT a liquidity operation (mixed signs)`);
      }
    } else if (nonBaseTokenChanges.length >= 2) {
      // Check only non-base tokens (original logic)
      const allPositive = nonBaseTokenChanges.every(([, delta]) => delta > 0);
      const allNegative = nonBaseTokenChanges.every(([, delta]) => delta < 0);

      if (allPositive || allNegative) {
        const liquidityType = allPositive ? 'ADD' : 'REMOVE';
        console.log(`   ✅ DETECTED: ${liquidityType} LIQUIDITY (non-base tokens only)`);
      } else {
        console.log(`   ❌ NOT a liquidity operation (mixed signs)`);
      }
    } else {
      console.log(`   ❌ NOT a liquidity operation (< 2 tokens)`);
    }

    // 5. Check instruction logs
    console.log(`\n📝 Instruction Logs:`);
    const logs = meta.logMessages || [];
    const liquidityLogs = logs.filter((log: string) => 
      log.toLowerCase().includes('liquidity') ||
      log.toLowerCase().includes('add') ||
      log.toLowerCase().includes('remove') ||
      log.toLowerCase().includes('pool')
    );
    
    if (liquidityLogs.length > 0) {
      liquidityLogs.forEach((log: string) => {
        console.log(`   ${log.substring(0, 100)}...`);
      });
    } else {
      console.log('   No liquidity-related logs found');
    }

    // Helius API removed - using QuickNode only

    // 7. Check if it's in our database
    console.log(`\n💾 Checking database...`);
    const { data: trades } = await supabase
      .from('Trade')
      .select('*')
      .eq('signature', signature)
      .limit(1);

    if (trades && trades.length > 0) {
      const trade = trades[0];
      console.log(`   ✅ Found in database:`);
      console.log(`      Side: ${trade.side}`);
      console.log(`      Base Token: ${trade.baseToken || 'N/A'}`);
      console.log(`      Amount Base: ${trade.amountBase || 0}`);
      console.log(`      Amount Token: ${trade.amountToken || 0}`);
      console.log(`      Liquidity Type: ${(trade as any).liquidityType || 'N/A'}`);
    } else {
      console.log(`   ❌ Not found in database`);
    }

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    console.error(error.stack);
  }
}

// Main
const signature = process.argv[2];
const walletAddress = process.argv[3]; // Optional wallet address
if (!signature) {
  console.error('Usage: pnpm debug:liquidity-tx <signature> [walletAddress]');
  process.exit(1);
}

analyzeTransaction(signature, walletAddress).then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
