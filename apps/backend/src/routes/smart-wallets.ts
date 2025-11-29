import { Router } from 'express';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { MetricsHistoryRepository } from '../repositories/metrics-history.repository.js';
import { TradeRepository } from '../repositories/trade.repository.js';
import { MetricsCalculatorService } from '../services/metrics-calculator.service.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { TokenPriceService } from '../services/token-price.service.js';
import { PublicKey, Connection } from '@solana/web3.js';
import { SolPriceService } from '../services/sol-price.service.js';
import { supabase, TABLES } from '../lib/supabase.js';
import { isValidSolanaAddress, parseTags } from '../lib/utils.js';
import { HeliusClient } from '../services/helius-client.service.js';
import { TokenMetadataBatchService } from '../services/token-metadata-batch.service.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { HeliusWebhookService } from '../services/helius-webhook.service.js';

// Get project root - when running from apps/backend, go up 2 levels
// When running from root, use current directory
function getProjectRoot(): string {
  const cwd = process.cwd();
  if (cwd.endsWith('apps/backend') || cwd.includes('apps/backend/')) {
    // Running from apps/backend directory
    return join(cwd, '../..');
  }
  // Running from project root
  return cwd;
}

const PROJECT_ROOT = getProjectRoot();

const router = Router();
const smartWalletRepo = new SmartWalletRepository();
const metricsHistoryRepo = new MetricsHistoryRepository();
const tradeRepo = new TradeRepository();
const tokenRepo = new TokenRepository();
const metricsCalculator = new MetricsCalculatorService(
  smartWalletRepo,
  tradeRepo,
  metricsHistoryRepo
);
const tokenPriceService = new TokenPriceService();
const lotMatchingService = new LotMatchingService();
const solPriceService = new SolPriceService();
const heliusClient = new HeliusClient();
const tokenMetadataBatchService = new TokenMetadataBatchService(heliusClient, tokenRepo);
let heliusWebhookService: HeliusWebhookService | null = null;

// Initialize webhook service (if Helius API key is available)
try {
  heliusWebhookService = new HeliusWebhookService();
} catch (error: any) {
  console.warn('⚠️  Helius webhook service not available:', error.message);
}


// GET /api/smart-wallets - List all smart wallets with pagination and filters
router.get('/', async (req, res) => {
  try {
    console.log('📥 GET /api/smart-wallets - Request received');
    console.log('📦 Query params:', JSON.stringify(req.query, null, 2));

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 50;
    const minScore = req.query.minScore ? parseFloat(req.query.minScore as string) : undefined;
    const tags = req.query.tags ? (req.query.tags as string).split(',') : undefined;
    const search = req.query.search as string | undefined;
    const sortBy = req.query.sortBy as 'score' | 'winRate' | 'recentPnl30dUsd' | 'recentPnl30dPercent' | 'totalTrades' | 'lastTradeTimestamp' | 'label' | 'address' | undefined;
    const sortOrder = (req.query.sortOrder as 'asc' | 'desc') || 'desc';

    console.log(`🔍 Fetching wallets - page: ${page}, pageSize: ${pageSize}`);
    const result = await smartWalletRepo.findAll({
      page,
      pageSize,
      minScore,
      tags,
      search,
      sortBy,
      sortOrder,
    });

    console.log(`✅ Found ${result.wallets.length} wallets (total: ${result.total})`);
    
    // DEBUG: Log PnL values for first few wallets
    if (result.wallets && result.wallets.length > 0) {
      console.log(`📊 [Endpoint] Sample PnL values from repository:`);
      result.wallets.slice(0, 5).forEach((wallet: any) => {
        console.log(`   💰 Wallet ${wallet.address}: recentPnl30dBase=${wallet.recentPnl30dBase}, recentPnl30dPercent=${wallet.recentPnl30dPercent}`);
      });
    }
    
    res.json(result);
  } catch (error: any) {
    console.error('❌ Error fetching smart wallets:');
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    console.error('Full error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    });
  }
});

// GET /api/smart-wallets/:id/portfolio/refresh - Fetch live portfolio using Helius RPC (recommended)
// Supports both ID (database ID) and address (wallet address)
router.get('/:id/portfolio/refresh', async (req, res) => {
  try {
    const identifier = req.params.id;
    // Try to find by ID first (if it's a short ID), then by address
    let wallet = await smartWalletRepo.findById(identifier);
    if (!wallet) {
      wallet = await smartWalletRepo.findByAddress(identifier);
    }
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    type Position = {
      tokenId: string;
      token: any;
      balance: number;
      averageBuyPrice: number;
      currentValue: number | null;
      buyCount: number;
      sellCount: number;
    };

    const MIN_USD = 1;
    const positions: Position[] = [];

    // Helius RPC connection
    const rpcUrl =
      process.env.HELIUS_RPC_URL ||
      process.env.HELIUS_API ||
      process.env.SOLANA_RPC_URL ||
      'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    const owner = new PublicKey(wallet.address);

    // 1) Native SOL
    const lamports = await connection.getBalance(owner, 'confirmed');
    const solBalance = lamports / 1e9;
    if (solBalance > 0) {
      const solPrice = await solPriceService.getSolPriceUsd().catch(() => null);
      const value = solPrice ? solBalance * solPrice : null;
      // Show ALL SOL balances, even if value is null or < MIN_USD
      positions.push({
        tokenId: 'SOL',
        token: {
          mintAddress: 'So11111111111111111111111111111111111111112',
          symbol: 'SOL',
          name: 'Solana',
          decimals: 9,
        },
        balance: solBalance,
        averageBuyPrice: solPrice || 0,
        currentValue: value,
        buyCount: 0,
        sellCount: 0,
      });
    }

    // 2) SPL token accounts (parsed) - BOTH classic SPL Token AND Token-2022
    // Classic SPL Token program
    const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    // Token-2022 program (newer standard, used by many tokens including pump.fun tokens)
    const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    
    console.log(`🔍 Fetching token accounts for wallet ${wallet.address}...`);
    
    // Fetch from both programs in parallel
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
    
    // Combine accounts from both programs
    const accounts = [...(parsedClassic.value || []), ...(parsedToken2022.value || [])];
    console.log(`📊 Portfolio refresh: Found ${parsedClassic.value?.length || 0} classic SPL tokens, ${parsedToken2022.value?.length || 0} Token-2022 tokens (total: ${accounts.length})`);
    
    // DEBUG: Log all accounts with details
    if (accounts.length > 0) {
      console.log(`🔍 Raw token accounts details:`);
      accounts.forEach((acc, idx) => {
        const info: any = acc.account?.data?.parsed?.info;
        const mint = info?.mint as string;
        const amount = info?.tokenAmount;
        const uiAmount = Number(amount?.uiAmount || 0);
        const decimals = Number(amount?.decimals || 0);
        const owner = info?.owner as string;
        console.log(`  [${idx + 1}] mint: ${mint?.substring(0, 16)}..., owner: ${owner?.substring(0, 16)}..., uiAmount: ${uiAmount}, decimals: ${decimals}, programId: ${acc.account?.owner?.toString()}`);
      });
    }
    
    const mintSet = new Set<string>();
    const tokenRows: Array<{ mint: string; uiAmount: number; decimals: number }> = [];
    for (const acc of accounts) {
      // getParsedTokenAccountsByOwner already filters by owner, so all accounts belong to wallet
      const info: any = acc.account?.data?.parsed?.info;
      const mint = info?.mint as string;
      const amount = info?.tokenAmount;
      
      // uiAmount can be number or string, normalize to number
      let uiAmount = 0;
      if (amount?.uiAmount !== undefined && amount?.uiAmount !== null) {
        uiAmount = typeof amount.uiAmount === 'string' ? parseFloat(amount.uiAmount) : Number(amount.uiAmount);
      }
      
      const decimals = Number(amount?.decimals || 0);
      const owner = info?.owner as string;
      
      // DEBUG: Log each account being processed
      if (mint) {
        console.log(`  🔍 Processing token account: mint=${mint.substring(0, 16)}..., owner=${owner?.substring(0, 16)}..., uiAmount=${uiAmount}, decimals=${decimals}, rawAmount=${JSON.stringify(amount)}`);
      }
      
      // getParsedTokenAccountsByOwner already filters by owner, so all accounts belong to wallet
      // Just check that we have mint and non-zero balance
      
      // DEBUG: Specific logging for TRUMP and TNSR
      const isTRUMP = mint === '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN';
      const isTNSR = mint === 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6';
      if (isTRUMP || isTNSR) {
        console.log(`  🔍 SPECIAL: ${isTRUMP ? 'TRUMP' : 'TNSR'} token detected!`);
        console.log(`     mint: ${mint}`);
        console.log(`     uiAmount: ${uiAmount} (type: ${typeof uiAmount})`);
        console.log(`     decimals: ${decimals}`);
        console.log(`     rawAmount: ${JSON.stringify(amount)}`);
        console.log(`     will be added: ${mint && uiAmount > 0}`);
      }
      
      if (mint && uiAmount > 0) {
        tokenRows.push({ mint, uiAmount, decimals });
        mintSet.add(mint);
        if (isTRUMP || isTNSR) {
          console.log(`  ✅✅✅ Added ${isTRUMP ? 'TRUMP' : 'TNSR'}: balance=${uiAmount}, decimals=${decimals}`);
        } else {
          console.log(`  ✅ Added token: ${mint.substring(0, 16)}... (balance: ${uiAmount}, decimals: ${decimals})`);
        }
      } else if (mint) {
        if (isTRUMP || isTNSR) {
          console.log(`  ❌❌❌ SKIPPED ${isTRUMP ? 'TRUMP' : 'TNSR'}: uiAmount=${uiAmount}, mint=${mint ? 'OK' : 'MISSING'}`);
        } else {
          console.log(`  ⚠️  Skipped token ${mint.substring(0, 16)}...: zero balance (uiAmount=${uiAmount})`);
        }
      } else {
        console.log(`  ⚠️  Skipped account: no mint address found`);
      }
    }
    
    console.log(`📊 After processing: ${tokenRows.length} tokens with balance > 0 (unique mints: ${mintSet.size})`);
    const mintAddresses = Array.from(mintSet);
    console.log(`🔍 Will fetch metadata for ${mintAddresses.length} unique mints`);

    // Batch token metadata (symbol/name/decimals) and prices
    let metadataMap = new Map<string, { symbol?: string; name?: string; decimals?: number }>();
    let priceMap = new Map<string, number>();
    try {
      if (mintAddresses.length > 0) {
        console.log(`📡 Calling tokenMetadataBatchService.getTokenMetadataBatch for ${mintAddresses.length} tokens...`);
        metadataMap = await tokenMetadataBatchService.getTokenMetadataBatch(mintAddresses);
        console.log(`✅ Metadata fetch completed: got metadata for ${metadataMap.size}/${mintAddresses.length} tokens`);
        // DEBUG: Log first few metadata results
        let logged = 0;
        for (const [mint, meta] of metadataMap.entries()) {
          if (logged < 5) {
            console.log(`  📝 ${mint.substring(0, 16)}...: symbol=${meta.symbol || 'N/A'}, name=${meta.name || 'N/A'}`);
            logged++;
          }
        }
      } else {
        console.log('⚠️  No mint addresses to fetch metadata for');
      }
    } catch (e: any) {
      console.error('❌ Failed to fetch token metadata for live portfolio:', e?.message || e);
      console.error('   Stack:', e?.stack);
    }

    try {
      if (mintAddresses.length > 0) {
        console.log(`📡 Calling tokenPriceService.getTokenPricesBatch for ${mintAddresses.length} tokens...`);
        priceMap = await tokenPriceService.getTokenPricesBatch(mintAddresses);
        console.log(`✅ Price fetch completed: got prices for ${priceMap.size}/${mintAddresses.length} tokens`);
        // DEBUG: Log first few price results
        let logged = 0;
        for (const [mint, price] of priceMap.entries()) {
          if (logged < 5 && price > 0) {
            console.log(`  💵 ${mint.substring(0, 16)}...: $${price}`);
            logged++;
          }
        }
      } else {
        console.log('⚠️  No mint addresses to fetch prices for');
      }
    } catch (e: any) {
      console.error('❌ Failed to fetch token prices for live portfolio:', e?.message || e);
      console.error('   Stack:', e?.stack);
    }
    const MIN_VALUE_USD = 0.1; // Filter out tokens with value < $0.1 USD
    
    for (const row of tokenRows) {
      // Try both original case and lowercase for metadata lookup (metadataMap might use lowercase keys)
      const metadata = metadataMap.get(row.mint) || metadataMap.get(row.mint.toLowerCase()) || {};
      const p = priceMap.get(row.mint.toLowerCase()) || 0;
      const value = p > 0 ? row.uiAmount * p : null;
      
      // Filter out tokens with value < $0.1 USD (scam tokens, dust, etc.)
      if (value !== null && value < MIN_VALUE_USD) {
        console.log(`  ⚠️  Skipped token ${row.mint.substring(0, 16)}...: value $${value.toFixed(4)} < $${MIN_VALUE_USD} (scam/dust filter)`);
        continue;
      }
      
      // DEBUG: Specific logging for TRUMP and TNSR
      const isTRUMP = row.mint === '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN';
      const isTNSR = row.mint === 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6';
      
      if (isTRUMP || isTNSR) {
        console.log(`  💰💰💰 FINAL PROCESSING ${isTRUMP ? 'TRUMP' : 'TNSR'}:`);
        console.log(`     balance: ${row.uiAmount}`);
        console.log(`     price: ${p}`);
        console.log(`     value: ${value}`);
        console.log(`     symbol: ${metadata.symbol || 'N/A'}`);
        console.log(`     name: ${metadata.name || 'N/A'}`);
        console.log(`     metadata found: ${metadataMap.has(row.mint) || metadataMap.has(row.mint.toLowerCase())}`);
      }
      
      // DEBUG: Log each position being added
      console.log(`  💰 Token ${row.mint.substring(0, 16)}...: balance=${row.uiAmount}, price=${p}, value=${value}, symbol=${metadata.symbol || 'N/A'}, name=${metadata.name || 'N/A'}`);
      
      // IMPORTANT: Show tokens with balance > 0, but filter out tokens with value < $0.1 USD
      // If value is null (no price), still show it (might be a legitimate token without price data)
      const position = {
        tokenId: row.mint,
        token: {
          mintAddress: row.mint,
          symbol: metadata.symbol ?? null,
          name: metadata.name ?? null,
          decimals: metadata.decimals ?? row.decimals,
        },
        balance: row.uiAmount,
        averageBuyPrice: p || 0,
        currentValue: value,
        buyCount: 0,
        sellCount: 0,
      };
      
      positions.push(position);
      
      if (isTRUMP || isTNSR) {
        console.log(`  ✅✅✅ Position added to array: ${JSON.stringify(position, null, 2)}`);
      }
    }
    
    console.log(`📊 Total positions after processing: ${positions.length}`);

    // NEW APPROACH: Calculate totalCost from trades and Live PnL
    // 1. Get all buy trades for each token
    const { data: allTrades } = await supabase
      .from(TABLES.TRADE)
      .select('tokenId, side, amountToken, amountBase, priceBasePerToken, meta')
      .eq('walletId', wallet.id)
      .eq('side', 'buy');
    
    // Vytvoř mapu tokenId -> totalCost (součet všech buy trades v base měně)
    const totalCostMap = new Map<string, number>();
    if (allTrades) {
      for (const trade of allTrades) {
        const tokenId = trade.tokenId;
        const amountBase = Number(trade.amountBase || 0);
        const currentCost = totalCostMap.get(tokenId) || 0;
        totalCostMap.set(tokenId, currentCost + amountBase);
      }
    }
    
    // 2. For each position calculate Live PnL
    // Live PnL = currentValue - totalCost (in USD)
    // currentValue = balance * currentPrice (from Birdeye)
    // totalCost = sum of all buy trades in base currency, converted to USD using historical SOL price
    const portfolio = await Promise.all(
      positions.map(async (p) => {
        const totalCostBase = totalCostMap.get(p.tokenId) || 0;
        let totalCostUsd = 0;
        let livePnl = 0;
        let livePnlPercent = 0;
        
        // If we have totalCost in base currency, convert to USD using Binance API (historical SOL price)
        if (totalCostBase > 0 && p.token?.mintAddress) {
          try {
            // Get average historical SOL price from buy trades
            // For simplicity, use current SOL price from Binance (can improve later)
            const { BinancePriceService } = await import('../services/binance-price.service.js');
            const binancePriceService = new BinancePriceService();
            const currentSolPrice = await binancePriceService.getCurrentSolPrice();
            
            // Assume totalCost is in SOL (for most tokens)
            // TODO: Detect baseToken from trades and use correct conversion
            totalCostUsd = totalCostBase * currentSolPrice;
          } catch (error: any) {
            console.warn(`Failed to convert totalCost to USD for token ${p.tokenId}: ${error.message}`);
          }
        }
        
        // Vypočítej Live PnL
        if (p.currentValue !== null && p.currentValue > 0 && totalCostUsd > 0) {
          livePnl = p.currentValue - totalCostUsd;
          livePnlPercent = totalCostUsd > 0 ? (livePnl / totalCostUsd) * 100 : 0;
        }
        
        return {
        ...p,
          totalCost: totalCostUsd, // Total cost v USD
          livePnl, // Live PnL (unrealized) v USD
          livePnlPercent, // Live PnL v %
          // Pro kompatibilitu zachováme staré názvy
          pnl: livePnl,
          pnlPercent: livePnlPercent,
        };
      })
    );
    
    // Seřaď podle currentValue
    portfolio.sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));
    
    const knownTotalUsd = portfolio.reduce((sum, p) => sum + (p.currentValue ?? 0), 0);
    const unknownCount = portfolio.filter(p => p.currentValue == null).length;
    const totalValue = knownTotalUsd;

    // Debug price coverage
    try {
      console.log('🔎 Portfolio refresh summary', {
        wallet: wallet.address,
        items: portfolio.length,
        knownTotalUsd,
        unknownCount,
      });
      for (const p of portfolio) {
        console.log('  • Portfolio item', {
          mint: p.token?.mintAddress || p.tokenId,
          balance: p.balance,
          priceUsd: p.averageBuyPrice,
          valueUsd: p.currentValue,
          hasPrice: p.currentValue != null,
        });
      }
    } catch {}

    // Return in the same structure as existing /portfolio endpoint for UI compatibility
    const now = new Date().toISOString();
    const responsePayload = {
      totalValue,
      knownTotalUsd,
      unknownCount,
      portfolio, // open positions analogue for UI
      openPositions: portfolio,
      closedPositions: [],
      source: 'birdeye-api',
      lastUpdated: now,
      cached: false,
    };

    // Save as baseline snapshot (upsert per wallet)
    try {
      const { data, error } = await supabase
        .from('PortfolioBaseline')
        .upsert({
          walletId: wallet.id,
          updatedAt: now,
          totalValueUsd: totalValue,
          holdings: responsePayload,
        }, { onConflict: 'walletId' });
      
      if (error) {
        console.warn('⚠️ Failed to upsert PortfolioBaseline:', error.message);
      } else {
        console.log(`✅ PortfolioBaseline saved for wallet ${wallet.id} (${portfolio.length} positions, total: $${totalValue.toFixed(2)})`);
      }
    } catch (e) {
      console.warn('⚠️ Failed to upsert PortfolioBaseline:', (e as any)?.message || e);
    }

    res.json(responsePayload);
  } catch (error: any) {
    console.error('❌ Error fetching live portfolio via Helius RPC:', error?.message || error);
    res.status(500).json({ error: 'Helius error', message: error?.message || 'Unknown error' });
  }
});

// GET /api/smart-wallets/:id - Get wallet details
// Supports both ID (database ID) and address (wallet address)
router.get('/:id', async (req, res) => {
  try {
    const identifier = req.params.id;
    console.log(`📥 GET /api/smart-wallets/:id - Request received for: ${identifier}`);
    
    // Try to find by ID first (if it's a short ID), then by address
    let wallet = await smartWalletRepo.findById(identifier);
    if (!wallet) {
      // If not found by ID, try by address
      wallet = await smartWalletRepo.findByAddress(identifier);
    }
    
    if (!wallet) {
      console.log(`❌ Wallet not found: ${identifier}`);
      return res.status(404).json({ error: 'Wallet not found' });
    }

    console.log(`✅ Wallet found, fetching metrics history and advanced stats`);
    // Get metrics history for charts
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const metricsHistory = await metricsHistoryRepo.findByWalletId(wallet.id, thirtyDaysAgo);
    const recentPnl30dBase = Number(wallet.recentPnl30dBase || wallet.recentPnl30dUsd || 0); // PnL v SOL

    console.log(`✅ Returning wallet details with ${metricsHistory.length} history records`);
    res.json({
      ...wallet,
      recentPnl30dBase, // PnL v SOL (změněno z recentPnl30dUsd)
      metricsHistory,
      advancedStats: wallet.advancedStats ?? null,
    });
  } catch (error: any) {
    console.error('❌ Error fetching wallet details:');
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    });
  }
});

// POST /api/smart-wallets - Create new smart wallet
router.post('/', async (req, res) => {
  try {
    console.log('📥 POST /api/smart-wallets - Request received');
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));

    const { address, label, tags } = req.body;

    if (!address) {
      console.log('❌ Validation error: Address is required');
      return res.status(400).json({ error: 'Address is required' });
    }

    console.log(`🔍 Checking if wallet exists: ${address}`);
    // Check if wallet already exists
    const existing = await smartWalletRepo.findByAddress(address);
    if (existing) {
      console.log(`⚠️  Wallet already exists: ${address}`);
      return res.status(409).json({ error: 'Wallet already exists' });
    }

    console.log(`✅ Wallet not found, creating new wallet: ${address}`);
    const wallet = await smartWalletRepo.create({
      address,
      label,
      tags,
    });

    console.log(`✅ Wallet created successfully: ${wallet.id}`);

    // Aktualizuj webhook s novou wallet adresou
    if (heliusWebhookService) {
      try {
        const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
        const allAddresses = allWallets.wallets.map(w => w.address);
        await heliusWebhookService.ensureWebhookForAllWallets(allAddresses);
        console.log(`✅ Webhook updated with ${allAddresses.length} wallets`);
      } catch (error: any) {
        console.warn(`⚠️  Failed to update webhook: ${error.message}`);
        // Don't want wallet creation to fail due to webhook error
      }
    }

    res.status(201).json(wallet);
  } catch (error: any) {
    console.error('❌ Error creating smart wallet:');
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    console.error('Full error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    });
  }
});

// POST /api/smart-wallets/sync - Synchronize wallets from wallets.csv file in project root
router.post('/sync', async (req, res) => {
  try {
    console.log('📥 POST /api/smart-wallets/sync - Synchronizing wallets from wallets.csv');

    const csvFilePath = join(PROJECT_ROOT, 'wallets.csv');
    console.log(`📂 Project root: ${PROJECT_ROOT}`);
    console.log(`📂 Reading CSV file from: ${csvFilePath}`);

    let csvContent: string;
    try {
      csvContent = readFileSync(csvFilePath, 'utf-8');
    } catch (fileError: any) {
      if (fileError.code === 'ENOENT') {
        return res.status(404).json({ 
          error: 'wallets.csv file not found',
          details: `Expected file at: ${csvFilePath}`,
        });
      }
      throw fileError;
    }

    // Parse CSV - support both comma and semicolon delimiters
    let records: any[];
    try {
      // Remove BOM if present
      if (csvContent.charCodeAt(0) === 0xFEFF) {
        csvContent = csvContent.slice(1);
      }
      
      // Try to detect delimiter (semicolon or comma)
      const lines = csvContent.split('\n');
      let headerLine = '';
      let headerLineIndex = -1;
      
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed && !trimmed.match(/^[;\s,]+$/)) {
          const lowerTrimmed = trimmed.toLowerCase();
          if (lowerTrimmed.includes('name') || lowerTrimmed.includes('label') || 
              lowerTrimmed.includes('address') || lowerTrimmed.includes('wallet')) {
            headerLine = trimmed;
            headerLineIndex = i;
            break;
          }
        }
      }
      
      if (!headerLine || headerLineIndex === -1) {
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (trimmed && !trimmed.match(/^[;\s,]+$/)) {
            headerLine = trimmed;
            headerLineIndex = i;
            break;
          }
        }
      }
      
      if (!headerLine || headerLineIndex === -1) {
        return res.status(400).json({ 
          error: 'Could not find header row in CSV file',
          details: 'Please ensure your CSV has a header row with column names'
        });
      }
      
      const hasSemicolon = headerLine.includes(';');
      const delimiter = hasSemicolon ? ';' : ',';
      
      console.log(`📊 Detected delimiter: ${delimiter === ';' ? 'semicolon' : 'comma'}`);
      console.log(`📊 Header line: ${headerLine}`);
      
      const cleanedLines = lines.slice(headerLineIndex);
      const cleanedContent = cleanedLines.join('\n');
      
      records = parse(cleanedContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        delimiter: delimiter,
      });
      
      console.log(`📊 Parsed ${records.length} records from wallets.csv`);
    } catch (parseError: any) {
      console.error('❌ CSV parse error:', parseError);
      return res.status(400).json({ 
        error: 'Invalid CSV format',
        details: parseError.message,
      });
    }

    if (records.length === 0) {
      return res.status(400).json({ error: 'CSV file is empty' });
    }

    // Validate and prepare wallets
    const wallets: Array<{
      address: string;
      label?: string | null;
      tags?: string[];
    }> = [];
    const validationErrors: Array<{ row: number; address: string; error: string }> = [];

    records.forEach((row, index) => {
      const rowNum = index + 2; // +2 because index is 0-based and CSV has header
      
      // Support Name (new) or Label (old) for backward compatibility
      const label = row.name || row.Name || row.NAME || 
                    row.label || row.Label || row.LABEL || null;
      const address = row.address || row.Address || row.ADDRESS || 
                      row.wallet || row.Wallet || row.WALLET || '';
      const tags = (row.tags || row.Tags || row.TAGS) ? parseTags(row.tags || row.Tags || row.TAGS) : undefined;

      if (!address) {
        validationErrors.push({
          row: rowNum,
          address: '',
          error: 'Address is required',
        });
        return;
      }

      const trimmedAddress = address.trim();
      if (!isValidSolanaAddress(trimmedAddress)) {
        validationErrors.push({
          row: rowNum,
          address: trimmedAddress,
          error: 'Invalid Solana address',
        });
        return;
      }

      wallets.push({
        address: trimmedAddress,
        label: label ? label.trim() : null,
        tags: tags || [],
      });
    });

    if (validationErrors.length > 0) {
      console.log(`⚠️  Found ${validationErrors.length} validation errors, continuing with ${wallets.length} valid wallets`);
    }

    if (wallets.length === 0) {
      return res.status(400).json({ 
        error: 'No valid wallets to import',
        validationErrors,
      });
    }

    console.log(`✅ Validated ${wallets.length} wallets, synchronizing...`);

    // Získej adresy z CSV
    const csvAddresses = new Set(wallets.map(w => w.address.toLowerCase()));

    // Získej všechny existující walletky z DB
    const allWalletsResult = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
    const existingWallets = allWalletsResult.wallets || [];
    
    // Najdi walletky, které jsou v DB, ale nejsou v CSV - ty odstraníme
    const walletsToRemove = existingWallets.filter(w => 
      !csvAddresses.has(w.address.toLowerCase())
    );

    // Odstraň walletky, které nejsou v CSV
    let removedCount = 0;
    if (walletsToRemove.length > 0) {
      console.log(`🗑️  Removing ${walletsToRemove.length} wallets that are not in CSV...`);
      for (const wallet of walletsToRemove) {
        try {
          await smartWalletRepo.delete(wallet.id);
          removedCount++;
        } catch (error: any) {
          console.error(`❌ Error removing wallet ${wallet.address}:`, error.message);
        }
      }
      console.log(`✅ Removed ${removedCount} wallets`);
    }

    // Batch create wallets (přidá nové a přeskočí existující)
    const result = await smartWalletRepo.createBatch(wallets);

    console.log(`✅ Synchronization completed: ${result.created.length} created, ${result.errors.length} errors, ${removedCount} removed`);

    // Aktualizuj webhook se všemi wallet adresami
    if (heliusWebhookService && wallets.length > 0) {
      try {
        const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
        const allAddresses = allWallets.wallets.map(w => w.address);
        await heliusWebhookService.ensureWebhookForAllWallets(allAddresses);
        console.log(`✅ Webhook updated with ${allAddresses.length} wallets after sync`);
      } catch (error: any) {
        console.warn(`⚠️  Failed to update webhook after sync: ${error.message}`);
        // Nechceme, aby selhala synchronizace kvůli webhook chybě
      }
    }

    res.status(200).json({
      success: true,
      total: wallets.length,
      created: result.created.length,
      removed: removedCount,
      errors: result.errors.length, // Počet chyb (číslo)
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
      // Detailní data pro debugging (volitelné)
      createdWallets: result.created,
      errorDetails: result.errors, // Pole objektů s detaily chyb
    });
  } catch (error: any) {
    console.error('❌ Error synchronizing wallets from CSV:');
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    res.status(500).json({
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
    });
  }
});

// POST /api/smart-wallets/setup-webhook - Setup Helius webhook for all tracked wallets
router.post('/setup-webhook', async (req, res) => {
  try {
    if (!heliusWebhookService) {
      return res.status(503).json({ 
        error: 'Webhook service not available',
        message: 'HELIUS_API_KEY or HELIUS_WEBHOOK_URL not configured'
      });
    }

    console.log('📥 POST /api/smart-wallets/setup-webhook - Setting up webhook for all wallets');

    // Získej všechny wallet adresy
    const allWallets = await smartWalletRepo.findAll({ page: 1, pageSize: 10000 });
    const allAddresses = allWallets.wallets.map(w => w.address);

    if (allAddresses.length === 0) {
      return res.status(400).json({ error: 'No wallets found to setup webhook for' });
    }

    console.log(`🔧 Setting up webhook for ${allAddresses.length} wallets...`);

    // Vytvoř nebo aktualizuj webhook - nahradit všechny existující adresy všemi adresami z DB
    const webhookId = await heliusWebhookService.ensureWebhookForAllWallets(allAddresses, true);

    res.status(200).json({
      success: true,
      webhookId,
      walletCount: allAddresses.length,
      message: `Webhook setup for ${allAddresses.length} wallets`,
    });
  } catch (error: any) {
    console.error('❌ Error setting up webhook:', error);
    res.status(500).json({
      error: 'Failed to setup webhook',
      message: error?.message || 'Unknown error',
    });
  }
});

// GET /api/smart-wallets/:id/portfolio - Get portfolio positions for a wallet
// Supports both ID (database ID) and address (wallet address)
// Uses cache (10 minutes) - pokud je cache starší než 10 minut, aktualizuje ceny z Birdeye
router.get('/:id/portfolio', async (req, res) => {
  try {
    const identifier = req.params.id;
    const forceRefresh = req.query.forceRefresh === 'true'; // Ruční aktualizace
    
    // Try to find by ID first (if it's a short ID), then by address
    let wallet = await smartWalletRepo.findById(identifier);
    if (!wallet) {
      wallet = await smartWalletRepo.findByAddress(identifier);
    }
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    
    // Zkontroluj cache v PortfolioBaseline
    const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minut
    let shouldRefresh = forceRefresh;
    let cachedData: any = null;
    
    if (!forceRefresh) {
      const { data: baseline } = await supabase
        .from('PortfolioBaseline')
        .select('*')
        .eq('walletId', wallet.id)
        .single();
      
      if (baseline && baseline.updatedAt) {
        const cacheAge = Date.now() - new Date(baseline.updatedAt).getTime();
        if (cacheAge < CACHE_DURATION_MS) {
          // Cache je ještě platný
          cachedData = baseline;
          shouldRefresh = false;
          console.log(`📦 Using cached portfolio data (age: ${Math.round(cacheAge / 1000)}s)`);
        } else {
          console.log(`⏰ Cache expired (age: ${Math.round(cacheAge / 1000)}s), refreshing...`);
          shouldRefresh = true;
        }
      } else {
        shouldRefresh = true;
      }
    }
    
    // Pokud máme platný cache a není to force refresh, vrať cache
    if (cachedData && !shouldRefresh) {
      const cachedHoldings = cachedData.holdings || {};
      // Filtruj closed positions z cache - pouze ty s platným HOLD time
      const cachedClosedPositions = (cachedHoldings.closedPositions || []).filter((p: any) => {
        return p.holdTimeMinutes !== null && p.holdTimeMinutes !== undefined && p.holdTimeMinutes > 0;
      });
      return res.json({
        portfolio: cachedHoldings.portfolio || cachedHoldings.openPositions || [],
        openPositions: cachedHoldings.openPositions || cachedHoldings.portfolio || [],
        closedPositions: cachedClosedPositions,
        lastUpdated: cachedData.updatedAt,
        cached: true,
      });
    }
    
    // Jinak aktualizuj z Birdeye API
    console.log(`🔄 Refreshing portfolio prices from Birdeye API...`);

    // OPTIMALIZACE: Použij precomputed portfolio z PortfolioBaseline (rychlé)
    // Pokud není k dispozici nebo je starý, použij closed positions z ClosedLot (precomputed)
    // Nepočítáme pozice on-demand z trades - to je pomalé!
    console.log('📊 Loading precomputed portfolio positions...');
    
    // Zkus načíst closed positions z ClosedLot (precomputed worker/cron)
    const { data: closedLots } = await supabase
      .from('ClosedLot')
      .select('*')
      .eq('walletId', wallet.id)
      .order('exitTime', { ascending: false })
      .limit(1000); // Limit pro rychlost
    
    // Get all trades for this wallet with token info (pouze pro open positions)
    const allTrades = await tradeRepo.findByWalletId(wallet.id, {
      page: 1,
      pageSize: 10000, // Get all trades for open positions calculation
    });

    // Calculate portfolio positions
    const portfolioMap = new Map<string, {
      tokenId: string;
      token: any;
      totalBought: number;
      totalSold: number;
      balance: number;
      totalInvested: number; // Total invested in USD (for backward compatibility)
      totalSoldValue: number; // Total value of sold tokens in USD (for backward compatibility)
      totalCostBase: number; // Total cost in base currency (SOL/USDC/USDT) from BUY trades
      totalProceedsBase: number; // Total proceeds in base currency (SOL/USDC/USDT) from SELL trades
      averageBuyPrice: number;
      buyCount: number;
      sellCount: number; // Počet SELL trades (uzavírají pozici)
      removeCount: number; // Počet REM trades (snižují balance, ale neuzavírají pozici)
      lastBuyPrice: number;
      lastSellPrice: number;
      firstBuyTimestamp: Date | null;
      lastSellTimestamp: Date | null;
      baseToken: string; // Base token used (SOL, USDC, USDT)
    }>();

    for (const trade of allTrades.trades) {
      const tokenId = trade.tokenId;
      // Handle both 'Token' (capital) and 'token' (lowercase) for compatibility
      const token = (trade as any).Token || (trade as any).token || null;
      const tradeTimestamp = new Date(trade.timestamp);
      const valueUsd = Number(trade.valueUsd || 0);
      
      if (!portfolioMap.has(tokenId)) {
        portfolioMap.set(tokenId, {
          tokenId,
          token: token, // Store token info
          totalBought: 0,
          totalSold: 0,
          balance: 0,
          totalInvested: 0,
          totalSoldValue: 0,
          totalCostBase: 0, // Total cost in base currency
          totalProceedsBase: 0, // Total proceeds in base currency
          averageBuyPrice: 0,
          buyCount: 0,
          sellCount: 0,
          removeCount: 0, // Počet REM trades (snižují balance, ale neuzavírají pozici)
          lastBuyPrice: 0,
          lastSellPrice: 0,
          firstBuyTimestamp: null,
          lastSellTimestamp: null,
          baseToken: 'SOL', // Default to SOL
        });
      }

      const position = portfolioMap.get(tokenId)!;
      const amount = Number(trade.amountToken);
      const price = Number(trade.priceBasePerToken);
      const amountBase = Number(trade.amountBase || 0);
      const value = amount * price;

      // Get base token from trade meta
      const baseToken = (trade as any).meta?.baseToken || 'SOL';
      position.baseToken = baseToken;

      // Handle all trade types: buy, sell, add, remove
      if (trade.side === 'buy' || trade.side === 'add') {
        position.totalBought += amount;
        position.balance += amount;
        position.totalInvested += valueUsd || value;
        position.totalCostBase += amountBase; // Add to total cost in base currency
        position.buyCount++;
        position.lastBuyPrice = price;
        if (!position.firstBuyTimestamp || tradeTimestamp < position.firstBuyTimestamp) {
          position.firstBuyTimestamp = tradeTimestamp;
        }
      } else if (trade.side === 'sell') {
        // SELL uzavírá pozici → closed position
        position.totalSold += amount;
        position.balance -= amount;
        position.sellCount++;
        position.lastSellPrice = price;
        position.totalSoldValue += valueUsd || value;
        position.totalProceedsBase += amountBase; // Add to total proceeds in base currency
        if (!position.lastSellTimestamp || tradeTimestamp > position.lastSellTimestamp) {
          position.lastSellTimestamp = tradeTimestamp;
        }
      } else if (trade.side === 'remove') {
        // REM jen snižuje balance, ale neuzavírá pozici → stále open position (pokud balance > 0)
        position.totalSold += amount;
        position.balance -= amount;
        position.removeCount++;
        position.totalSoldValue += valueUsd || value;
        position.totalProceedsBase += amountBase; // REM také přispívá k proceeds (je to prodej)
        // REM neaktualizuje lastSellTimestamp (není to uzavření pozice)
      }
      
      // Debug logging for balance calculation
      if (trade.side === 'buy' || trade.side === 'sell' || trade.side === 'add' || trade.side === 'remove') {
        console.log(`   Trade ${trade.side}: tokenId=${tokenId}, amount=${amount}, balance=${position.balance}, buyCount=${position.buyCount}, sellCount=${position.sellCount}, removeCount=${position.removeCount || 0}`);
      }
    }

    // Fetch current token data from database for all unique tokenIds
    const uniqueTokenIds = Array.from(portfolioMap.keys());
    const { data: tokens, error: tokensError } = await supabase
      .from(TABLES.TOKEN)
      .select('*')
      .in('id', uniqueTokenIds);

    if (tokensError) {
      console.warn('⚠️ Failed to fetch token data:', tokensError.message);
    }

    // Create a map of tokenId -> current token data
    const tokenDataMap = new Map<string, any>();
    (tokens || []).forEach((token: any) => {
      tokenDataMap.set(token.id, token);
    });
    
    // DŮLEŽITÉ: Enrich token metadata pro tokeny bez symbol/name nebo s garbage symboly
    const tokensToEnrich: string[] = [];
    const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;
    const isGarbageSymbol = (symbol: string | null | undefined, mintAddress?: string): boolean => {
      if (!symbol) return false;
      const sym = symbol.trim();
      if (!sym) return false;
      if (sym.length > 15 && BASE58_REGEX.test(sym)) return true;
      if (sym.includes('...')) return true;
      if (mintAddress && sym.toLowerCase() === mintAddress.toLowerCase()) return true;
      return false;
    };
    
    // Najdi tokeny, které potřebují enrich
    for (const token of (tokens || [])) {
      const hasValidSymbol = token.symbol && !isGarbageSymbol(token.symbol, token.mintAddress);
      const hasValidName = !!token.name;
      if (!hasValidSymbol && !hasValidName && token.mintAddress) {
        tokensToEnrich.push(token.mintAddress);
      }
    }
    
    // Enrich tokeny bez symbol/name
    if (tokensToEnrich.length > 0) {
      try {
        console.log(`   🔍 Enriching ${tokensToEnrich.length} tokens with missing/garbage symbols...`);
        const { TokenMetadataBatchService } = await import('../services/token-metadata-batch.service.js');
        const tokenMetadataBatchService = new TokenMetadataBatchService(heliusClient, tokenRepo);
        const enrichedMetadata = await tokenMetadataBatchService.getTokenMetadataBatch(tokensToEnrich);
        
        // Aktualizuj tokenDataMap s novými metadaty
        enrichedMetadata.forEach((metadata, mintAddress) => {
          const tokenId = Array.from(tokenDataMap.keys()).find(tid => {
            const t = tokenDataMap.get(tid);
            return t?.mintAddress?.toLowerCase() === mintAddress.toLowerCase();
          });
          if (tokenId) {
            const token = tokenDataMap.get(tokenId);
            if (token) {
              token.symbol = metadata.symbol || token.symbol;
              token.name = metadata.name || token.name;
              token.decimals = metadata.decimals ?? token.decimals;
            }
          }
        });
        console.log(`   ✅ Enriched ${enrichedMetadata.size} tokens`);
      } catch (error: any) {
        console.warn(`   ⚠️  Failed to enrich token metadata: ${error.message}`);
      }
    }

    // Get current prices for all tokens with mint addresses
    const tokensWithMintAddresses = Array.from(portfolioMap.values())
      .map(position => {
        const token = tokenDataMap.get(position.tokenId) || position.token;
        return {
          tokenId: position.tokenId,
          mintAddress: token?.mintAddress,
        };
      })
      .filter(t => t.mintAddress);

    // Fetch prices ONLY for open positions (balance > 0)
    // Closed positions don't need current prices
    const openPositionsMints = Array.from(portfolioMap.values())
      .filter(p => p.balance > 0)
      .map(position => {
        const token = tokenDataMap.get(position.tokenId) || position.token;
        return token?.mintAddress;
      })
      .filter(Boolean) as string[];

    const mintAddresses = openPositionsMints;
    let currentPrices = new Map<string, number>();
    
    // Fetch prices ONLY if we have open positions
    if (mintAddresses.length > 0) {
      console.log(`📡 Fetching prices for ${mintAddresses.length} open positions...`);
      currentPrices = await tokenPriceService.getTokenPricesBatch(mintAddresses);
      console.log(`✅ Got prices for ${currentPrices.size}/${mintAddresses.length} tokens`);
    } else {
      console.log('✅ No open positions, skipping price fetch');
    }
    
    const priceMap = new Map<string, number>();
    tokensWithMintAddresses.forEach(({ tokenId, mintAddress }) => {
      const price = currentPrices.get(mintAddress!.toLowerCase());
      if (price !== undefined) {
        priceMap.set(tokenId, price);
      }
    });

    // Vypočítej náklady pomocí FIFO metody (First In First Out)
    // Získej všechny trades pro každý token seřazené podle času
    const { data: allTradesForFifo } = await supabase
      .from(TABLES.TRADE)
      .select('tokenId, side, amountToken, amountBase, timestamp')
      .eq('walletId', wallet.id)
      .order('timestamp', { ascending: true });
    
    // FIFO: Pro každý token simuluj queue nákupů a prodejů
    // Náklady pro aktuální balance = součet nákladů zbývajících tokenů podle FIFO
    const fifoCostMap = new Map<string, number>();
    
    if (allTradesForFifo) {
      // Skupina trades podle tokenId
      const tradesByToken = new Map<string, typeof allTradesForFifo>();
      for (const trade of allTradesForFifo) {
        const tokenId = trade.tokenId;
        if (!tradesByToken.has(tokenId)) {
          tradesByToken.set(tokenId, []);
        }
        tradesByToken.get(tokenId)!.push(trade);
      }
      
      // Pro každý token aplikuj FIFO
      for (const [tokenId, trades] of tradesByToken.entries()) {
        // Queue nákupů: [{ amount: number, costBase: number }]
        const buyQueue: Array<{ amount: number; costBase: number }> = [];
        let currentBalance = 0;
        
        for (const trade of trades) {
          const amount = Number(trade.amountToken || 0);
          const costBase = Number(trade.amountBase || 0);
          
          if (trade.side === 'buy' || trade.side === 'add') {
            // Přidej do queue
            buyQueue.push({ amount, costBase });
            currentBalance += amount;
          } else if (trade.side === 'remove' || trade.side === 'sell') {
            // Odeber z queue podle FIFO
            let remainingToRemove = amount;
            while (remainingToRemove > 0 && buyQueue.length > 0) {
              const firstBuy = buyQueue[0];
              const originalAmount = firstBuy.amount;
              const costPerToken = firstBuy.costBase / originalAmount;
              
              if (firstBuy.amount <= remainingToRemove) {
                // Odeber celý první nákup
                remainingToRemove -= firstBuy.amount;
                buyQueue.shift();
              } else {
                // Odeber část prvního nákupu - sníž i costBase proporcionálně
                const removedAmount = remainingToRemove;
                firstBuy.amount -= removedAmount;
                firstBuy.costBase -= removedAmount * costPerToken;
                remainingToRemove = 0;
              }
            }
            currentBalance -= amount;
          }
        }
        
        // Náklady pro aktuální balance = součet nákladů zbývajících tokenů v queue
        // Každý nákup v queue už má správně upravené costBase po REM/SELL
        const costForCurrentBalance = buyQueue.reduce((sum, buy) => {
          return sum + buy.costBase;
        }, 0);
        
        fifoCostMap.set(tokenId, costForCurrentBalance);
      }
    }
    
    // Import BinancePriceService pro konverzi SOL na USD
    const { BinancePriceService } = await import('../services/binance-price.service.js');
    const binancePriceService = new BinancePriceService();
    const currentSolPrice = await binancePriceService.getCurrentSolPrice().catch(() => null);
    
    // Create a map of closed lots by tokenId for closed positions PnL calculation
    // This ensures consistency with rolling stats (both use closed lots)
    const closedLotsByToken = new Map<string, typeof closedLots>();
    if (closedLots) {
      for (const lot of closedLots) {
        const tokenId = lot.tokenId;
        if (!closedLotsByToken.has(tokenId)) {
          closedLotsByToken.set(tokenId, []);
        }
        closedLotsByToken.get(tokenId)!.push(lot);
      }
    }

    // Calculate average buy price and finalize positions with current token data and prices
    const portfolio = Array.from(portfolioMap.values())
      .map(position => {
        // Use current token data from database instead of stale data from trades
        const currentToken = tokenDataMap.get(position.tokenId) || position.token;
        
        position.averageBuyPrice = position.totalBought > 0 
          ? position.totalInvested / position.totalBought 
          : 0;
        
        // Get current price for this token
        const currentPrice = priceMap.get(position.tokenId);
        
        // Calculate current value and PnL based on current market price
        const currentValue = currentPrice && position.balance > 0
          ? currentPrice * position.balance
          : position.balance * position.averageBuyPrice; // Fallback to average buy price if no current price
        
        // Vypočítej Live PnL pomocí FIFO metody (First In First Out)
        // Náklady pro aktuální balance = součet nákladů zbývajících tokenů podle FIFO
        const costForCurrentBalance = fifoCostMap.get(position.tokenId) || 0;
        
        let totalCostUsd = 0;
        let livePnl = 0;
        let livePnlBase = 0; // Live PnL v base měně (SOL/USDC/USDT)
        let livePnlPercent = 0;
        
        // Převod nákladů pro aktuální balance z base měny na USD
        if (costForCurrentBalance > 0 && currentSolPrice) {
          // Předpokládáme, že cost je v SOL (pro většinu tokenů)
          // TODO: Detekovat baseToken z trades a použít správnou konverzi
          totalCostUsd = costForCurrentBalance * currentSolPrice;
        } else if (position.totalInvested > 0 && position.totalBought > 0) {
          // Fallback: použij průměrný nákupní kurz v USD (pokud FIFO selže)
          const averageCostUsd = position.totalInvested / position.totalBought;
          totalCostUsd = position.balance * averageCostUsd;
        }
        
        // Vypočítej Live PnL v USD
        if (currentValue > 0 && totalCostUsd > 0) {
          livePnl = currentValue - totalCostUsd;
          livePnlPercent = totalCostUsd > 0 ? (livePnl / totalCostUsd) * 100 : 0;
        }
        
        // Vypočítej Live PnL v base měně (SOL) - převedeme z USD pomocí aktuální ceny SOL
        if (livePnl !== 0 && currentSolPrice && currentSolPrice > 0) {
          livePnlBase = livePnl / currentSolPrice;
        } else if (costForCurrentBalance > 0 && currentPrice) {
          // Alternativní výpočet: currentValue v base měně - costForCurrentBalance
          // currentValue je v USD, převedeme na SOL a porovnáme s costForCurrentBalance
          const currentValueBase = currentSolPrice && currentSolPrice > 0 
            ? currentValue / currentSolPrice 
            : 0;
          livePnlBase = currentValueBase - costForCurrentBalance;
        }
        
        // Pro kompatibilitu zachováme staré výpočty
        const pnl = currentValue - position.totalInvested;
        const pnlPercent = position.totalInvested > 0
          ? (pnl / position.totalInvested) * 100
          : 0;
        
        // Treat small negative balance (rounding errors) as 0 for closed positions
        // Declare once at the beginning and use everywhere
        const normalizedBalance = position.balance < 0 && Math.abs(position.balance) < 0.0001 ? 0 : position.balance;
        
        // Calculate hold time for closed positions (from first BUY to last SELL)
        // If BUY and SELL are at the same time, holdTimeMinutes will be 0, which is valid
        let holdTimeMinutes: number | null = null;
        if (position.firstBuyTimestamp && position.lastSellTimestamp && normalizedBalance <= 0) {
          const holdTimeMs = position.lastSellTimestamp.getTime() - position.firstBuyTimestamp.getTime();
          holdTimeMinutes = Math.round(holdTimeMs / (1000 * 60));
          // Allow 0 minutes (same timestamp) - it's still a valid closed position
          if (holdTimeMinutes < 0) {
            holdTimeMinutes = null; // Invalid if SELL is before BUY
          }
        }

        // Calculate PnL for closed positions - jednotný princip: realizedPnl z ClosedLot (v SOL)
        // DŮLEŽITÉ: PnL se počítá POUZE z ClosedLot (jednotný princip)
        // ClosedLot se vytváří v worker queue a metrics cron před výpočtem metrik
        // Pokud ClosedLot neexistují, PnL = 0 (žádný fallback!)
        // DŮLEŽITÉ: PnL je nyní v SOL/base měně, ne v USD
        let realizedPnlBase: number | null = null;
        let realizedPnlPercent: number | null = null;
        
        if (normalizedBalance <= 0) {
          // Najdi VŠECHNY closed lots pro tento token (může jich být více - více buy/sell cyklů)
          const closedLotsForToken = (closedLots || []).filter((lot: any) => 
            lot.tokenId === position.tokenId && 
            lot.exitTime && 
            new Date(lot.exitTime) <= new Date()
          );
          
          // Sečti všechny realizedPnl z closed lots pro tento token (v SOL/base měně)
          // POUZE z ClosedLot - žádný fallback!
          if (closedLotsForToken.length > 0) {
            const totalRealizedPnl = closedLotsForToken.reduce((sum: number, lot: any) => {
              // Použij realizedPnl z ClosedLot (v SOL/base měně)
              if (lot.realizedPnl !== null && lot.realizedPnl !== undefined) {
                return sum + Number(lot.realizedPnl);
              }
              return sum;
            }, 0);
            
            // Použij fixní realizedPnl z ClosedLot (v SOL, nemění se s cenou SOL)
            // Pokud totalRealizedPnl = 0, realizedPnlBase zůstane null (žádný fallback!)
            if (totalRealizedPnl !== 0) {
              realizedPnlBase = totalRealizedPnl; // PnL v SOL
              realizedPnlPercent = position.totalCostBase > 0
                ? (realizedPnlBase / position.totalCostBase) * 100
                : null;
              
              if (wallet.id) {
                console.log(`   💰 [Portfolio] Position: tokenId=${position.tokenId}, using FIXED realizedPnl=${realizedPnlBase.toFixed(4)} SOL from ${closedLotsForToken.length} ClosedLot(s)`);
              }
            } else {
              // ClosedLot existují, ale realizedPnl = 0 → PnL = 0 (žádný fallback!)
              realizedPnlBase = 0;
              realizedPnlPercent = 0;
            }
          } else {
            // Neexistují ClosedLot → PnL = 0 (žádný fallback!)
            realizedPnlBase = 0;
            realizedPnlPercent = 0;
          }
        }

        // Only include positions with balance > 0 or with trades
        // normalizedBalance is already declared above
        
        if (normalizedBalance > 0 || position.buyCount > 0 || position.sellCount > 0) {
          return {
            ...position,
            token: currentToken, // Use current token data
            balance: Math.max(0, normalizedBalance), // Ensure non-negative (treat small negatives as 0)
            currentPrice: currentPrice || null, // Current market price
            currentValue, // Current value in USD
            totalCost: totalCostUsd, // Total cost v USD (z trades)
            livePnl, // Live PnL (unrealized) v USD
            livePnlBase, // Live PnL (unrealized) v base měně (SOL/USDC/USDT)
            livePnlPercent, // Live PnL v %
            // Pro kompatibilitu zachováme staré názvy
            pnl: livePnl || pnl, // Profit/Loss in USD (for open positions)
            pnlPercent: livePnlPercent || pnlPercent, // Profit/Loss percentage (for open positions)
            holdTimeMinutes, // Hold time in minutes (for closed positions) - from first BUY to last SELL
            realizedPnlBase, // Realized PnL in SOL/base currency (primární hodnota)
            realizedPnlPercent, // Realized PnL percent
            // Pro kompatibilitu s frontendem zachováme staré názvy
            closedPnl: realizedPnlBase, // Alias pro realizedPnlBase (deprecated, použij realizedPnlBase)
            closedPnlBase: realizedPnlBase, // Alias pro realizedPnlBase (deprecated, použij realizedPnlBase)
            closedPnlPercent: realizedPnlPercent, // Alias pro realizedPnlPercent (deprecated, použij realizedPnlPercent)
            baseToken: position.baseToken, // Base token used (SOL, USDC, USDT)
            firstBuyTimestamp: position.firstBuyTimestamp?.toISOString() || null,
            lastSellTimestamp: position.lastSellTimestamp?.toISOString() || null,
          };
        }
        return null;
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    // LOGIKA: Open/Closed positions z recent trades
    // 
    // OPEN POSITIONS:
    // - BUY (první nákup, balance z 0 na >0)
    // - ADD (další nákupy, když balance > 0)
    // - REM (částečný prodej, ale balance zůstává > 0)
    // - SELL NENÍ součástí open positions (uzavírá pozici, balance = 0)
    // Open position = balance > 0 NEBO (balance <= 0 ale nemá žádný SELL trade, jen REM)
    //
    // CLOSED POSITIONS:
    // - BUY (počáteční nákup) + SELL (finální prodej, balance = 0)
    // - ADD a REM jsou jen mezistupně
    // Closed position = balance <= 0 A má alespoň jeden SELL trade
    
    // Open positions: BUY + ADD + REM (bez SELL)
    const openPositions = portfolio
      .filter(p => {
        // Musí mít alespoň jeden BUY nebo ADD trade (počáteční nákup nebo další nákup)
        if (p.buyCount === 0) {
          console.log(`   ⏭️  Skipping open position: no BUY/ADD trades`);
          return false;
        }
        
        // DŮLEŽITÉ: SELL není součástí open positions (uzavírá pozici)
        // Open position = balance > 0 NEBO (balance <= 0 ale nemá žádný SELL trade, jen REM)
        const hasSellTrade = p.sellCount > 0;
        if (p.balance <= 0 && hasSellTrade) {
          // balance <= 0 A má SELL trade → closed position (SELL uzavírá pozici)
          console.log(`   ⏭️  Skipping open position: balance <= 0 (${p.balance}) and has SELL trade (closed position)`);
          return false;
        }
        
        // Pokud je balance <= 0 ale nemá SELL trade, může to být otevřená pozice (jen REM trades)
        // Ale filtrujeme pozice s velmi malou hodnotou (prakticky 0)
        const value = p.currentValue || (p.balance * p.averageBuyPrice);
        if (value <= 0.01) {
          console.log(`   ⏭️  Skipping open position: value too small (${value})`);
          return false;
        }
        console.log(`   ✅ Open position: token=${p.token?.symbol || p.tokenId}, balance=${p.balance}, value=${value}, buyCount=${p.buyCount}, removeCount=${p.removeCount || 0}, sellCount=${p.sellCount} (SELL není součástí open positions)`);
        return true;
      })
      .sort((a, b) => {
        const aValue = a.currentValue || (a.balance * a.averageBuyPrice);
        const bValue = b.currentValue || (b.balance * b.averageBuyPrice);
        return bValue - aValue;
      });

    // Closed positions: BUY (počátek) + SELL (konec, balance = 0)
    // DŮLEŽITÉ: Closed position = BUY jako počáteční nákup + SELL jako finální prodej (balance = 0)
    // ADD a REM jsou jen mezistupně - REM neuzavírá pozici, pouze SELL
    // Closed positions musí mít:
    // 1. balance <= 0 (všechny tokeny prodány)
    // 2. BUY trade (počáteční nákup)
    // 3. SELL trade (finální prodej, uzavírá pozici)
    // 4. ClosedLot data (jednotný princip - PnL se počítá POUZE z ClosedLot)
    const closedPositions = portfolio
      .filter(p => {
        // Treat small negative balance (rounding errors) as 0 for closed positions
        const normalizedBalance = p.balance < 0 && Math.abs(p.balance) < 0.0001 ? 0 : p.balance;
        
        // Musí mít balance <= 0 (uzavřená pozice - všechny tokeny prodány)
        if (normalizedBalance > 0) {
          console.log(`   ⏭️  Skipping closed position: balance > 0 (${p.balance}, normalized: ${normalizedBalance})`);
          return false;
        }
        // Musí mít alespoň jeden BUY trade (počáteční nákup)
        if (p.buyCount === 0) {
          console.log(`   ⏭️  Skipping closed position: no BUY trades (počáteční nákup)`);
          return false;
        }
        // DŮLEŽITÉ: Musí mít alespoň jeden SELL trade (finální prodej, uzavírá pozici)
        // REM neuzavírá pozici - pouze SELL
        if (p.sellCount === 0) {
          console.log(`   ⏭️  Skipping closed position: no SELL trades (finální prodej) - REM neuzavírá pozici`);
          return false;
        }
        // DŮLEŽITÉ: Musí mít ClosedLot data (jednotný princip - PnL se počítá POUZE z ClosedLot)
        const closedLotsForToken = (closedLots || []).filter((lot: any) => 
          lot.tokenId === p.tokenId && 
          lot.exitTime && 
          new Date(lot.exitTime) <= new Date()
        );
        if (closedLotsForToken.length === 0) {
          console.log(`   ⏭️  Skipping closed position: no ClosedLot data for token ${p.tokenId}`);
          return false;
        }
        // Musí mít firstBuyTimestamp a lastSellTimestamp (pro výpočet HOLD time)
        // Pokud chybí v trades, zkusíme je doplnit z ClosedLot
        if (!p.firstBuyTimestamp && closedLotsForToken.length > 0) {
          // Najdi nejstarší entryTime
          const firstEntryTime = closedLotsForToken
            .map((lot: any) => new Date(lot.entryTime))
            .sort((a: Date, b: Date) => a.getTime() - b.getTime())[0];
          if (firstEntryTime) {
            p.firstBuyTimestamp = firstEntryTime.toISOString();
            console.log(`   🔧 Patched firstBuyTimestamp from ClosedLot: ${firstEntryTime.toISOString()}`);
          }
        }
        
        if (!p.firstBuyTimestamp) {
          console.log(`   ⏭️  Skipping closed position: missing firstBuyTimestamp (and not found in ClosedLots)`);
          return false;
        }

        if (!p.lastSellTimestamp) {
          // Pokud nemá lastSellTimestamp, použij poslední exitTime z ClosedLot
          const lastExitTime = closedLotsForToken
            .map((lot: any) => new Date(lot.exitTime))
            .sort((a: Date, b: Date) => b.getTime() - a.getTime())[0];
          if (lastExitTime) {
            p.lastSellTimestamp = lastExitTime.toISOString();
            console.log(`   🔧 Patched lastSellTimestamp from ClosedLot: ${lastExitTime.toISOString()}`);
          } else {
            console.log(`   ⏭️  Skipping closed position: missing lastSellTimestamp and no exitTime in ClosedLot`);
            return false;
          }
        }
        
        // Recalculate holdTimeMinutes if we patched timestamps
        if (p.firstBuyTimestamp && p.lastSellTimestamp) {
          const firstBuyDate = typeof p.firstBuyTimestamp === 'string' ? new Date(p.firstBuyTimestamp) : p.firstBuyTimestamp;
          const lastSellDate = typeof p.lastSellTimestamp === 'string' ? new Date(p.lastSellTimestamp) : p.lastSellTimestamp;
          const holdTimeMs = lastSellDate.getTime() - firstBuyDate.getTime();
          p.holdTimeMinutes = Math.round(holdTimeMs / (1000 * 60));
        }

        // Musí mít platný holdTimeMinutes (bylo vypočítáno výše) - povolujeme i 0 (stejný timestamp)
        if (p.holdTimeMinutes === null || p.holdTimeMinutes < 0) {
          console.log(`   ⏭️  Skipping closed position: invalid holdTimeMinutes (${p.holdTimeMinutes})`);
          return false;
        }
        // Musí mít alespoň nějaký PnL data (cost nebo proceeds)
        if (!p.totalCostBase && !p.totalProceedsBase && !p.totalInvested && !p.totalSoldValue) {
          console.log(`   ⏭️  Skipping closed position: no PnL data`);
          return false;
        }
        console.log(`   ✅ Closed position: token=${p.token?.symbol || p.tokenId}, balance=${p.balance}, holdTime=${p.holdTimeMinutes}min, realizedPnlBase=${p.realizedPnlBase} SOL, closedLots=${closedLotsForToken.length}, sellCount=${p.sellCount}`);
        return true;
      })
        .map(p => ({
          ...p,
          // Ujisti se, že máme všechny potřebné pole
          totalSold: p.totalSold || 0,
          realizedPnlBase: p.realizedPnlBase ?? null, // PnL v SOL (primární hodnota)
          realizedPnlPercent: p.realizedPnlPercent ?? null,
          // Pro kompatibilitu s frontendem zachováme staré názvy
          closedPnl: p.realizedPnlBase ?? null, // Alias (deprecated)
          closedPnlBase: p.realizedPnlBase ?? null, // Alias (deprecated)
          closedPnlPercent: p.realizedPnlPercent ?? null, // Alias (deprecated)
          holdTimeMinutes: p.holdTimeMinutes ?? null,
        }))
      .filter(p => p.holdTimeMinutes !== null && p.holdTimeMinutes >= 0) // Finální kontrola - povolujeme i 0 (stejný timestamp)
        .sort((a, b) => {
        // Seřaď podle lastSellTimestamp (nejnovější uzavřené pozice nahoře)
          const aTime = a.lastSellTimestamp ? new Date(a.lastSellTimestamp).getTime() : 0;
          const bTime = b.lastSellTimestamp ? new Date(b.lastSellTimestamp).getTime() : 0;
          return bTime - aTime;
        });

    console.log(`✅ Portfolio calculated: ${openPositions.length} open positions, ${closedPositions.length} closed positions`);
    
    // DEBUG: Log 30d closed positions for PnL calculation
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentClosedPositions30d = closedPositions.filter((p: any) => {
      if (!p.lastSellTimestamp) return false;
      const sellDate = new Date(p.lastSellTimestamp);
      return sellDate >= thirtyDaysAgo && sellDate <= new Date();
    });
    
    if (wallet.id && recentClosedPositions30d.length > 0) {
      const totalPnl30d = recentClosedPositions30d.reduce((sum: number, p: any) => sum + (p.realizedPnlBase ?? 0), 0);
      const totalCost30d = recentClosedPositions30d.reduce((sum: number, p: any) => {
        const pnl = p.realizedPnlBase ?? 0; // PnL v SOL
        const pnlPercent = p.realizedPnlPercent ?? 0;
        if (pnlPercent !== 0 && typeof pnl === 'number' && typeof pnlPercent === 'number') {
          const cost = pnl / (pnlPercent / 100);
          return sum + Math.abs(cost);
        }
        return sum;
      }, 0);
      const pnlPercent30d = totalCost30d > 0 ? (totalPnl30d / totalCost30d) * 100 : 0;
      
      console.log(`   📊 [Portfolio] Wallet ${wallet.id}: Found ${recentClosedPositions30d.length} closed positions in last 30 days`);
      console.log(`   ✅ [Portfolio] Wallet ${wallet.id}: totalPnl30d=${totalPnl30d.toFixed(2)}, totalCost30d=${totalCost30d.toFixed(2)}, pnlPercent30d=${pnlPercent30d.toFixed(2)}%`);
    }
    
    // Debug: Log all positions with balance <= 0 to see why they're not in closed positions
    const allClosedCandidates = portfolio.filter(p => {
      const normalizedBalance = p.balance < 0 && Math.abs(p.balance) < 0.0001 ? 0 : p.balance;
      return normalizedBalance <= 0 && p.buyCount > 0;
    });
    if (allClosedCandidates.length > closedPositions.length) {
      console.log(`⚠️  Found ${allClosedCandidates.length} positions with balance <= 0, but only ${closedPositions.length} passed filters:`);
      allClosedCandidates.forEach(p => {
        const normalizedBalance = p.balance < 0 && Math.abs(p.balance) < 0.0001 ? 0 : p.balance;
        console.log(`   - Token: ${p.token?.symbol || p.tokenId}, balance: ${p.balance} (normalized: ${normalizedBalance}), buyCount: ${p.buyCount}, sellCount: ${p.sellCount}, holdTime: ${p.holdTimeMinutes}, firstBuy: ${p.firstBuyTimestamp}, lastSell: ${p.lastSellTimestamp}`);
      });
    }
    
    // Calculate 30d PnL from closed positions (same logic as detail page)
    // This ensures consistency between homepage and detail page
    const pnl30dFromPortfolio = recentClosedPositions30d.reduce((sum: number, p: any) => sum + (p.realizedPnlBase ?? 0), 0);
    const pnl30dPercentFromPortfolio = recentClosedPositions30d.length > 0 ? pnlPercent30d : 0;
    
    // Ulož do cache
    const now = new Date().toISOString();
    const responseData = {
      portfolio: openPositions, // Backward compatibility
      openPositions,
      closedPositions,
      pnl30d: pnl30dFromPortfolio, // PnL v SOL za posledních 30 dní (stejná logika jako detail)
      pnl30dPercent: pnl30dPercentFromPortfolio, // PnL % za posledních 30 dní
      lastUpdated: now,
      cached: false,
    };
    
    // Save to PortfolioBaseline cache
    try {
      await supabase
        .from('PortfolioBaseline')
        .upsert({
          walletId: wallet.id,
          updatedAt: now,
          totalValueUsd: openPositions.reduce((sum, p) => sum + (p.currentValue || 0), 0),
          holdings: responseData,
        }, { onConflict: 'walletId' });
      console.log(`✅ Portfolio cache saved for wallet ${wallet.id}`);
    } catch (e) {
      console.warn('⚠️ Failed to save portfolio cache:', (e as any)?.message || e);
    }
    
    res.json(responseData);
  } catch (error: any) {
    console.error('❌ Error fetching portfolio:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
    });
  }
});

// GET /api/smart-wallets/:id/pnl - Get PnL data for different time periods
// Supports both ID (database ID) and address (wallet address)
router.get('/:id/pnl', async (req, res) => {
  try {
    const identifier = req.params.id;
    // Try to find by ID first (if it's a short ID), then by address
    let wallet = await smartWalletRepo.findById(identifier);
    if (!wallet) {
      wallet = await smartWalletRepo.findByAddress(identifier);
    }
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    const walletId = wallet.id;

    // Get all trades for this wallet
    const allTrades = await tradeRepo.findByWalletId(walletId, {
      page: 1,
      pageSize: 10000, // Get all trades
    });

    // Calculate PnL for different periods
    const now = new Date();
    const periods = {
      '1d': new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      '7d': new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      '14d': new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
      '30d': new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    };

    // Build positions from trades
    const positions = await metricsCalculator.buildPositionsFromTrades(walletId);
    
    // Get ALL trades for USD calculation (don't pre-filter by 1d)
    const trades = allTrades.trades;
    
    const pnlData: Record<string, { pnl: number; pnlUsd: number; pnlPercent: number; trades: number }> = {};
    
    for (const [period, fromDate] of Object.entries(periods)) {
      const periodPositions = positions.filter(
        p => p.sellTimestamp && p.sellTimestamp >= fromDate
      );

      // Vypočti celkový PnL (suma hodnot, ne procent)
      const totalBuyValue = periodPositions.reduce((sum, p) => {
        return sum + Number(p.buyPrice) * Number(p.buyAmount);
      }, 0);

      const totalSellValue = periodPositions.reduce((sum, p) => {
        return sum + Number(p.sellPrice!) * Number(p.sellAmount!);
      }, 0);

      const pnl = totalSellValue - totalBuyValue;

      // Vypočti PnL v procentech správně (celkový ROI, ne průměr jednotlivých pozic)
      const pnlPercent = totalBuyValue > 0
        ? ((pnl / totalBuyValue) * 100)
        : 0;

      // Calculate PnL in USD from trades - filter directly by fromDate (same as repository)
      const periodTrades = trades.filter(t => {
        const tradeDate = new Date(t.timestamp);
        return tradeDate >= fromDate;
      });

      let buyValueUsd = 0;
      let sellValueUsd = 0;
      for (const trade of periodTrades) {
        const valueUsd = Number(trade.valueUsd || 0);
        if (trade.side === 'buy') {
          buyValueUsd += valueUsd;
        } else if (trade.side === 'sell') {
          sellValueUsd += valueUsd;
        }
      }
      const pnlUsd = sellValueUsd - buyValueUsd;

      pnlData[period] = {
        pnl,
        pnlUsd,
        pnlPercent,
        trades: periodPositions.length,
      };
    }

    // Get daily PnL data for charts
    const dailyPnl: Array<{ date: string; pnl: number; cumulativePnl: number }> = [];
    const positionsByDate = new Map<string, number>();
    
    positions
      .filter(p => p.sellTimestamp)
      .forEach(p => {
        const date = new Date(p.sellTimestamp!).toISOString().split('T')[0];
        const positionPnl = (Number(p.sellPrice!) - Number(p.buyPrice)) * Number(p.buyAmount);
        positionsByDate.set(date, (positionsByDate.get(date) || 0) + positionPnl);
      });

    let cumulativePnl = 0;
    Array.from(positionsByDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([date, pnl]) => {
        cumulativePnl += pnl;
        dailyPnl.push({ date, pnl, cumulativePnl });
      });

    res.json({
      periods: pnlData,
      daily: dailyPnl,
    });
  } catch (error: any) {
    console.error('❌ Error fetching PnL data:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
    });
  }
});

export { router as smartWalletRouter };

