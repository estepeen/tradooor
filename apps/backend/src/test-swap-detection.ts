/**
 * Debug script pro testování swap detekce
 * 
 * Testuje celý pipeline: Helius → isWalletSwap → normalizeSwap
 * 
 * Použití:
 *   pnpm test:swap-detection <transaction_signature> <wallet_address>
 * 
 * Příklad:
 *   pnpm test:swap-detection 4ZqzSNtBMe5ZvDVe... HhYnLvkNqmv4t9yKJvFNrT4A4cEwDrPPMt3zdaZX1n76
 */

import dotenv from 'dotenv';
import { HeliusClient } from './services/helius-client.service.js';

dotenv.config();

// Import helper funkcí z collectoru (musíme je zkopírovat, protože nejsou exportované)
const ALLOWED_SWAP_SOURCES = new Set<string>([
  'JUPITER', 'JUPITER_LIMIT', 'RAYDIUM', 'PUMP_FUN', 'PUMP_AMM', 'METEORA', 'OKX',
  'ORCA', 'ORCA_V2', 'ORCA_WHIRLPOOL', 'WHIRLPOOL', 'LIFINITY', 'PHOENIX', 'MERCURIAL',
  'DRIFT', 'MANGO', 'ALDRIN', 'SABER', 'GOOSEFX', 'MARINADE', 'STEP', 'GMGN', 'BONK_DEX',
  'BLOOM', 'DFLOW', 'BACKPACK', 'PHANTOM',
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

const isSwapTx = (tx: any): boolean => {
  const hasSwapEvent = !!tx.events?.swap;
  const isSwapType = tx.type === 'SWAP';
  return hasSwapEvent || isSwapType;
};

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

const swapInvolvesWallet = (tx: any, wallet: string): boolean => {
  const swap = tx.events?.swap;
  if (!swap) return false;

  const accounts = new Set<string>();
  const addAccount = (acc?: string) => {
    if (acc) accounts.add(acc);
  };

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

  collectTokenAccounts(swap.tokenInputs);
  collectTokenAccounts(swap.tokenOutputs);

  if (swap.innerSwaps && Array.isArray(swap.innerSwaps)) {
    for (const inner of swap.innerSwaps) {
      collectTokenAccounts(inner.tokenInputs);
      collectTokenAccounts(inner.tokenOutputs);
    }
  }

  return accounts.has(wallet);
};

const passesSourceHint = (tx: any): boolean => {
  const source = getTransactionSource(tx);
  if (!source) return true;
  if (ALLOWED_SWAP_SOURCES.has(source)) {
    return true;
  }
  return true; // Nezabíjíme swapy podle source
};

const isWalletSwap = (tx: any, wallet: string): boolean => {
  // Pokud Helius explicitně říká type='SWAP', věříme mu
  if (tx.type === 'SWAP') {
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
      return true;
    }
  }

  if (!isSwapTx(tx)) return false;

  if (tx.events?.swap) {
    if (!isRealTokenSwap(tx)) return false;
    if (!swapInvolvesWallet(tx, wallet)) return false;
    return true;
  }

  const tokenTransfers = tx.tokenTransfers ?? [];
  const nativeTransfers = tx.nativeTransfers ?? [];

  const walletInvolved =
    tokenTransfers.some(
      (t: any) => t.fromUserAccount === wallet || t.toUserAccount === wallet
    ) ||
    nativeTransfers.some(
      (n: any) => n.fromUserAccount === wallet || n.toUserAccount === wallet
    );

  if (!walletInvolved) return false;

  const uniqueMints = new Set<string>(tokenTransfers.map((t: any) => t.mint).filter(Boolean));
  const looksLikeTokenSwap =
    uniqueMints.size >= 2 || (uniqueMints.size === 1 && nativeTransfers.length > 0);

  if (!looksLikeTokenSwap) return false;

  if (!passesSourceHint(tx)) return false;

  return true;
};

async function main() {
  const txSignature = process.argv[2];
  const walletAddress = process.argv[3];

  if (!txSignature) {
    console.error('❌ Chybí transaction signature!');
    console.log('\nPoužití:');
    console.log('  pnpm test:swap-detection <transaction_signature> <wallet_address>');
    console.log('\nPříklad:');
    console.log('  pnpm test:swap-detection 4ZqzSNtBMe5ZvDVe... HhYnLvkNqmv4t9yKJvFNrT4A4cEwDrPPMt3zdaZX1n76');
    process.exit(1);
  }

  if (!walletAddress) {
    console.error('❌ Chybí wallet address!');
    console.log('\nPoužití:');
    console.log('  pnpm test:swap-detection <transaction_signature> <wallet_address>');
    process.exit(1);
  }

  const heliusClient = new HeliusClient();

  if (!heliusClient.isAvailable()) {
    console.error('❌ Helius API key není nastavená!');
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🔍 SWAP DETECTION DEBUG');
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log(`📋 Transaction: ${txSignature}`);
  console.log(`👛 Wallet:      ${walletAddress}\n`);

  try {
    // Fetch transaction from Helius
    const apiKey = process.env.HELIUS_API_KEY || process.env.HELIUS_API || '';
    const baseUrl = 'https://api.helius.xyz/v0';
    const parseUrl = `${baseUrl}/transactions/?api-key=${apiKey}`;
    
    const response = await fetch(parseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [txSignature] }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Helius API error: ${response.status} ${response.statusText}`);
      console.error(`Response: ${errorText}`);
      process.exit(1);
    }

    const data = await response.json();
    if (!data || data.length === 0) {
      console.error('❌ Helius API vrátil prázdnou odpověď');
      process.exit(1);
    }

    const tx = data[0];

    // 1. HELIUS DATA
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('1️⃣  HELIUS DATA');
    console.log('═══════════════════════════════════════════════════════════════\n');
    console.log(`   Type:        ${tx.type || 'N/A'}`);
    console.log(`   Source:      ${tx.source || 'N/A'}`);
    console.log(`   Has events.swap: ${!!tx.events?.swap}`);
    console.log(`   Token transfers: ${tx.tokenTransfers?.length || 0}`);
    console.log(`   Native transfers: ${tx.nativeTransfers?.length || 0}`);
    console.log(`   Account data entries: ${tx.accountData?.length || 0}`);
    
    if (tx.events?.swap) {
      const swap = tx.events.swap;
      console.log(`\n   events.swap:`);
      console.log(`      tokenInputs:  ${swap.tokenInputs?.length || 0}`);
      console.log(`      tokenOutputs: ${swap.tokenOutputs?.length || 0}`);
      console.log(`      nativeInput:  ${swap.nativeInput ? `${Number(swap.nativeInput.amount) / 1e9} SOL` : 'none'}`);
      console.log(`      nativeOutput: ${swap.nativeOutput ? `${Number(swap.nativeOutput.amount) / 1e9} SOL` : 'none'}`);
    }
    console.log();

    // 2. isSwapTx CHECK
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('2️⃣  isSwapTx CHECK');
    console.log('═══════════════════════════════════════════════════════════════\n');
    const swapTxResult = isSwapTx(tx);
    console.log(`   Result: ${swapTxResult ? '✅ TRUE' : '❌ FALSE'}`);
    console.log(`   Reason:`);
    console.log(`      - type === 'SWAP': ${tx.type === 'SWAP'}`);
    console.log(`      - has events.swap: ${!!tx.events?.swap}`);
    console.log();

    // 3. isWalletSwap CHECK (s fallback na normalizeSwap)
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('3️⃣  isWalletSwap CHECK (Collector filter)');
    console.log('═══════════════════════════════════════════════════════════════\n');
    let walletSwapResult = isWalletSwap(tx, walletAddress);
    console.log(`   Initial result: ${walletSwapResult ? '✅ TRUE' : '❌ FALSE'}`);
    
    // Simulace nové logiky z collectoru: pokud isWalletSwap vrátí false,
    // ale transakce vypadá jako swap kandidát, zkusme normalizeSwap
    if (!walletSwapResult) {
      const tokenTransfers = tx.tokenTransfers ?? [];
      const nativeTransfers = tx.nativeTransfers ?? [];
      
      const walletInvolved =
        tokenTransfers.some(
          (t: any) => t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress
        ) ||
        nativeTransfers.some(
          (n: any) => n.fromUserAccount === walletAddress || n.toUserAccount === walletAddress
        ) ||
        tx.accountData?.some(
          (acc: any) => acc.account === walletAddress && (acc.nativeBalanceChange !== 0 || (acc.tokenBalanceChanges?.length ?? 0) > 0)
        );
      
      if (walletInvolved && (tokenTransfers.length > 0 || nativeTransfers.length > 0)) {
        console.log(`\n   ⚠️  isWalletSwap returned false, but transaction looks like swap candidate.`);
        console.log(`      Trying normalizeSwap as fallback...`);
        // normalizeSwap check je v sekci 4, takže tady jen označíme, že to zkusíme
        console.log(`      (See section 4 for normalizeSwap result)`);
      }
    }
    
    if (tx.type === 'SWAP') {
      console.log(`\n   ⚠️  type='SWAP' detected - checking wallet involvement...`);
      const walletInvolved =
        tx.tokenTransfers?.some(
          (t: any) => t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress
        ) ||
        tx.nativeTransfers?.some(
          (n: any) => n.fromUserAccount === walletAddress || n.toUserAccount === walletAddress
        ) ||
        tx.events?.swap?.nativeInput?.account === walletAddress ||
        tx.events?.swap?.nativeOutput?.account === walletAddress ||
        tx.events?.swap?.tokenInputs?.some(
          (t: any) => t.userAccount === walletAddress || t.fromUserAccount === walletAddress
        ) ||
        tx.events?.swap?.tokenOutputs?.some(
          (t: any) => t.userAccount === walletAddress || t.toUserAccount === walletAddress
        ) ||
        tx.accountData?.some(
          (acc: any) => acc.account === walletAddress && (acc.nativeBalanceChange !== 0 || (acc.tokenBalanceChanges?.length ?? 0) > 0)
        );
      console.log(`      Wallet involved: ${walletInvolved ? '✅ YES' : '❌ NO'}`);
    }
    
    if (tx.events?.swap) {
      console.log(`\n   events.swap path:`);
      const realSwap = isRealTokenSwap(tx);
      const involvesWallet = swapInvolvesWallet(tx, walletAddress);
      console.log(`      isRealTokenSwap: ${realSwap ? '✅' : '❌'}`);
      console.log(`      swapInvolvesWallet: ${involvesWallet ? '✅' : '❌'}`);
    }
    console.log();

    // 4. normalizeSwap CHECK
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('4️⃣  normalizeSwap CHECK (HeliusClient)');
    console.log('═══════════════════════════════════════════════════════════════\n');
      const normalized = heliusClient.normalizeSwap(tx, walletAddress);
      if (normalized) {
      console.log(`   Result: ✅ SUCCESS (normalizeSwap vrátil swap)`);
      console.log(`\n   Normalized swap:`);
      console.log(`      Side:            ${normalized.side}`);
      console.log(`      Token Mint:      ${normalized.tokenMint.substring(0, 16)}...`);
      console.log(`      Amount Token:    ${normalized.amountToken.toFixed(6)}`);
      console.log(`      Amount Base:     ${normalized.amountBase.toFixed(6)} SOL`);
      console.log(`      Price:           ${normalized.priceBasePerToken.toFixed(9)} SOL/token`);
      console.log(`      DEX:             ${normalized.dex}`);
      console.log(`      Timestamp:       ${normalized.timestamp.toISOString()}`);
      } else {
      console.log(`   Result: ❌ FAILED (normalizeSwap vrátil null)`);
      console.log(`\n   ⚠️  normalizeSwap nedokázal zpracovat tuto transakci.`);
      console.log(`   Možné důvody:`);
      console.log(`      - Base ↔ base swap (SOL/USDC/USDT mezi sebou)`);
      console.log(`      - Chybí tokenInputs/tokenOutputs`);
      console.log(`      - Peněženka není účastník swapu`);
      console.log(`      - Neplatná struktura swapu`);
    }
    console.log();

    // 5. FINAL VERDICT (s novou logikou - fallback na normalizeSwap)
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('5️⃣  FINAL VERDICT');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    // Nová logika: pokud isWalletSwap vrátí false, ale normalizeSwap vrátí swap,
    // collector by to přijal (fallback logika)
    const tokenTransfers = tx.tokenTransfers ?? [];
    const nativeTransfers = tx.nativeTransfers ?? [];
    const walletInvolved =
      tokenTransfers.some(
        (t: any) => t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress
      ) ||
      nativeTransfers.some(
        (n: any) => n.fromUserAccount === walletAddress || n.toUserAccount === walletAddress
      ) ||
      tx.accountData?.some(
        (acc: any) => acc.account === walletAddress && (acc.nativeBalanceChange !== 0 || (acc.tokenBalanceChanges?.length ?? 0) > 0)
      );
    
    const wouldBeAcceptedByCollector = walletSwapResult || (normalized !== null && walletInvolved && (tokenTransfers.length > 0 || nativeTransfers.length > 0));
    
    if (wouldBeAcceptedByCollector && normalized !== null) {
      console.log('   ✅ MĚLO BY TO BÝT TRADE');
      if (walletSwapResult) {
        console.log(`      - Collector by to přijal (isWalletSwap = true)`);
      } else {
        console.log(`      - Collector by to přijal (fallback: normalizeSwap success)`);
      }
      console.log(`      - normalizeSwap to dokázal zpracovat`);
      console.log(`      - Trade by byl uložen do DB`);
    } else {
      console.log('   ❌ NEBUDE TO TRADE');
      if (!walletSwapResult && !(normalized !== null && walletInvolved)) {
        console.log(`      - Collector by to VYHODIL (isWalletSwap = false)`);
        if (normalized === null) {
          console.log(`      - normalizeSwap také vrátil null (fallback selhal)`);
        } else if (!walletInvolved) {
          console.log(`      - Peněženka není účastník swapu`);
        }
      } else if (normalized === null) {
        console.log(`      - normalizeSwap vrátil null`);
      }
    }
    console.log();

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch(console.error);
