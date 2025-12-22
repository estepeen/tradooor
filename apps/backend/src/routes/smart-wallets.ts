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
import { prisma } from '../lib/prisma.js';
import { ClosedLotRepository } from '../repositories/closed-lot.repository.js';
import { isValidSolanaAddress, parseTags } from '../lib/utils.js';
import { TokenMetadataBatchService } from '../services/token-metadata-batch.service.js';
import { LotMatchingService } from '../services/lot-matching.service.js';
import { SolPriceCacheService } from '../services/sol-price-cache.service.js';

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
const tokenMetadataBatchService = new TokenMetadataBatchService(tokenRepo);
const closedLotRepo = new ClosedLotRepository();
const solPriceCacheService = new SolPriceCacheService();

const STABLE_BASES = new Set(['SOL', 'WSOL', 'USDC', 'USDT']);

const normalizeTradeSide = (side?: string | null): 'buy' | 'sell' => {
  if (!side) {
    return 'buy';
  }
  const lower = side.toLowerCase();
  if (lower === 'add') return 'buy';
  if (lower === 'remove') return 'sell';
  return lower === 'sell' ? 'sell' : 'buy';
};


// GET /api/smart-wallets - List all smart wallets with pagination and filters
// DŮLEŽITÉ: PnL se bere PŘÍMO z databáze (recentPnl30dUsd a recentPnl30dPercent)
// Tyto hodnoty se ukládají do DB při výpočtu metrik (metrics-calculator.service.ts)
// NEPŘEPOČÍTÁVÁME to znovu - použijeme hodnoty z DB, které jsou správně vypočítané
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
    
    // Získej aktuální SOL cenu pro přepočet na USD
    let solPriceUsd = 150.0; // Fallback
    try {
      solPriceUsd = await solPriceCacheService.getCurrentSolPrice();
      console.log(`   💰 Current SOL price: $${solPriceUsd.toFixed(2)} USD`);
    } catch (error: any) {
      console.warn(`   ⚠️  Failed to fetch SOL price, using fallback: $${solPriceUsd}`);
    }
    
    // DŮLEŽITÉ: Použij hodnoty PnL PŘÍMO z databáze
    // recentPnl30dUsd obsahuje PnL v SOL (vypočítané z ClosedLot v metrics-calculator.service.ts)
    // recentPnl30dPercent obsahuje ROI v % (vypočítané z ClosedLot v metrics-calculator.service.ts)
    // Tyto hodnoty se aktualizují při každém výpočtu metrik, takže jsou vždy aktuální
    const walletsWithPnl = result.wallets.map((wallet: any) => {
      // recentPnl30dUsd obsahuje PnL v SOL (sloupec se jmenuje Usd ale obsahuje SOL)
      // recentPnl30dBase je mapováno z recentPnl30dUsd v repository
      const pnl30dSol = wallet.recentPnl30dBase ?? 0;
      const pnl30dUsd = pnl30dSol * solPriceUsd; // Přepočet SOL → USD
      
      return {
        ...wallet,
        // recentPnl30dBase je už mapováno v repository z recentPnl30dUsd
        // recentPnl30dPercent je už v wallet z DB
        recentPnl30dUsdValue: pnl30dUsd, // USD hodnota pro zobrazení (místo procent)
      };
    });
    
    // DEBUG: Log PnL values for first few wallets and specific wallet if present
    if (walletsWithPnl && walletsWithPnl.length > 0) {
      console.log(`📊 [Endpoint] Sample PnL values (from database, same as detail):`);
      walletsWithPnl.slice(0, 5).forEach((wallet: any) => {
        console.log(`   💰 Wallet ${wallet.address}: recentPnl30dBase=${wallet.recentPnl30dBase}, recentPnl30dPercent=${wallet.recentPnl30dPercent}, recentPnl30dUsd=${wallet.recentPnl30dUsd}`);
      });
      
      // DEBUG: Log specific wallet if present (CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o)
      const specificWallet = walletsWithPnl.find((w: any) => w.address === 'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o');
      if (specificWallet) {
        console.log(`   🔍 [DEBUG CyaE1Vxv] Wallet found in response:`);
        console.log(`      address: ${specificWallet.address}`);
        console.log(`      recentPnl30dBase: ${specificWallet.recentPnl30dBase}`);
        console.log(`      recentPnl30dUsd (from DB): ${specificWallet.recentPnl30dUsd}`);
        console.log(`      recentPnl30dPercent: ${specificWallet.recentPnl30dPercent}`);
      } else {
        // Wallet not in current page - log all addresses to see what's in response
        console.log(`   ⚠️ [DEBUG CyaE1Vxv] Wallet NOT found in current page. Total wallets in response: ${walletsWithPnl.length}`);
        console.log(`   ⚠️ [DEBUG CyaE1Vxv] First 10 addresses in response: ${walletsWithPnl.slice(0, 10).map((w: any) => w.address.substring(0, 8) + '...').join(', ')}`);
      }
    }
    
    res.json({
      ...result,
      wallets: walletsWithPnl,
    });
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

// GET /api/smart-wallets/:id/portfolio/refresh - Fetch live portfolio using RPC
// Supports both ID (database ID) and address (wallet address)
router.get('/:id/portfolio/refresh', async (req, res) => {
  try {
    const identifier = req.params.id;
    // Try to find by ID first (if it's a short ID), then by address
    let wallet: any = await smartWalletRepo.findById(identifier);
    if (!wallet) {
      wallet = (await smartWalletRepo.findByAddress(identifier)) as any;
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

    // RPC connection
    const rpcUrl =
      process.env.QUICKNODE_RPC_URL ||
      process.env.SOLANA_RPC_URL ||
      'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');
    const owner = new PublicKey(wallet.address);

    // 1) Native SOL
    const lamports = await connection.getBalance(owner, 'confirmed');
    const solBalance = lamports / 1e9;
    if (solBalance > 0) {
      // DŮLEŽITÉ: currentValue je nyní v SOL (ne v USD)
      // SOL balance je už v SOL, takže currentValue = balance
      positions.push({
        tokenId: 'SOL',
        token: {
          mintAddress: 'So11111111111111111111111111111111111111112',
          symbol: 'SOL',
          name: 'Solana',
          decimals: 9,
        },
        balance: solBalance,
        averageBuyPrice: 0, // Není potřeba pro SOL (je to 1:1)
        currentValue: solBalance, // V SOL (balance je už v SOL)
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
    const allTrades = await prisma.trade.findMany({
      where: {
        walletId: wallet.id,
        side: 'buy',
      },
      select: {
        tokenId: true,
        side: true,
        amountToken: true,
        amountBase: true,
        priceBasePerToken: true,
        meta: true,
      },
    });
    
    // Vytvoř mapu tokenId -> totalCost (součet všech buy trades v base měně)
    const totalCostMap = new Map<string, number>();
      for (const trade of allTrades) {
        const tokenId = trade.tokenId;
        const amountBase = Number(trade.amountBase || 0);
        const currentCost = totalCostMap.get(tokenId) || 0;
        totalCostMap.set(tokenId, currentCost + amountBase);
    }
    
    // 2. For each position calculate Live PnL
    // DŮLEŽITÉ: Všechny hodnoty jsou nyní v SOL (ne v USD)
    // Live PnL = currentValue - totalCost (v SOL)
    // currentValue = balance * currentPrice (z Birdeye v USD) / currentSolPrice (převod na SOL)
    // totalCost = sum of all buy trades v SOL (amountBase je už v SOL nebo se převede)
    const { BinancePriceService } = await import('../services/binance-price.service.js');
    const binancePriceService = new BinancePriceService();
    const currentSolPrice = await binancePriceService.getCurrentSolPrice().catch(() => null);
    
    const portfolio = await Promise.all(
      positions.map(async (p) => {
        const totalCostBase = totalCostMap.get(p.tokenId) || 0; // V SOL (amountBase je v SOL)
        let currentValueSol = null; // Aktuální hodnota v SOL
        let livePnl = 0;
        let livePnlPercent = 0;
        
        // Převod currentValue z USD na SOL
        if (p.currentValue !== null && p.currentValue > 0 && currentSolPrice && currentSolPrice > 0) {
          // currentValue je v USD (z Birdeye), převedeme na SOL
          currentValueSol = p.currentValue / currentSolPrice;
        }
        
        // Vypočítej Live PnL (vše v SOL)
        if (currentValueSol !== null && currentValueSol > 0 && totalCostBase > 0) {
          livePnl = currentValueSol - totalCostBase;
          livePnlPercent = totalCostBase > 0 ? (livePnl / totalCostBase) * 100 : 0;
        }
        
        return {
        ...p,
          currentValue: currentValueSol, // Aktuální hodnota v SOL (místo USD)
          totalCost: totalCostBase, // Total cost v SOL (místo USD)
          livePnl, // Live PnL (unrealized) v SOL
          livePnlBase: livePnl, // Live PnL v SOL (explicitní)
          livePnlPercent, // Live PnL v %
          // Pro kompatibilitu zachováme staré názvy
          pnl: livePnl,
          pnlPercent: livePnlPercent,
        };
      })
    );
    
    // Seřaď podle currentValue (v SOL)
    portfolio.sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));
    
    const knownTotalSol = portfolio.reduce((sum, p) => sum + (p.currentValue ?? 0), 0);
    const unknownCount = portfolio.filter(p => p.currentValue == null).length;
    const totalValue = knownTotalSol; // V SOL

    // Debug price coverage
    try {
      console.log('🔎 Portfolio refresh summary', {
        wallet: wallet.address,
        items: portfolio.length,
        knownTotalSol,
        unknownCount,
      });
      for (const p of portfolio) {
        console.log('  • Portfolio item', {
          mint: p.token?.mintAddress || p.tokenId,
          balance: p.balance,
          priceUsd: p.averageBuyPrice, // Token price v USD (pro zobrazení)
          valueSol: p.currentValue, // Aktuální hodnota v SOL
          hasPrice: p.currentValue != null,
        });
      }
    } catch {}

    // Detect primary base token from trades (for multichain support) - BEFORE creating closed positions
    const baseTokenCounts = new Map<string, number>();
    const sampleTrades = await tradeRepo.findByWalletId(wallet.id, {
      page: 1,
      pageSize: 100, // Sample 100 trades
    });
    
    for (const trade of sampleTrades.trades) {
      const meta = (trade.meta as any) || {};
      const baseToken = (meta.baseToken || 'SOL').toUpperCase();
      baseTokenCounts.set(baseToken, (baseTokenCounts.get(baseToken) || 0) + 1);
    }
    
    // Find most common base token, default to SOL
    let primaryBaseToken = 'SOL';
    let maxCount = 0;
    for (const [token, count] of baseTokenCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        primaryBaseToken = token;
      }
    }
    
    // Normalize WSOL → SOL for display
    if (primaryBaseToken === 'WSOL') {
      primaryBaseToken = 'SOL';
    }

    // Return in the same structure as existing /portfolio endpoint for UI compatibility
    const now = new Date().toISOString();
    const responsePayload = {
      totalValue, // V SOL
      knownTotalSol, // V SOL (kompatibilita - frontend může očekávat knownTotalUsd)
      unknownCount,
      closedPositions: [],
      source: 'birdeye-api',
      lastUpdated: now,
      cached: false,
      baseToken: primaryBaseToken, // Primary base token for this wallet
    };

    // PortfolioBaseline cache removed (Supabase-only feature)
    // Skip saving baseline - not available in Prisma-only mode

    res.json(responsePayload);
  } catch (error: any) {
    console.error('❌ Error fetching live portfolio via RPC:', error?.message || error);
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
    let wallet: any = await smartWalletRepo.findById(identifier);
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

    // Webhook setup removed - using QuickNode only

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
      twitterUrl?: string | null;
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
      const twitterUrl = row.twitter || row.Twitter || row.TWITTER || null;

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
        twitterUrl: twitterUrl ? twitterUrl.trim() : null,
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

    // Aktualizuj labely a tagy pro existující wallets (které jsou v CSV i v DB)
    let updatedCount = 0;
    const csvWalletMap = new Map(wallets.map(w => [w.address.toLowerCase(), w]));
    
    for (const existingWallet of existingWallets) {
      const csvWallet = csvWalletMap.get(existingWallet.address.toLowerCase());
      if (csvWallet) {
        // Wallet existuje v CSV i v DB - zkontroluj, jestli se změnil label, tags nebo twitterUrl
        const labelChanged = existingWallet.label !== csvWallet.label;
        const tagsChanged = JSON.stringify(existingWallet.tags || []) !== JSON.stringify(csvWallet.tags || []);
        const twitterUrlChanged = (existingWallet.twitterUrl || null) !== (csvWallet.twitterUrl || null);
        
        if (labelChanged || tagsChanged || twitterUrlChanged) {
          try {
            await smartWalletRepo.update(existingWallet.id, {
              label: csvWallet.label ?? null,
              tags: csvWallet.tags || [],
              twitterUrl: csvWallet.twitterUrl ?? null,
            });
            updatedCount++;
            console.log(`🔄 Updated wallet ${existingWallet.address.substring(0, 8)}...: label=${csvWallet.label || 'null'}, tags=${JSON.stringify(csvWallet.tags || [])}`);
          } catch (error: any) {
            console.error(`❌ Error updating wallet ${existingWallet.address}:`, error.message);
          }
        }
      }
    }

    console.log(`✅ Synchronization completed: ${result.created.length} created, ${updatedCount} updated, ${removedCount} removed, ${result.errors.length} errors`);

    // Webhook setup removed - using QuickNode only

    res.status(200).json({
      success: true,
      total: wallets.length,
      created: result.created.length,
      updated: updatedCount,
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

// POST /api/smart-wallets/setup-webhook - @deprecated Helius webhook setup removed
router.post('/setup-webhook', async (req, res) => {
  res.status(410).json({
    error: 'Deprecated',
    message: 'Helius webhook setup is no longer used. Using QuickNode webhooks only.',
  });
});

// GET /api/smart-wallets/:id/portfolio - Get portfolio positions for a wallet
// Supports both ID (database ID) and address (wallet address)
// Uses cache (10 minutes) - pokud je cache starší než 10 minut, aktualizuje ceny z Birdeye
router.get('/:id/portfolio', async (req, res) => {
  try {
    const identifier = req.params.id;
    const forceRefresh = req.query.forceRefresh === 'true'; // Ruční aktualizace
    
    // Try to find by ID first (if it's a short ID), then by address
    let wallet: any = await smartWalletRepo.findById(identifier);
    if (!wallet) {
      wallet = await smartWalletRepo.findByAddress(identifier);
    }
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    
    // PortfolioBaseline cache removed (Supabase-only feature)
    // Always refresh - cache is not available in Prisma-only mode
    
    // Aktualizuj z Birdeye API
    console.log(`🔄 Refreshing portfolio prices from Birdeye API...`);

    // OPTIMALIZACE: Použij precomputed portfolio z PortfolioBaseline (rychlé)
    // Pokud není k dispozici nebo je starý, použij closed positions z ClosedLot (precomputed)
    // Nepočítáme pozice on-demand z trades - to je pomalé!
    console.log('📊 Loading precomputed portfolio positions...');
    
    // Zkus načíst closed positions z ClosedLot (precomputed worker/cron)
    // DŮLEŽITÉ: Pro výpočet PnL potřebujeme všechny ClosedLot (ne jen 1000 nejnovějších)
    // Limit 1000 může způsobit rozdíl mezi homepage a detail stránkou
    // Pro UI (closed positions) můžeme použít limit, ale pro PnL výpočet potřebujeme všechny
    const closedLots = await closedLotRepo.findByWallet(wallet.id);
    console.log(`   📊 [Portfolio] Loaded ${closedLots.length} ClosedLots for wallet ${wallet.id}`);
    
    // DŮLEŽITÉ: Odstranili jsme tradeUsdRatioMap a USD konverze - už nepracujeme s USD
    // Všechny hodnoty jsou nyní v SOL (USDC/USDT se převádějí na SOL při výpočtu PnL v lot-matching.service.ts)

    // Get unique tokenIds from ClosedLot (for token data fetching)
    const uniqueTokenIds = closedLots && closedLots.length > 0
      ? Array.from(new Set(closedLots.map((lot: any) => lot.tokenId)))
      : [];

    // Create a map of tokenId -> current token data (Prisma)
    const tokenDataMap = new Map<string, any>();
    if (uniqueTokenIds.length > 0) {
      try {
        const tokens = await prisma.token.findMany({
          where: { id: { in: uniqueTokenIds } },
        });
        tokens.forEach((token) => {
          tokenDataMap.set(token.id, { ...token });
        });
      } catch (e: any) {
        console.warn('⚠️ Failed to fetch token data via Prisma:', e?.message || e);
      }
    }
    
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
    for (const token of Array.from(tokenDataMap.values())) {
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
        const tokenMetadataBatchService = new TokenMetadataBatchService(tokenRepo);
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

    // Detect primary base token from trades (for multichain support) - BEFORE creating closed positions
    const baseTokenCounts = new Map<string, number>();
    const sampleTrades = await tradeRepo.findByWalletId(wallet.id, {
      page: 1,
      pageSize: 100, // Sample 100 trades
    });
    
    for (const trade of sampleTrades.trades) {
      const meta = (trade.meta as any) || {};
      const baseToken = (meta.baseToken || 'SOL').toUpperCase();
      baseTokenCounts.set(baseToken, (baseTokenCounts.get(baseToken) || 0) + 1);
    }
    
    // Find most common base token, default to SOL
    let primaryBaseToken = 'SOL';
    let maxCount = 0;
    for (const [token, count] of baseTokenCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        primaryBaseToken = token;
      }
    }
    
    // Normalize WSOL → SOL for display
    if (primaryBaseToken === 'WSOL') {
      primaryBaseToken = 'SOL';
    }

    // LOGIKA: Closed positions z ClosedLot (FIFO párované)
    // 
    // CLOSED POSITIONS:
    // - Vytváří se POUZE z ClosedLot (FIFO párované BUY-SELL trades)
    // - Každý ClosedLot = jedna uzavřená pozice
    // - Seskupené podle sellTradeId pro UI (jeden SELL trade může uzavřít více BUY trades)

    // Closed positions: BUY (počátek) + SELL (konec, balance = 0)
    // DŮLEŽITÉ: Closed position = BUY jako počáteční nákup + SELL jako finální prodej (balance = 0)
    // ADD a REM jsou jen mezistupně - REM neuzavírá pozici, pouze SELL
    // Closed positions musí mít:
    // 1. balance <= 0 (všechny tokeny prodány) NEBO ClosedLot data (priorita - pokud máme ClosedLot, pozice je uzavřená)
    // 2. BUY trade (počáteční nákup) NEBO ClosedLot data (priorita)
    // 3. SELL trade (finální prodej, uzavírá pozici) NEBO ClosedLot data (priorita - ClosedLot znamená, že pozice byla uzavřena)
    // 4. ClosedLot data (jednotný princip - PnL se počítá POUZE z ClosedLot)
    
    // DŮLEŽITÉ: Vytvoříme samostatnou closed position pro každý BUY-SELL cyklus (skupina ClosedLots se stejným sellTradeId)
    // Tím zajistíme, že každý cyklus pro stejný token bude samostatná pozice s řadovým označením (1., 2., 3. atd.)
    // DŮLEŽITÉ: Všechny hodnoty jsou nyní v SOL (ne v USD!) - odstranili jsme convertBaseToUsd funkci

    const closedPositionsFromLots: any[] = [];
    if (closedLots && closedLots.length > 0) {
      console.log(`   📊 [Portfolio] Found ${closedLots.length} ClosedLots for wallet ${wallet.id}`);
      // DŮLEŽITÉ: Seskupujeme ClosedLots podle tokenId (ne podle sequenceNumber nebo sellTradeId)
      // Tím zajistíme, že všechny ClosedLots pro stejný token se sečtou do jedné closed position
      // a PnL se počítá správně bez duplicit
      const lotsByToken = new Map<string, any[]>();
      const seenLotIds = new Set<string>(); // Kontrola duplicit podle ID
      const seenLotKeys = new Set<string>(); // Kontrola duplicit podle klíče (tokenId + entryTime + exitTime + size)
      
      for (const lot of closedLots) {
        // Kontrola duplicit podle ID - každý ClosedLot by měl být jen jednou
        if (seenLotIds.has(lot.id)) {
          console.warn(`   ⚠️  [Portfolio] Duplicate ClosedLot ID detected: id=${lot.id}, tokenId=${lot.tokenId}, sellTradeId=${lot.sellTradeId}`);
          continue; // Přeskoč duplicitní ClosedLot
        }
        seenLotIds.add(lot.id);
        
        // Kontrola duplicit podle klíče (tokenId + entryTime + exitTime + size)
        // Pokud máme ClosedLot se stejnými hodnotami, je to pravděpodobně duplicita
        const lotKey = `${lot.tokenId}-${lot.entryTime}-${lot.exitTime}-${lot.size || lot.realizedPnl}`;
        if (seenLotKeys.has(lotKey)) {
          console.warn(`   ⚠️  [Portfolio] Duplicate ClosedLot key detected: id=${lot.id}, tokenId=${lot.tokenId}, key=${lotKey}`);
          continue; // Přeskoč duplicitní ClosedLot
        }
        seenLotKeys.add(lotKey);
        
        // Seskupíme podle tokenId (všechny ClosedLots pro stejný token do jedné skupiny)
        const tokenId = lot.tokenId;
        
        if (!lotsByToken.has(tokenId)) {
          lotsByToken.set(tokenId, []);
        }
        lotsByToken.get(tokenId)!.push(lot);
      }
      
      // DEBUG: Log grouping for UNDERSTAND token
      const understandTokenId = Array.from(tokenDataMap.entries()).find(([_, token]) => 
        token?.symbol?.toUpperCase() === 'UNDERSTAND'
      )?.[0];
      if (understandTokenId && wallet.id) {
        const understandLots = closedLots.filter(lot => lot.tokenId === understandTokenId);
        console.log(`   🔍 [DEBUG UNDERSTAND] Found ${understandLots.length} ClosedLots for UNDERSTAND token`);
        understandLots.forEach((lot, idx) => {
          console.log(`      Lot ${idx + 1}: id=${lot.id}, sellTradeId=${lot.sellTradeId}, sequenceNumber=${lot.sequenceNumber}, realizedPnl=${(lot.realizedPnl || 0).toFixed(4)} SOL`);
        });
        const understandSellTradeIds = new Set(understandLots.map(lot => lot.sellTradeId || 'unknown'));
        console.log(`   🔍 [DEBUG UNDERSTAND] Grouped into ${understandSellTradeIds.size} sellTradeId groups: ${Array.from(understandSellTradeIds).join(', ')}`);
      }
      
      // Získej aktuální SOL cenu pro přepočet na USD
      let solPriceUsd = 150.0; // Fallback
      try {
        solPriceUsd = await solPriceCacheService.getCurrentSolPrice();
      } catch (error: any) {
        console.warn(`   ⚠️  Failed to fetch SOL price, using fallback: $${solPriceUsd}`);
      }
      
      // Pro každý token vytvoříme jednu closed position se součtem všech ClosedLots
      for (const [tokenId, lotsForToken] of lotsByToken.entries()) {
        if (lotsForToken.length === 0) continue;
        
        // Seřadíme ClosedLots podle entryTime a exitTime
        const sortedLots = lotsForToken.sort((a: any, b: any) => {
          const aEntry = new Date(a.entryTime).getTime();
          const bEntry = new Date(b.entryTime).getTime();
          if (aEntry !== bEntry) return aEntry - bEntry;
          return new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime();
        });
        
        const firstLot = sortedLots[0];
        const lastLot = sortedLots[sortedLots.length - 1];
        
        const token = tokenDataMap.get(tokenId);
        
        // Sečteme všechny ClosedLots pro tento token do jedné closed position
        const totalRealizedPnl = lotsForToken.reduce((sum: number, lot: any) => {
          const pnl = lot.realizedPnl !== null && lot.realizedPnl !== undefined ? Number(lot.realizedPnl) : 0;
          return sum + pnl;
        }, 0);
        
        const totalCostBase = lotsForToken.reduce((sum: number, lot: any) => sum + (Number(lot.costBasis) || 0), 0);
        const totalProceedsBase = lotsForToken.reduce((sum: number, lot: any) => sum + (Number(lot.proceeds) || 0), 0);
        const effectiveCostBase = totalCostBase > 0 ? totalCostBase : (totalProceedsBase - totalRealizedPnl);
        const realizedPnlPercent = effectiveCostBase > 0 ? (totalRealizedPnl / effectiveCostBase) * 100 : 0;
        
        // Přepočet na USD
        const totalRealizedPnlUsd = totalRealizedPnl * solPriceUsd;
        const totalCostBaseUsd = totalCostBase * solPriceUsd;

        // DŮLEŽITÉ: Všechny hodnoty jsou nyní v SOL (ne v USD!)
        // Odstranili jsme přepočet na USD - vše je v SOL
        const realizedPnlUsd = totalRealizedPnl; // Kompatibilita - frontend očekává pnlUsd, ale obsahuje SOL
        const totalCostUsdValue = totalCostBase; // Kompatibilita - obsahuje SOL
        const totalProceedsUsdValue = totalProceedsBase; // Kompatibilita - obsahuje SOL
        
        const entryTime = new Date(firstLot.entryTime);
        const exitTime = new Date(lastLot.exitTime);
        const holdTimeMs = exitTime.getTime() - entryTime.getTime();
        const holdTimeMinutes = Math.round(holdTimeMs / (1000 * 60));
        
        // DEBUG: Log for UNDERSTAND token
        const tokenSymbol = token?.symbol?.toUpperCase();
        if (tokenSymbol === 'UNDERSTAND' && wallet.id) {
          console.log(`   🔍 [DEBUG UNDERSTAND] Created closed position: tokenId=${tokenId}, totalRealizedPnl=${totalRealizedPnl.toFixed(4)} SOL (from ${lotsForToken.length} unique lots), totalCostBase=${totalCostBase.toFixed(4)}, totalProceedsBase=${totalProceedsBase.toFixed(4)}`);
        }
        
        closedPositionsFromLots.push({
          tokenId,
          token: token || null,
          sequenceNumber: null, // Nenastavujeme sequenceNumber - je to jedna pozice pro celý token
          balance: 0,
          totalBought: 0,
          totalSold: 0,
          totalInvested: 0,
          totalSoldValue: 0,
          totalCostBase, // V SOL
          totalProceedsBase, // V SOL
          totalCostUsd: totalCostUsdValue, // V SOL (kompatibilita - obsahuje SOL hodnoty)
          totalProceedsUsd: totalProceedsUsdValue, // V SOL (kompatibilita - obsahuje SOL hodnoty)
          averageBuyPrice: 0,
          buyCount: lotsForToken.length, // Počet lots
          sellCount: new Set(lotsForToken.map((lot: any) => lot.sellTradeId)).size, // Počet unikátních SELL trades
          removeCount: 0,
          lastBuyPrice: 0,
          lastSellPrice: 0,
          firstBuyTimestamp: entryTime.toISOString(),
          lastSellTimestamp: exitTime.toISOString(),
          baseToken: primaryBaseToken, // Use detected base token
          currentPrice: null,
          currentValue: 0,
          totalCost: 0,
          livePnl: 0,
          livePnlBase: 0,
          livePnlPercent: 0,
          pnl: 0,
          pnlPercent: 0,
          holdTimeMinutes: holdTimeMinutes >= 0 ? holdTimeMinutes : 0,
          realizedPnlBase: totalRealizedPnl,
          realizedPnlUsd,
          realizedPnlPercent,
          closedPnl: totalRealizedPnl,
          closedPnlBase: totalRealizedPnl,
          closedPnlUsd: realizedPnlUsd,
          closedPnlPercent: realizedPnlPercent,
          // Přidáme USD hodnoty pro zobrazení (místo procent)
          realizedPnlUsdValue: totalRealizedPnlUsd, // USD hodnota PnL
          totalCostBaseUsd: totalCostBaseUsd, // USD hodnota cost
        });
        
        console.log(`   ✅ Created closed position: tokenId=${tokenId}, symbol=${token?.symbol || 'N/A'}, realizedPnlBase=${totalRealizedPnl.toFixed(4)} SOL (from ${lotsForToken.length} lots), holdTime=${holdTimeMinutes}min`);
      }
    }
    
    // DŮLEŽITÉ: Closed positions se vytváří POUZE z ClosedLots (jednotný princip)
    const closedPositions = [
      ...closedPositionsFromLots
    ]
      .filter(p => p.holdTimeMinutes !== null && p.holdTimeMinutes >= 0)
        .sort((a, b) => {
          const aTime = a.lastSellTimestamp ? new Date(a.lastSellTimestamp).getTime() : 0;
          const bTime = b.lastSellTimestamp ? new Date(b.lastSellTimestamp).getTime() : 0;
          return bTime - aTime;
        });

    console.log(`✅ Portfolio calculated: ${closedPositions.length} closed positions`);
    
    // DEBUG: Calculate total PnL per token to identify discrepancies
    const pnlByToken = new Map<string, { totalPnl: number; positions: number; tokenSymbol?: string }>();
    for (const position of closedPositions) {
      const tokenId = position.tokenId;
      const tokenSymbol = position.token?.symbol?.toUpperCase();
      const pnl = position.realizedPnlBase ?? position.closedPnlBase ?? position.closedPnl ?? 0;
      if (!pnlByToken.has(tokenId)) {
        pnlByToken.set(tokenId, { totalPnl: 0, positions: 0, tokenSymbol });
      }
      const tokenData = pnlByToken.get(tokenId)!;
      tokenData.totalPnl += pnl;
      tokenData.positions += 1;
    }
    
    // Log PnL summary per token (especially for UNDERSTAND)
    for (const [tokenId, data] of pnlByToken.entries()) {
      if (data.tokenSymbol === 'UNDERSTAND' || Math.abs(data.totalPnl) > 1) {
        console.log(`   📊 [PnL Summary] Token ${data.tokenSymbol || tokenId}: totalPnl=${data.totalPnl.toFixed(4)} SOL (from ${data.positions} closed positions)`);
      }
    }
    
    // DŮLEŽITÉ: Pro konzistenci s detail stránkou počítáme PnL ze seskupených closed positions
    // Detail stránka používá closedPositions (seskupené podle tokenu), ne všechny ClosedLots
    // Toto zajišťuje, že PnL je stejné na homepage i v detailu
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    // Filtruj closed positions podle lastSellTimestamp (kdy byla pozice uzavřena)
    const recentClosedPositions30d = closedPositions.filter((p: any) => {
      if (!p.lastSellTimestamp) return false;
      const sellDate = new Date(p.lastSellTimestamp);
      return sellDate >= thirtyDaysAgo && sellDate <= new Date();
    });
    
    // Sčítáme realizedPnlBase ze seskupených closed positions (stejně jako detail stránka)
    // Toto zajišťuje konzistenci mezi homepage a detail stránkou
    const totalPnl30d = recentClosedPositions30d.reduce((sum: number, p: any) => {
      const pnl = p.realizedPnlBase ?? p.closedPnlBase ?? p.closedPnl ?? 0;
      return sum + (typeof pnl === 'number' ? pnl : 0);
    }, 0);
    
    // Sčítáme costBasis ze seskupených closed positions (stejně jako detail stránka)
    const totalCost30d = recentClosedPositions30d.reduce((sum: number, p: any) => {
      const costBasis = p.totalCostBase ?? p.totalCostUsd ?? 0;
      return sum + (typeof costBasis === 'number' ? costBasis : 0);
    }, 0);
    
    const pnlPercent30d = totalCost30d > 0 ? (totalPnl30d / totalCost30d) * 100 : 0;
    
    if (wallet.id && recentClosedPositions30d.length > 0) {
      console.log(`   📊 [Portfolio] Wallet ${wallet.id}: Found ${recentClosedPositions30d.length} closed positions in last 30 days`);
      console.log(`   ✅ [Portfolio] Wallet ${wallet.id}: totalPnl30d=${totalPnl30d.toFixed(4)} SOL (from closed positions, same as detail), totalCost30d=${totalCost30d.toFixed(4)} SOL, pnlPercent30d=${pnlPercent30d.toFixed(2)}%`);
    }
    
    
    // Calculate 30d PnL from closed positions (same logic as detail page)
    // This ensures consistency between homepage and detail page
    const pnl30dFromPortfolio = totalPnl30d; // Už jsme to vypočítali výše, nemusíme znovu
    const pnl30dPercentFromPortfolio = pnlPercent30d; // Už jsme to vypočítali výše, nemusíme znovu
    
    // Získej aktuální SOL cenu pro přepočet na USD
    let solPriceUsd = 150.0; // Fallback
    try {
      solPriceUsd = await solPriceCacheService.getCurrentSolPrice();
    } catch (error: any) {
      console.warn(`   ⚠️  Failed to fetch SOL price, using fallback: $${solPriceUsd}`);
    }
    
    // Přepočet PnL a volume na USD
    const pnl30dUsdValue = pnl30dFromPortfolio * solPriceUsd;
    const totalCost30dUsd = totalCost30d * solPriceUsd;
    
    // Ulož do cache
    const now = new Date().toISOString();
    const responseData = {
      closedPositions,
      pnl30d: pnl30dFromPortfolio, // PnL v SOL za posledních 30 dní (stejná logika jako detail)
      pnl30dPercent: pnl30dPercentFromPortfolio, // PnL % za posledních 30 dní (pro kompatibilitu)
      pnl30dUsdValue, // USD hodnota pro zobrazení (místo procent)
      totalCost30dUsd, // USD hodnota cost pro zobrazení
      solPriceUsd, // Aktuální SOL cena pro frontend
      lastUpdated: now,
      cached: false,
      baseToken: primaryBaseToken, // Primary base token for this wallet
    };

    // PortfolioBaseline cache (Supabase) je v Prisma-only režimu vypnutá
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
// DŮLEŽITÉ: PnL se počítá POUZE z ClosedLot (jednotný princip s metrics calculator)
router.get('/:id/pnl', async (req, res) => {
  try {
    const identifier = req.params.id;
    // Try to find by ID first (if it's a short ID), then by address
    let wallet: any = await smartWalletRepo.findById(identifier);
    if (!wallet) {
      wallet = (await smartWalletRepo.findByAddress(identifier)) as any;
    }
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    const walletId = wallet.id;

    // DŮLEŽITÉ: Použij ClosedLot místo trades pro konzistentní výpočet PnL
    // ClosedLot jsou fixní a nezávislé na aktuálních cenách
    const { ClosedLotRepository } = await import('../repositories/closed-lot.repository.js');
    const closedLotRepo = new ClosedLotRepository();
    
    // Get all closed lots for this wallet
    const allClosedLots = await closedLotRepo.findByWallet(walletId);
    
    // #region agent log
    const sample5Lots = allClosedLots.slice(0,5).map(l=>({realizedPnl:l.realizedPnl,realizedPnlUsd:l.realizedPnlUsd,exitTime:l.exitTime?.toISOString?.()}));
    fetch('http://127.0.0.1:7242/ingest/d9d466c4-864c-48e8-9710-84e03ea195a8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'smart-wallets.ts:1278',message:'DETAIL PAGE - all ClosedLots loaded',data:{walletId,totalLots:allClosedLots.length,sample5Lots},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H6'})}).catch(()=>{});
    // #endregion
    
    // Get all trades for volume calculation (volume = sum of all trades, not just closed lots)
    const allTrades = await tradeRepo.findByWalletId(walletId, {
      page: 1,
      pageSize: 10000, // Get all trades
    });
    const trades = allTrades.trades;

    // Calculate PnL for different periods
    const now = new Date();
    const periods = {
      '1d': new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      '7d': new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      '14d': new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
      '30d': new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
    };
    
    // Získej aktuální SOL cenu pro přepočet na USD
    let solPriceUsd = 150.0; // Fallback
    try {
      solPriceUsd = await solPriceCacheService.getCurrentSolPrice();
    } catch (error: any) {
      console.warn(`   ⚠️  Failed to fetch SOL price, using fallback: $${solPriceUsd}`);
    }
    
    const pnlData: Record<string, { pnl: number; pnlUsd: number; pnlPercent: number; pnlUsdValue: number; volumeBase: number; volumeUsdValue: number; trades: number; volumeTrades: number }> = {};
    
    for (const [period, fromDate] of Object.entries(periods)) {
      // Filter closed lots by exitTime (when the lot was closed)
      const periodClosedLots = allClosedLots.filter(lot => {
        if (!lot.exitTime) return false;
        const exitTime = new Date(lot.exitTime);
        return exitTime >= fromDate && exitTime <= now;
      });

      // Calculate PnL from ClosedLot (všechny hodnoty jsou v SOL)
      // DŮLEŽITÉ: realizedPnl je vždy v SOL (USDC/USDT se převedou na SOL při výpočtu)
      const totalPnl = periodClosedLots.reduce((sum, lot) => {
        return sum + (lot.realizedPnl || 0);
      }, 0);

      // Calculate cost basis (všechny hodnoty jsou v SOL)
      const totalCostBasis = periodClosedLots.reduce((sum, lot) => {
        return sum + (lot.costBasis || 0);
      }, 0);

      // #region agent log
      if(period==='30d'){
        fetch('http://127.0.0.1:7242/ingest/d9d466c4-864c-48e8-9710-84e03ea195a8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'smart-wallets.ts:1337',message:'DETAIL PAGE - 30d PnL calculated (SOL)',data:{period,periodLotsCount:periodClosedLots.length,totalPnl,totalCostBasis},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H6'})}).catch(()=>{});
      }
      // #endregion

      // Calculate PnL percentage (ROI) - vše v SOL
      const pnlPercent = totalCostBasis > 0
        ? (totalPnl / totalCostBasis) * 100
        : 0;

      // Volume = sum of all trade values (valueUsd) in this period
      // Volume is calculated from trades, not closed lots (includes all trades, not just closed positions)
      const periodTrades = trades.filter(t => {
        const tradeDate = new Date(t.timestamp);
        const side = (t.side || '').toLowerCase();
        // Exclude void trades (token-to-token swaps without SOL/USDC/USDT)
        const isInPeriod = tradeDate >= fromDate;
        const isNotVoid = side !== 'void';
        return isInPeriod && isNotVoid;
      });

      // DŮLEŽITÉ: Volume se počítá z amountBase (v SOL), ne z valueUsd (v USD)
      // Pokud je trade v USDC/USDT, amountBase je v USDC/USDT, ale to je OK - volume je součet všech trades
      // Pro přesný výpočet bychom museli převádět USDC/USDT na SOL, ale pro zobrazení volume to není nutné
      const volumeBase = periodTrades.reduce((sum, trade) => {
        const amountBase = trade.amountBase != null ? Number(trade.amountBase) : 0;
        return sum + amountBase; // Součet amountBase (v SOL nebo USDC/USDT)
      }, 0);

      // Přepočet na USD
      const pnlUsdValue = totalPnl * solPriceUsd;
      const volumeUsdValue = volumeBase * solPriceUsd;
      
      pnlData[period] = {
        pnl: totalPnl, // PnL v SOL (všechny hodnoty jsou v SOL)
        pnlUsd: totalPnl, // PnL v SOL (kompatibilita - frontend očekává pnlUsd, ale obsahuje SOL)
        pnlPercent, // ROI v % (pro kompatibilitu)
        pnlUsdValue, // USD hodnota PnL pro zobrazení (místo procent)
        trades: periodClosedLots.length, // Počet closed lots (uzavřených pozic)
        volumeBase, // Volume v SOL (součet všech trades)
        volumeUsdValue, // USD hodnota volume pro zobrazení (místo procent)
        volumeTrades: periodTrades.length, // Počet všech trades (BUY + SELL) v tomto období
      };
      
      // #region agent log - Debug period PnL calculation
      if (period === '30d') {
        fetch('http://127.0.0.1:7242/ingest/d9d466c4-864c-48e8-9710-84e03ea195a8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'smart-wallets.ts:1330',message:'30d PnL period calculation',data:{period,totalPnl,pnlPercent,periodLotsCount:periodClosedLots.length,volumeBase},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H7'})}).catch(()=>{});
      }
      // #endregion
    }

    // Get daily PnL data for charts from ClosedLot (všechny hodnoty jsou v SOL)
    const dailyPnl: Array<{ date: string; pnl: number; cumulativePnl: number }> = [];
    const lotsByDate = new Map<string, number>();
    
    allClosedLots
      .filter(lot => lot.exitTime)
      .forEach(lot => {
        const date = new Date(lot.exitTime!).toISOString().split('T')[0];
        // Všechny hodnoty jsou v SOL (realizedPnl je vždy v SOL)
        const lotPnl = lot.realizedPnl || 0;
        lotsByDate.set(date, (lotsByDate.get(date) || 0) + lotPnl);
      });

    let cumulativePnl = 0;
    Array.from(lotsByDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([date, pnl]) => {
        cumulativePnl += pnl;
        dailyPnl.push({ date, pnl, cumulativePnl });
      });

    // Detect primary base token from trades (for multichain support)
    // Count base tokens from recent trades to determine primary base token
    const baseTokenCounts = new Map<string, number>();
    for (const trade of trades.slice(0, 100)) { // Check last 100 trades
      const meta = (trade.meta as any) || {};
      const baseToken = (meta.baseToken || 'SOL').toUpperCase();
      baseTokenCounts.set(baseToken, (baseTokenCounts.get(baseToken) || 0) + 1);
    }
    
    // Find most common base token, default to SOL
    let primaryBaseToken = 'SOL';
    let maxCount = 0;
    for (const [token, count] of baseTokenCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        primaryBaseToken = token;
      }
    }
    
    // Normalize WSOL → SOL for display
    if (primaryBaseToken === 'WSOL') {
      primaryBaseToken = 'SOL';
    }

    // #region agent log - Debug PnL API response
    const sample30d = pnlData['30d'];
    fetch('http://127.0.0.1:7242/ingest/d9d466c4-864c-48e8-9710-84e03ea195a8',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'smart-wallets.ts:1360',message:'PnL API response',data:{walletId,periods:Object.keys(pnlData),sample30d:{pnl:sample30d?.pnl,pnlUsd:sample30d?.pnlUsd,pnlPercent:sample30d?.pnlPercent},primaryBaseToken},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H7'})}).catch(()=>{});
    // #endregion

    // DEBUG: Log what we're sending to frontend
    console.log(`🔍 [Backend] PnL API response for wallet ${walletId}:`, {
      baseToken: primaryBaseToken,
      sample30d: {
        pnl: sample30d?.pnl,
        pnlUsd: sample30d?.pnlUsd,
        pnlPercent: sample30d?.pnlPercent,
        volumeBase: sample30d?.volumeBase,
        pnlType: typeof sample30d?.pnl,
        pnlUsdType: typeof sample30d?.pnlUsd,
      },
      allPeriods: Object.keys(pnlData).map(period => ({
        period,
        pnl: pnlData[period]?.pnl,
        pnlUsd: pnlData[period]?.pnlUsd,
        volumeBase: pnlData[period]?.volumeBase,
      })),
    });

    res.json({
      periods: pnlData,
      solPriceUsd, // Aktuální SOL cena pro frontend
      daily: dailyPnl,
      baseToken: primaryBaseToken, // Primary base token for this wallet
    });
  } catch (error: any) {
    console.error('❌ Error fetching PnL data:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
    });
  }
});

// DELETE /api/smart-wallets/:id/positions/:tokenId - Delete a closed position
// Query params: sequenceNumber (required) - deletes specific closed position cycle
router.delete('/:id/positions/:tokenId', async (req, res) => {
  try {
    const identifier = req.params.id;
    const tokenId = req.params.tokenId;
    const sequenceNumber = req.query.sequenceNumber ? parseInt(req.query.sequenceNumber as string) : undefined;

    console.log(`🗑️  DELETE /api/smart-wallets/:id/positions/:tokenId - identifier=${identifier}, tokenId=${tokenId}, sequenceNumber=${sequenceNumber}`);

    // Find wallet - support both ID and address (same as GET endpoint)
    let wallet: any = await smartWalletRepo.findById(identifier);
    if (!wallet) {
      // If not found by ID, try by address
      console.log(`   🔍 Wallet not found by ID, trying by address...`);
      wallet = await smartWalletRepo.findByAddress(identifier);
    }
    if (!wallet) {
      console.log(`   ❌ Wallet not found: ${identifier}`);
      return res.status(404).json({ error: 'Wallet not found' });
    }
    
    console.log(`   ✅ Wallet found: id=${wallet.id}, address=${wallet.address}`);
    const walletId = wallet.id;

    const { ClosedLotRepository } = await import('../repositories/closed-lot.repository.js');
    const closedLotRepo = new ClosedLotRepository();
    const { LotMatchingService } = await import('../services/lot-matching.service.js');
    const { TradeFeatureRepository } = await import('../repositories/trade-feature.repository.js');
    const lotMatchingService = new LotMatchingService(new TradeFeatureRepository());

    let deletedTrades = 0;
    let deletedClosedLots = 0;

    if (sequenceNumber !== undefined && sequenceNumber !== null) {
      // DELETE CLOSED POSITION (specific cycle)
      console.log(`🗑️  Deleting closed position: walletId=${walletId}, tokenId=${tokenId}, sequenceNumber=${sequenceNumber}`);

      // 1. Find ClosedLots for this cycle
      const closedLots = await closedLotRepo.findByWallet(walletId);
      const lotsToDelete = closedLots.filter(
        (lot) => lot.tokenId === tokenId && lot.sequenceNumber === sequenceNumber
      );

      if (lotsToDelete.length === 0) {
        return res.status(404).json({ error: 'Closed position not found' });
      }

      // 2. Collect all trade IDs from these ClosedLots
      const tradeIdsToDelete = new Set<string>();
      for (const lot of lotsToDelete) {
        if (lot.buyTradeId) tradeIdsToDelete.add(lot.buyTradeId);
        if (lot.sellTradeId) tradeIdsToDelete.add(lot.sellTradeId);
      }

      // 3. Find all trades for this token and wallet in the time range of this cycle
      // (to catch ADD/REM trades between BUY and SELL)
      const firstEntryTime = lotsToDelete.reduce(
        (min, lot) => (lot.entryTime < min ? lot.entryTime : min),
        lotsToDelete[0].entryTime
      );
      const lastExitTime = lotsToDelete.reduce(
        (max, lot) => (lot.exitTime > max ? lot.exitTime : max),
        lotsToDelete[0].exitTime
      );

      const allTrades = await tradeRepo.findByWalletId(walletId, {
        tokenId,
        fromDate: new Date(firstEntryTime.getTime() - 60000), // 1 minute before
        toDate: new Date(lastExitTime.getTime() + 60000), // 1 minute after
      });

      // Add trades that are between firstEntryTime and lastExitTime
      for (const trade of allTrades.trades) {
        const tradeTime = new Date(trade.timestamp);
        if (tradeTime >= firstEntryTime && tradeTime <= lastExitTime) {
          tradeIdsToDelete.add(trade.id);
        }
      }

      // 4. Delete ClosedLots
      deletedClosedLots = await closedLotRepo.deleteByWalletAndToken(walletId, tokenId, sequenceNumber);
      console.log(`   ✅ Deleted ${deletedClosedLots} closed lots`);

      // 5. Delete trades
      deletedTrades = await tradeRepo.deleteByIds(Array.from(tradeIdsToDelete));
      console.log(`   ✅ Deleted ${deletedTrades} trades`);
    } else {
      // sequenceNumber is required for deleting closed positions
      return res.status(400).json({ error: 'sequenceNumber is required for deleting closed positions' });
    }

    // 6. Recalculate closed lots (to update any remaining positions)
    console.log(`   🔄 Recalculating closed lots...`);
    const closedLots = await lotMatchingService.processTradesForWallet(walletId);
    await lotMatchingService.saveClosedLots(closedLots);

    // 7. Recalculate metrics (this updates totalTrades, PnL, score, etc.)
    console.log(`   🔄 Recalculating metrics (totalTrades, PnL, score, etc.)...`);
    await metricsCalculator.calculateMetricsForWallet(walletId);

    // 8. Fetch updated wallet data to ensure metrics are saved
    const updatedWallet = await smartWalletRepo.findById(walletId);
    if (!updatedWallet) {
      throw new Error('Failed to fetch updated wallet data');
    }

    console.log(`   ✅ Metrics updated: totalTrades=${updatedWallet.totalTrades}, recentPnl30dUsd=${updatedWallet.recentPnl30dUsd}`);

    res.json({
      success: true,
      deletedTrades,
      deletedClosedLots: deletedClosedLots || 0,
      updatedMetrics: {
        totalTrades: updatedWallet.totalTrades,
        recentPnl30dUsd: updatedWallet.recentPnl30dUsd,
        recentPnl30dPercent: updatedWallet.recentPnl30dPercent,
        score: updatedWallet.score,
      },
      message: `Closed position (cycle ${sequenceNumber}) deleted successfully`,
    });
  } catch (error: any) {
    console.error('❌ Error deleting position:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
    });
  }
});

// POST /api/smart-wallets/:id/recalculate - Force recalculate closed positions and metrics
// Use this endpoint when closed positions or PnL appear incorrect
router.post('/:id/recalculate', async (req, res) => {
  try {
    const identifier = req.params.id;
    
    // Find wallet - support both ID and address
    let wallet: any = await smartWalletRepo.findById(identifier);
    if (!wallet) {
      wallet = await smartWalletRepo.findByAddress(identifier);
    }
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    console.log(`🔄 [Recalculate] Starting recalculation for wallet ${wallet.address.substring(0, 8)}...`);
    
    // 1. Get wallet tracking start time
    const trackingStartTime = wallet.createdAt ? new Date(wallet.createdAt) : undefined;
    
    // 2. Recalculate closed lots (FIFO matching)
    console.log(`   📊 Recalculating closed lots...`);
    const closedLots = await lotMatchingService.processTradesForWallet(
      wallet.id,
      undefined, // Process all tokens
      trackingStartTime
    );
    await lotMatchingService.saveClosedLots(closedLots);
    console.log(`   ✅ Created ${closedLots.length} closed lots`);
    
    // 3. Recalculate metrics
    console.log(`   📊 Recalculating metrics...`);
    const metricsResult = await metricsCalculator.calculateMetricsForWallet(wallet.id);
    console.log(`   ✅ Metrics updated: score=${metricsResult?.score ?? 'n/a'}, totalTrades=${metricsResult?.totalTrades ?? 0}`);
    
    // 4. Invalidate portfolio cache (Supabase) – v Prisma-only režimu není potřeba
    
    // 5. Fetch updated wallet data
    const updatedWallet = await smartWalletRepo.findById(wallet.id);
    
    res.json({
      success: true,
      message: `Recalculated ${closedLots.length} closed lots and updated metrics`,
      closedLotsCount: closedLots.length,
      metrics: {
        score: updatedWallet?.score ?? 0,
        totalTrades: updatedWallet?.totalTrades ?? 0,
        winRate: updatedWallet?.winRate ?? 0,
        recentPnl30dUsd: updatedWallet?.recentPnl30dUsd ?? 0,
        recentPnl30dPercent: updatedWallet?.recentPnl30dPercent ?? 0,
      },
    });
  } catch (error: any) {
    console.error('❌ Error recalculating wallet:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
    });
  }
});

// GET /api/smart-wallets/:id/copytrading-analytics - Get copytrading analytics for a wallet
// Provides insights for copytrading bot conditions
router.get('/:id/copytrading-analytics', async (req, res) => {
  try {
    const identifier = req.params.id;
    
    // Find wallet - support both ID and address
    let wallet: any = await smartWalletRepo.findById(identifier);
    if (!wallet) {
      wallet = (await smartWalletRepo.findByAddress(identifier)) as any;
    }
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const { CopytradingAnalyticsService } = await import('../services/copytrading-analytics.service.js');
    const analyticsService = new CopytradingAnalyticsService();
    
    const analytics = await analyticsService.getAnalyticsForWallet(wallet.id);
    
    res.json({
      walletId: wallet.id,
      walletAddress: wallet.address,
      analytics,
    });
  } catch (error: any) {
    console.error('❌ Error fetching copytrading analytics:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
    });
  }
});

export { router as smartWalletRouter };

