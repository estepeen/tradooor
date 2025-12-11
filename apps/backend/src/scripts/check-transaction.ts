import 'dotenv/config';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { SolanaCollectorService } from '../services/solana-collector.service.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { WalletProcessingQueueRepository } from '../repositories/wallet-processing-queue.repository.js';
import { NormalizedTradeRepository } from '../repositories/normalized-trade.repository.js';
import { Connection, PublicKey } from '@solana/web3.js';

const smartWalletRepo = new SmartWalletRepository();
const tradeRepo = new TradeRepository();
const tokenRepo = new TokenRepository();
const walletQueueRepo = new WalletProcessingQueueRepository();
const normalizedTradeRepo = new NormalizedTradeRepository();
const collectorService = new SolanaCollectorService(
  smartWalletRepo,
  tradeRepo,
  tokenRepo,
  walletQueueRepo,
  normalizedTradeRepo
);

async function checkTransaction(signature: string, walletAddress: string) {
  console.log(`\n🔍 Checking transaction: ${signature}\n`);
  console.log(`   Wallet: ${walletAddress}\n`);

  // 1. Check if transaction exists in database
  const { data: existingTrade, error: tradeError } = await supabase
    .from(TABLES.TRADE)
    .select(`
      *,
      token:${TABLES.TOKEN}(*)
    `)
    .eq('txSignature', signature)
    .limit(1)
    .single();

  if (!tradeError && existingTrade) {
    console.log(`✅ Trade exists in database:`);
    console.log(`   Token: ${(existingTrade.token as any)?.symbol || 'UNKNOWN'}`);
    console.log(`   Side: ${existingTrade.side}`);
    console.log(`   Value: $${Number(existingTrade.valueUsd || 0).toFixed(2)}`);
    console.log(`   Timestamp: ${new Date(existingTrade.timestamp).toLocaleString()}`);
    console.log(`\n   ⚠️  Trade already exists. To reprocess, delete it first or use --force flag`);
    console.log(`   Continuing to fetch and analyze transaction anyway...\n`);
    // Don't return - continue to fetch and analyze
  }

  // 2. Check normalized trades
  const { data: normalizedTrade, error: normError } = await supabase
    .from('NormalizedTrade')
    .select('*')
    .eq('txSignature', signature)
    .limit(1)
    .single();

  if (!normError && normalizedTrade) {
    console.log(`📦 Found in NormalizedTrade:`);
    console.log(`   Status: ${normalizedTrade.status}`);
    console.log(`   Token mint: ${normalizedTrade.tokenMint}`);
    console.log(`   Side: ${normalizedTrade.side}`);
    console.log(`   Amount base: ${normalizedTrade.amountBase}`);
    if (normalizedTrade.error) {
      console.log(`   Error: ${normalizedTrade.error}`);
    }
  }

  // 3. Fetch transaction from RPC
  const rpcUrl = process.env.SOLANA_RPC_URL || process.env.QUICKNODE_RPC_URL;
  if (!rpcUrl) {
    console.error('❌ No RPC URL configured');
    return;
  }

  console.log(`\n📡 Fetching transaction from RPC...`);
  const connection = new Connection(rpcUrl, 'confirmed');
  
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx) {
      console.error(`❌ Transaction not found on-chain`);
      return;
    }

    console.log(`✅ Transaction found on-chain`);
    console.log(`   Block time: ${tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : 'N/A'}`);
    console.log(`   Slot: ${tx.slot}`);
    
    // Debug: show token balances
    if (tx.meta) {
      const preTokens = tx.meta.preTokenBalances || [];
      const postTokens = tx.meta.postTokenBalances || [];
      console.log(`\n   Token balances:`);
      console.log(`   Pre: ${preTokens.length} accounts`);
      console.log(`   Post: ${postTokens.length} accounts`);
      
      // Find WSOL
      const wsolMint = 'So11111111111111111111111111111111111111112';
      const preWSOL = preTokens.filter((t: any) => t.mint === wsolMint);
      const postWSOL = postTokens.filter((t: any) => t.mint === wsolMint);
      if (preWSOL.length > 0 || postWSOL.length > 0) {
        console.log(`   WSOL pre: ${preWSOL.length} accounts`);
        console.log(`   WSOL post: ${postWSOL.length} accounts`);
        for (const w of preWSOL) {
          console.log(`     Pre WSOL: owner=${w.owner?.substring(0, 8)}..., amount=${w.uiTokenAmount?.uiAmount || w.uiTokenAmount?.amount || 'N/A'}`);
        }
        for (const w of postWSOL) {
          console.log(`     Post WSOL: owner=${w.owner?.substring(0, 8)}..., amount=${w.uiTokenAmount?.uiAmount || w.uiTokenAmount?.amount || 'N/A'}`);
        }
      }
      
      // Show native SOL balance changes
      if (tx.meta.preBalances && tx.meta.postBalances) {
        const walletLower = walletAddress.toLowerCase();
        let keys: string[] = [];
        // Try to get account keys - handle both versioned and non-versioned messages
        try {
          if ('accountKeys' in (tx.transaction?.message || {})) {
            const accountKeys = (tx.transaction.message as any).accountKeys;
            if (accountKeys) {
              keys = accountKeys.map((k: any) => typeof k === 'string' ? k : k?.pubkey);
            }
          } else if ('staticAccountKeys' in (tx.transaction?.message || {})) {
            const staticAccountKeys = (tx.transaction.message as any).staticAccountKeys;
            if (staticAccountKeys) {
              keys = staticAccountKeys.map((k: any) => typeof k === 'string' ? k : k?.pubkey);
            }
          }
        } catch (e) {
          // Ignore errors when accessing accountKeys
        }
        
        let totalSolDelta = 0;
        let walletSolDelta = 0;
        console.log(`   All balance changes (${tx.meta.preBalances.length} accounts):`);
        for (let i = 0; i < Math.min(tx.meta.preBalances.length, tx.meta.postBalances.length); i++) {
          const pre = tx.meta.preBalances[i] || 0;
          const post = tx.meta.postBalances[i] || 0;
          const delta = (post - pre) / 1e9;
          totalSolDelta += delta;
          
          // Check if this account belongs to wallet
          if (keys[i] && keys[i].toLowerCase() === walletLower) {
            walletSolDelta += delta;
            console.log(`   [WALLET] Account ${i}: ${delta.toFixed(6)} SOL (pre: ${(pre / 1e9).toFixed(6)}, post: ${(post / 1e9).toFixed(6)})`);
          } else if (Math.abs(delta) > 0.01) {
            // Show significant changes from other accounts
            console.log(`   Account ${i} (${keys[i]?.substring(0, 8) || 'unknown'}...): ${delta.toFixed(6)} SOL`);
          }
        }
        console.log(`   Total SOL change (all accounts): ${totalSolDelta.toFixed(6)} SOL`);
        if (Math.abs(walletSolDelta) > 0.0001) {
          console.log(`   Wallet SOL change: ${walletSolDelta.toFixed(6)} SOL`);
        } else {
          console.log(`   ⚠️  Wallet SOL change: ${walletSolDelta.toFixed(6)} SOL (not found in accountKeys)`);
        }
      }
    }

    // 4. Try to normalize it
    console.log(`\n🔄 Attempting to normalize transaction...`);
    
    // Find wallet
    const wallet = await smartWalletRepo.findByAddress(walletAddress);
    if (!wallet) {
      console.error(`❌ Wallet not found in database: ${walletAddress}`);
      return;
    }

    // Convert transaction to QuickNode format
    const quickNodeTx = {
      transaction: {
        signatures: [signature],
        message: tx.transaction.message,
      },
      meta: tx.meta,
      slot: tx.slot,
      blockTime: tx.blockTime,
    };

    const result = await collectorService.processQuickNodeTransaction(
      quickNodeTx,
      walletAddress,
      tx.blockTime ?? undefined
    );

    if (result.saved) {
      console.log(`✅ Transaction processed and saved!`);
    } else {
      console.log(`❌ Transaction not saved: ${result.reason}`);
    }

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    if (error.stack) {
      console.error(`   Stack: ${error.stack.split('\n').slice(0, 5).join('\n')}`);
    }
  }
}

// Run script
const signature = process.argv[2];
const walletAddress = process.argv[3];

if (!signature || !walletAddress) {
  console.error('Usage: pnpm check-transaction <signature> <walletAddress>');
  console.error('Example: pnpm check-transaction 333FJrnSt7WtKWHqUm3JgGM6UcbUFLC6rmh6XJJWCP9TRKonM4xHSRdQWnJY3Hz31MLHHQCGctagbyHs985mA6uf 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f');
  process.exit(1);
}

checkTransaction(signature, walletAddress).catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

