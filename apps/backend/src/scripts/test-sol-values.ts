import 'dotenv/config';
import { HeliusClient } from '../services/helius-client.service.js';
import { supabase, TABLES } from '../lib/supabase.js';

// Usage: pnpm test:sol-values <txSignature> [walletAddress]
// Example: pnpm test:sol-values 4a8JxZidj7jm8f8X4uvYf4BB3zzvBLDkkSTEH1GKHmK7cYYrjyHe262ByWYhXPNDsMHkFnfn91oRhvcrwZNM8rWM
const TX_SIGNATURE = process.argv[2];
const WALLET_ADDRESS = process.argv[3]; // Optional - if not provided, will try to find from trade in DB

if (!TX_SIGNATURE) {
  console.error('❌ Please provide transaction signature:');
  console.error('   pnpm test:sol-values <txSignature> [walletAddress]');
  process.exit(1);
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function testSolValues() {
  console.log(`🔍 Testing SOL/WSOL values for transaction: ${TX_SIGNATURE}\n`);
  
  const heliusClient = new HeliusClient();
  
  // 1. Fetch transaction from Helius
  let heliusTx: any = null;
  try {
    heliusTx = await heliusClient.getTransaction(TX_SIGNATURE);
    if (!heliusTx) {
      console.error(`❌ Transaction not found in Helius: ${TX_SIGNATURE}`);
      return;
    }
  } catch (error: any) {
    console.error(`❌ Error fetching transaction: ${error.message}`);
    return;
  }
  
  console.log(`📊 Transaction info:`);
  console.log(`   Source: ${heliusTx.source || 'unknown'}`);
  console.log(`   Type: ${heliusTx.type || 'unknown'}`);
  console.log(`   Timestamp: ${new Date(heliusTx.timestamp * 1000).toISOString()}\n`);
  
  // 2. Determine wallet address
  let walletAddress = WALLET_ADDRESS;
  if (!walletAddress) {
    // Try to find from trade in DB
    const { data: trade } = await supabase
      .from(TABLES.TRADE)
      .select(`
        id,
        wallet:${TABLES.SMART_WALLET}(address)
      `)
      .eq('txSignature', TX_SIGNATURE)
      .single();
    
    if (trade && (trade as any).wallet) {
      walletAddress = (trade as any).wallet.address;
      console.log(`📝 Found wallet from DB: ${walletAddress}\n`);
    } else {
      console.log(`⚠️  Wallet address not provided and not found in DB. Analyzing all transfers.\n`);
    }
  } else {
    console.log(`📝 Using provided wallet: ${walletAddress}\n`);
  }
  
  const walletLower = walletAddress?.toLowerCase();
  const isWalletAccount = (account?: string): boolean => {
    if (!account || !walletAddress) return false;
    return account.toLowerCase() === walletLower;
  };
  
  // 3. Analyze native SOL transfers
  console.log(`💰 Native SOL Transfers:`);
  const nativeTransfers = heliusTx.nativeTransfers || [];
  if (nativeTransfers.length === 0) {
    console.log(`   None found\n`);
  } else {
    let totalSent = 0;
    let totalReceived = 0;
    nativeTransfers.forEach((transfer: any, idx: number) => {
      const amountSol = Number(transfer.amount || 0) / 1e9;
      const fromWallet = walletAddress && isWalletAccount(transfer.fromUserAccount);
      const toWallet = walletAddress && isWalletAccount(transfer.toUserAccount);
      
      if (walletAddress) {
        if (fromWallet) {
          totalSent += amountSol;
          console.log(`   [${idx + 1}] OUT: ${amountSol.toFixed(9)} SOL (from wallet)`);
        } else if (toWallet) {
          totalReceived += amountSol;
          console.log(`   [${idx + 1}] IN:  ${amountSol.toFixed(9)} SOL (to wallet)`);
        } else {
          console.log(`   [${idx + 1}]     ${amountSol.toFixed(9)} SOL (other: ${transfer.fromUserAccount.substring(0, 8)}... → ${transfer.toUserAccount.substring(0, 8)}...)`);
        }
      } else {
        console.log(`   [${idx + 1}]     ${amountSol.toFixed(9)} SOL (${transfer.fromUserAccount.substring(0, 8)}... → ${transfer.toUserAccount.substring(0, 8)}...)`);
      }
    });
    if (walletAddress) {
      console.log(`   Total sent: ${totalSent.toFixed(9)} SOL`);
      console.log(`   Total received: ${totalReceived.toFixed(9)} SOL`);
      console.log(`   Net: ${(totalReceived - totalSent).toFixed(9)} SOL\n`);
    } else {
      console.log(`\n`);
    }
  }
  
  // 4. Analyze WSOL token transfers
  console.log(`🪙 WSOL Token Transfers:`);
  const tokenTransfers = heliusTx.tokenTransfers || [];
  const wsolTransfers = tokenTransfers.filter((t: any) => t.mint === SOL_MINT);
  if (wsolTransfers.length === 0) {
    console.log(`   None found\n`);
  } else {
    let totalSent = 0;
    let totalReceived = 0;
    wsolTransfers.forEach((transfer: any, idx: number) => {
      const amount = transfer.tokenAmount || 0;
      const fromWallet = walletAddress && isWalletAccount(transfer.fromUserAccount);
      const toWallet = walletAddress && isWalletAccount(transfer.toUserAccount);
      
      if (walletAddress) {
        if (fromWallet) {
          totalSent += amount;
          console.log(`   [${idx + 1}] OUT: ${amount.toFixed(9)} WSOL (from wallet)`);
        } else if (toWallet) {
          totalReceived += amount;
          console.log(`   [${idx + 1}] IN:  ${amount.toFixed(9)} WSOL (to wallet)`);
        } else {
          console.log(`   [${idx + 1}]     ${amount.toFixed(9)} WSOL (other)`);
        }
      } else {
        console.log(`   [${idx + 1}]     ${amount.toFixed(9)} WSOL (${transfer.fromUserAccount?.substring(0, 8) || 'unknown'}... → ${transfer.toUserAccount?.substring(0, 8) || 'unknown'}...)`);
      }
    });
    if (walletAddress) {
      console.log(`   Total sent: ${totalSent.toFixed(9)} WSOL`);
      console.log(`   Total received: ${totalReceived.toFixed(9)} WSOL`);
      console.log(`   Net: ${(totalReceived - totalSent).toFixed(9)} WSOL\n`);
    } else {
      console.log(`\n`);
    }
  }
  
  // 5. Analyze events.swap
  console.log(`🔄 Events.swap:`);
  const swap = heliusTx.events?.swap;
  if (!swap) {
    console.log(`   No events.swap found\n`);
  } else {
    if (swap.nativeInput) {
      const amount = Number(swap.nativeInput.amount) / 1e9;
      const isWallet = walletAddress && isWalletAccount(swap.nativeInput.account);
      console.log(`   nativeInput: ${amount.toFixed(9)} SOL ${isWallet ? '(wallet)' : `(account: ${swap.nativeInput.account.substring(0, 8)}...)`}`);
    }
    if (swap.nativeOutput) {
      const amount = Number(swap.nativeOutput.amount) / 1e9;
      const isWallet = walletAddress && isWalletAccount(swap.nativeOutput.account);
      console.log(`   nativeOutput: ${amount.toFixed(9)} SOL ${isWallet ? '(wallet)' : `(account: ${swap.nativeOutput.account.substring(0, 8)}...)`}`);
    }
    
    // Token inputs/outputs (WSOL)
    const allTokenInputs = [
      ...(swap.tokenInputs ?? []),
      ...((swap.innerSwaps ?? []).flatMap((s: any) => s.tokenInputs ?? [])),
    ];
    const allTokenOutputs = [
      ...(swap.tokenOutputs ?? []),
      ...((swap.innerSwaps ?? []).flatMap((s: any) => s.tokenOutputs ?? [])),
    ];
    
    const wsolInputs = allTokenInputs.filter((t: any) => t.mint === SOL_MINT);
    const wsolOutputs = allTokenOutputs.filter((t: any) => t.mint === SOL_MINT);
    
    if (wsolInputs.length > 0) {
      console.log(`   WSOL inputs:`);
      wsolInputs.forEach((ti: any, idx: number) => {
        const isWallet = walletAddress && (isWalletAccount(ti.userAccount) || isWalletAccount(ti.fromUserAccount));
        const amount = ti.tokenAmount || (ti.rawTokenAmount ? Number(ti.rawTokenAmount.tokenAmount) / Math.pow(10, ti.rawTokenAmount.decimals || 9) : 0);
        console.log(`     [${idx + 1}] ${amount.toFixed(9)} WSOL ${isWallet ? '(wallet)' : ''}`);
      });
    }
    if (wsolOutputs.length > 0) {
      console.log(`   WSOL outputs:`);
      wsolOutputs.forEach((to: any, idx: number) => {
        const isWallet = walletAddress && (isWalletAccount(to.userAccount) || isWalletAccount(to.toUserAccount));
        const amount = to.tokenAmount || (to.rawTokenAmount ? Number(to.rawTokenAmount.tokenAmount) / Math.pow(10, to.rawTokenAmount.decimals || 9) : 0);
        console.log(`     [${idx + 1}] ${amount.toFixed(9)} WSOL ${isWallet ? '(wallet)' : ''}`);
      });
    }
    console.log(``);
  }
  
  // 6. Analyze accountData
  console.log(`📊 Account Data:`);
  if (!heliusTx.accountData || heliusTx.accountData.length === 0) {
    console.log(`   No accountData found\n`);
  } else {
    heliusTx.accountData.forEach((acc: any, idx: number) => {
      const isWallet = walletAddress && acc.account.toLowerCase() === walletLower;
      if (walletAddress && !isWallet) return; // Skip non-wallet accounts if wallet is specified
      
      const nativeChange = acc.nativeBalanceChange ? Number(acc.nativeBalanceChange) / 1e9 : 0;
      console.log(`   [${idx + 1}] Account: ${acc.account.substring(0, 16)}... ${isWallet ? '(WALLET)' : ''}`);
      console.log(`       nativeBalanceChange: ${nativeChange.toFixed(9)} SOL`);
      if (acc.tokenBalanceChanges && acc.tokenBalanceChanges.length > 0) {
        const wsolChanges = acc.tokenBalanceChanges.filter((t: any) => t.mint === SOL_MINT);
        if (wsolChanges.length > 0) {
          wsolChanges.forEach((t: any) => {
            const amount = t.tokenAmount || 0;
            console.log(`       WSOL change: ${amount.toFixed(9)} WSOL`);
          });
        }
      }
    });
    console.log(``);
  }
  
  // 7. Description parser
  console.log(`📝 Description:`);
  const desc = (heliusTx as any).description;
  if (!desc) {
    console.log(`   No description found\n`);
  } else {
    console.log(`   ${desc.substring(0, 500)}${desc.length > 500 ? '...' : ''}\n`);
    
    // Try to parse SOL amount from description
    const BASE_SYMBOLS = new Set(['SOL', 'WSOL', 'USDC', 'USDT']);
    const regex = /([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z$][A-Za-z0-9$/]*)/g;
    let match: RegExpExecArray | null;
    const candidates: Array<{ amount: number; symbol: string }> = [];
    
    while ((match = regex.exec(desc)) !== null) {
      const amount = parseFloat(match[1]);
      if (!isFinite(amount) || amount <= 0) continue;
      
      let symbol = match[2].trim().replace(/^\$/, '').replace(/,$/, '').toUpperCase();
      if (BASE_SYMBOLS.has(symbol) || symbol === 'WSOL') {
        const normalizedSymbol = symbol === 'WSOL' ? 'SOL' : symbol;
        candidates.push({ amount, symbol: normalizedSymbol });
      }
    }
    
    if (candidates.length > 0) {
      console.log(`   Parsed base amounts from description:`);
      candidates.forEach((c, idx) => {
        console.log(`     [${idx + 1}] ${c.amount} ${c.symbol}`);
      });
      const best = candidates.reduce((a, b) => (b.amount > a.amount ? b : a));
      console.log(`   → Largest: ${best.amount} ${best.symbol}\n`);
    } else {
      console.log(`   No base amounts found in description\n`);
    }
  }
  
  // 8. Calculate largest SOL transfer (if wallet is known)
  if (walletAddress) {
    console.log(`🔍 Largest SOL/WSOL Transfer for Wallet:`);
    let largestSol = 0;
    let largestSource = '';
    
    // Check native transfers
    for (const transfer of nativeTransfers) {
      const isWallet = isWalletAccount(transfer.fromUserAccount) || isWalletAccount(transfer.toUserAccount);
      if (!isWallet) continue;
      
      const amountSol = Number(transfer.amount || 0) / 1e9;
      if (amountSol > largestSol) {
        largestSol = amountSol;
        largestSource = 'nativeTransfers';
      }
    }
    
    // Check WSOL token transfers
    for (const transfer of wsolTransfers) {
      const isWallet = isWalletAccount(transfer.fromUserAccount) || isWalletAccount(transfer.toUserAccount);
      if (!isWallet) continue;
      
      const amount = transfer.tokenAmount || 0;
      if (amount > largestSol) {
        largestSol = amount;
        largestSource = 'tokenTransfers (WSOL)';
      }
    }
    
    // Check events.swap
    if (swap) {
      if (swap.nativeInput && isWalletAccount(swap.nativeInput.account)) {
        const amount = Number(swap.nativeInput.amount) / 1e9;
        if (amount > largestSol) {
          largestSol = amount;
          largestSource = 'events.swap.nativeInput';
        }
      }
      if (swap.nativeOutput && isWalletAccount(swap.nativeOutput.account)) {
        const amount = Number(swap.nativeOutput.amount) / 1e9;
        if (amount > largestSol) {
          largestSol = amount;
          largestSource = 'events.swap.nativeOutput';
        }
      }
      
      const allTokenInputs = [
        ...(swap.tokenInputs ?? []),
        ...((swap.innerSwaps ?? []).flatMap((s: any) => s.tokenInputs ?? [])),
      ];
      const allTokenOutputs = [
        ...(swap.tokenOutputs ?? []),
        ...((swap.innerSwaps ?? []).flatMap((s: any) => s.tokenOutputs ?? [])),
      ];
      
      for (const ti of allTokenInputs) {
        const isWallet = isWalletAccount(ti.userAccount) || isWalletAccount(ti.fromUserAccount);
        if (!isWallet || ti.mint !== SOL_MINT) continue;
        
        const amount = ti.tokenAmount || (ti.rawTokenAmount ? Number(ti.rawTokenAmount.tokenAmount) / Math.pow(10, ti.rawTokenAmount.decimals || 9) : 0);
        if (amount > largestSol) {
          largestSol = amount;
          largestSource = 'events.swap.tokenInputs (WSOL)';
        }
      }
      
      for (const to of allTokenOutputs) {
        const isWallet = isWalletAccount(to.userAccount) || isWalletAccount(to.toUserAccount);
        if (!isWallet || to.mint !== SOL_MINT) continue;
        
        const amount = to.tokenAmount || (to.rawTokenAmount ? Number(to.rawTokenAmount.tokenAmount) / Math.pow(10, to.rawTokenAmount.decimals || 9) : 0);
        if (amount > largestSol) {
          largestSol = amount;
          largestSource = 'events.swap.tokenOutputs (WSOL)';
        }
      }
    }
    
    if (largestSol > 0) {
      console.log(`   ${largestSol.toFixed(9)} SOL (from ${largestSource})\n`);
    } else {
      console.log(`   No SOL/WSOL transfers found for wallet\n`);
    }
  }
  
  // 9. Check if trade exists in DB
  console.log(`💾 Database Trade:`);
  const { data: trade } = await supabase
    .from(TABLES.TRADE)
    .select(`
      id,
      amountBase,
      amountToken,
      priceBasePerToken,
      side,
      wallet:${TABLES.SMART_WALLET}(address, label)
    `)
    .eq('txSignature', TX_SIGNATURE)
    .single();
  
  if (trade) {
    console.log(`   Found in DB:`);
    console.log(`   amountBase: ${Number(trade.amountBase).toFixed(9)} SOL`);
    console.log(`   amountToken: ${Number(trade.amountToken).toFixed(2)}`);
    console.log(`   priceBasePerToken: ${Number(trade.priceBasePerToken).toFixed(9)} SOL`);
    console.log(`   side: ${trade.side}`);
    if ((trade as any).wallet) {
      console.log(`   wallet: ${(trade as any).wallet.address} (${(trade as any).wallet.label || 'no label'})`);
    }
    console.log(``);
  } else {
    console.log(`   Not found in DB\n`);
  }
  
  console.log(`✅ Analysis complete!`);
}

testSolValues().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

