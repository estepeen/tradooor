import { Connection, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import { HeliusClient } from './services/helius-client.service.js';
import { TokenPriceService } from './services/token-price.service.js';
import { TokenMetadataBatchService } from './services/token-metadata-batch.service.js';
import { TokenRepository } from './repositories/token.repository.js';
import { SolPriceService } from './services/sol-price.service.js';

dotenv.config();

const WALLET_ADDRESS = 'HhYnLvkNqmv4t9yKJvFNrT4A4cEwDrPPMt3zdaZX1n76'; // STPN wallet

async function testPortfolio() {
  console.log('🚀 Testing portfolio fetch for wallet:', WALLET_ADDRESS);
  console.log('='.repeat(80));

  // Initialize services
  const rpcUrl =
    process.env.HELIUS_RPC_URL ||
    process.env.HELIUS_API ||
    process.env.SOLANA_RPC_URL ||
    'https://api.mainnet-beta.solana.com';
  
  const connection = new Connection(rpcUrl, 'confirmed');
  const owner = new PublicKey(WALLET_ADDRESS);
  
  const heliusClient = new HeliusClient();
  const tokenPriceService = new TokenPriceService();
  const tokenRepo = new TokenRepository();
  const tokenMetadataBatchService = new TokenMetadataBatchService(heliusClient, tokenRepo);
  const solPriceService = new SolPriceService();

  // 1) Native SOL
  console.log('\n📊 Step 1: Fetching native SOL balance...');
  const lamports = await connection.getBalance(owner, 'confirmed');
  const solBalance = lamports / 1e9;
  console.log(`   SOL balance: ${solBalance} SOL`);
  
  const solPrice = await solPriceService.getSolPriceUsd().catch(() => null);
  const solValue = solPrice ? solBalance * solPrice : null;
  console.log(`   SOL price: $${solPrice || 'N/A'}`);
  console.log(`   SOL value: $${solValue || 'N/A'}`);

  // 2) SPL Token accounts (both classic and Token-2022)
  console.log('\n📊 Step 2: Fetching SPL token accounts...');
  const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  
  const [parsedClassic, parsedToken2022] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: SPL_TOKEN_PROGRAM_ID }).catch((e) => {
      console.warn('⚠️ Failed to fetch classic SPL tokens:', e?.message || e);
      return { value: [] };
    }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }).catch((e) => {
      console.warn('⚠️ Failed to fetch Token-2022 tokens:', e?.message || e);
      return { value: [] };
    }),
  ]);
  
  const accounts = [...(parsedClassic.value || []), ...(parsedToken2022.value || [])];
  console.log(`   Found ${parsedClassic.value?.length || 0} classic SPL tokens`);
  console.log(`   Found ${parsedToken2022.value?.length || 0} Token-2022 tokens`);
  console.log(`   Total: ${accounts.length} token accounts`);

  // 3) Process token accounts
  console.log('\n📊 Step 3: Processing token accounts...');
  const tokenRows: Array<{ mint: string; uiAmount: number; decimals: number }> = [];
  const mintSet = new Set<string>();
  
  for (const acc of accounts) {
    const info: any = acc.account?.data?.parsed?.info;
    const mint = info?.mint as string;
    const amount = info?.tokenAmount;
    
    let uiAmount = 0;
    if (amount?.uiAmount !== undefined && amount?.uiAmount !== null) {
      uiAmount = typeof amount.uiAmount === 'string' ? parseFloat(amount.uiAmount) : Number(amount.uiAmount);
    }
    
    const decimals = Number(amount?.decimals || 0);
    
    if (mint && uiAmount > 0) {
      tokenRows.push({ mint, uiAmount, decimals });
      mintSet.add(mint);
    }
  }
  
  console.log(`   Processed ${tokenRows.length} tokens with balance > 0`);
  console.log(`   Unique mints: ${mintSet.size}`);

  // 4) Fetch metadata
  console.log('\n📊 Step 4: Fetching token metadata...');
  const mintAddresses = Array.from(mintSet);
  const metadataMap = await tokenMetadataBatchService.getTokenMetadataBatch(mintAddresses);
  console.log(`   Got metadata for ${metadataMap.size}/${mintAddresses.length} tokens`);

  // 5) Fetch prices
  console.log('\n📊 Step 5: Fetching token prices...');
  const priceMap = await tokenPriceService.getTokenPricesBatch(mintAddresses);
  console.log(`   Got prices for ${priceMap.size}/${mintAddresses.length} tokens`);
  
  // DEBUG: Check specific tokens
  const importantTokens: Record<string, string> = {
    'TNSR': 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6',
    'PUMP': 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
    'TRUMP': '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
    'BOME': 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
  };
  
  console.log('\n   🔍 Checking prices for important tokens:');
  for (const [symbol, mint] of Object.entries(importantTokens)) {
    const price = priceMap.get(mint.toLowerCase());
    if (price) {
      console.log(`   ✅ ${symbol}: $${price}`);
    } else {
      console.log(`   ❌ ${symbol}: No price found (mint: ${mint})`);
      // Try direct fetch with detailed logging
      try {
        const birdeyeApiKey = process.env.BIRDEYE_API_KEY;
        if (birdeyeApiKey) {
          const url = `https://public-api.birdeye.so/defi/price?address=${mint}&ui_amount_mode=raw`;
          console.log(`      → Trying Birdeye API: ${url}`);
          const response = await fetch(url, {
            headers: {
              'Accept': 'application/json',
              'X-API-KEY': birdeyeApiKey,
              'x-chain': 'solana',
            },
          });
          
          console.log(`      → Response status: ${response.status}`);
          const data = await response.json() as { success?: boolean; data?: { value?: string | number } };
          console.log(`      → Response data: ${JSON.stringify(data).substring(0, 200)}`);
          
          if (data.success && data.data && data.data.value !== undefined) {
            const priceUsd = parseFloat(String(data.data.value));
            console.log(`      → Parsed price: $${priceUsd}`);
          } else {
            console.log(`      → No price in response`);
          }
        }
      } catch (e: any) {
        console.log(`      → Error: ${e.message}`);
      }
    }
  }

  // 6) Build positions
  console.log('\n📊 Step 6: Building portfolio positions...');
  const positions: Array<{
    mint: string;
    symbol: string | null;
    name: string | null;
    balance: number;
    price: number;
    value: number | null;
  }> = [];

  // Add SOL
  if (solBalance > 0) {
    positions.push({
      mint: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
      name: 'Solana',
      balance: solBalance,
      price: solPrice || 0,
      value: solValue,
    });
  }

  // Add tokens
  for (const row of tokenRows) {
    const metadata = metadataMap.get(row.mint) || metadataMap.get(row.mint.toLowerCase()) || {};
    const p = priceMap.get(row.mint.toLowerCase()) || 0;
    const value = p > 0 ? row.uiAmount * p : null;
    
    positions.push({
      mint: row.mint,
      symbol: metadata.symbol ?? null,
      name: metadata.name ?? null,
      balance: row.uiAmount,
      price: p,
      value: value,
    });
  }

  // 7) Calculate total and percentages
  console.log('\n📊 Step 7: Calculating portfolio percentages...');
  const totalValue = positions.reduce((sum, p) => sum + (p.value || 0), 0);
  console.log(`   Total portfolio value: $${totalValue.toFixed(2)}`);

  // Sort by value (descending)
  positions.sort((a, b) => (b.value || 0) - (a.value || 0));

  // 8) Display results
  console.log('\n' + '='.repeat(80));
  console.log('📋 PORTFOLIO SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total Value: $${totalValue.toFixed(2)}`);
  console.log(`Total Positions: ${positions.length}`);
  console.log('\nPositions (sorted by value):');
  console.log('-'.repeat(80));
  console.log(
    'Rank'.padEnd(6) +
    'Symbol'.padEnd(12) +
    'Name'.padEnd(25) +
    'Balance'.padEnd(20) +
    'Price'.padEnd(15) +
    'Value'.padEnd(15) +
    '%'
  );
  console.log('-'.repeat(80));

  let rank = 1;
  for (const pos of positions) {
    const percentage = totalValue > 0 ? ((pos.value || 0) / totalValue) * 100 : 0;
    const symbol = pos.symbol || pos.mint.substring(0, 8) + '...';
    const name = (pos.name || pos.mint.substring(0, 20) + '...').substring(0, 23);
    const balance = pos.balance.toLocaleString('en-US', { maximumFractionDigits: 6 });
    const price = pos.price > 0 ? `$${pos.price.toFixed(6)}` : 'N/A';
    const value = pos.value !== null ? `$${pos.value.toFixed(2)}` : 'N/A';
    const pct = `${percentage.toFixed(2)}%`;

    console.log(
      String(rank).padEnd(6) +
      symbol.padEnd(12) +
      name.padEnd(25) +
      balance.padEnd(20) +
      price.padEnd(15) +
      value.padEnd(15) +
      pct
    );
    rank++;
  }

  // 9) Check for required tokens
  console.log('\n' + '='.repeat(80));
  console.log('✅ REQUIRED TOKENS CHECK');
  console.log('='.repeat(80));
  const requiredTokens = ['SOL', 'TNSR', 'PUMP', 'TRUMP', 'BOME'];
  const foundTokens: string[] = [];
  const missingTokens: string[] = [];

  for (const reqToken of requiredTokens) {
    const found = positions.find(p => 
      p.symbol?.toUpperCase() === reqToken.toUpperCase() ||
      (reqToken === 'TRUMP' && p.name?.toUpperCase().includes('TRUMP'))
    );
    
    if (found) {
      foundTokens.push(reqToken);
      console.log(`✅ ${reqToken}: Found - ${found.balance.toFixed(6)} ($${(found.value || 0).toFixed(2)})`);
    } else {
      missingTokens.push(reqToken);
      console.log(`❌ ${reqToken}: MISSING`);
    }
  }

  console.log('\n' + '='.repeat(80));
  if (missingTokens.length === 0) {
    console.log('🎉 SUCCESS: All required tokens found!');
  } else {
    console.log(`⚠️  WARNING: Missing ${missingTokens.length} token(s): ${missingTokens.join(', ')}`);
  }
  console.log('='.repeat(80));

  // 10) Detailed info for missing tokens
  if (missingTokens.length > 0) {
    console.log('\n🔍 Searching for missing tokens by mint address...');
    const knownMints: Record<string, string> = {
      'TNSR': 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6',
      'PUMP': 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
      'TRUMP': '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
      'BOME': 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
    };

    for (const missing of missingTokens) {
      if (knownMints[missing]) {
        const mint = knownMints[missing];
        const found = positions.find(p => p.mint === mint);
        if (found) {
          console.log(`   ⚠️  ${missing} found by mint but with wrong symbol/name:`);
          console.log(`      Mint: ${mint}`);
          console.log(`      Symbol: ${found.symbol || 'N/A'}`);
          console.log(`      Name: ${found.name || 'N/A'}`);
          console.log(`      Balance: ${found.balance}`);
          console.log(`      Value: $${found.value || 0}`);
        } else {
          console.log(`   ❌ ${missing} not found in token accounts (mint: ${mint})`);
        }
      }
    }
  }
}

testPortfolio().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});

