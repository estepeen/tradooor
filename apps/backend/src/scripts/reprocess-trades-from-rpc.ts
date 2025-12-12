/**
 * Reprocess Solana trades directly from RPC transactions to fix incorrect amounts/prices.
 *
 * Usage examples:
 *   pnpm reprocess:trades-from-rpc --signature <txSignature> [--dry-run]
 *   pnpm reprocess:trades-from-rpc --wallet <walletAddress> [--limit 100] [--dry-run]
 *   pnpm reprocess:trades-from-rpc --all [--batch 100] [--dry-run]
 *
 * Requirements:
 *   - QUICKNODE_RPC_URL (preferred) or SOLANA_RPC_URL must be set
 *   - Birdeye/Binance credentials (same as for collector) for USD conversion
 */

import 'dotenv/config';
import { supabase, TABLES } from '../lib/supabase.js';
import { SmartWalletRepository } from '../repositories/smart-wallet.repository.js';
import { TokenPriceService } from '../services/token-price.service.js';
import { BinancePriceService } from '../services/binance-price.service.js';
import { normalizeQuickNodeSwap, NormalizedSwap } from '../services/solana-collector.service.js';

type CliOptions = {
  signature?: string;
  wallet?: string;
  all?: boolean;
  limit?: number;
  dryRun?: boolean;
  batchSize?: number;
};

type TradeRecord = {
  id: string;
  txSignature: string;
  walletId: string;
  tokenId: string;
  amountBase: string;
  amountToken: string;
  priceBasePerToken: string;
  timestamp: string;
  dex: string | null;
  meta: any;
};

const RPC_URL =
  process.env.QUICKNODE_RPC_URL ||
  process.env.SOLANA_RPC_URL;

if (!RPC_URL) {
  console.error('❌ QUICKNODE_RPC_URL (nebo SOLANA_RPC_URL) není nastaveno. Nelze stáhnout transakce z RPC.');
  process.exit(1);
}

const walletRepo = new SmartWalletRepository();
const tokenPriceService = new TokenPriceService();
const binancePriceService = new BinancePriceService();

const walletCache = new Map<string, { id: string; address: string }>();
const transactionCache = new Map<string, any>();

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {};

  const getValue = (flag: string) => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    return undefined;
  };

  const sig = getValue('--signature');
  if (sig) opts.signature = sig;

  const wallet = getValue('--wallet');
  if (wallet) opts.wallet = wallet;

  if (args.includes('--all')) {
    opts.all = true;
  }

  const limit = getValue('--limit');
  if (limit) {
    opts.limit = Number(limit);
  }

  const batch = getValue('--batch');
  if (batch) {
    opts.batchSize = Number(batch);
  }

  if (args.includes('--dry-run')) {
    opts.dryRun = true;
  }

  return opts;
}

async function fetchRpcTransaction(signature: string): Promise<any | null> {
  if (transactionCache.has(signature)) {
    return transactionCache.get(signature);
  }

  const body = {
    jsonrpc: '2.0',
    id: signature,
    method: 'getTransaction',
    params: [
      signature,
      {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      },
    ],
  };

  try {
    const response = await fetch(RPC_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`RPC response ${response.status}`);
    }

    const payload = (await response.json()) as any;
    if (!payload.result) {
      console.warn(`   ⚠️  RPC nevrátil data pro tx ${signature}`);
      return null;
    }

    transactionCache.set(signature, payload.result);
    return payload.result;
  } catch (error: any) {
    console.error(`   ❌ RPC fetch selhal pro ${signature}: ${error.message}`);
    return null;
  }
}

async function getWalletById(walletId: string) {
  if (walletCache.has(walletId)) {
    return walletCache.get(walletId)!;
  }
  const wallet = await walletRepo.findById(walletId);
  if (!wallet) {
    console.warn(`   ⚠️  Wallet ${walletId} nenalezena`);
    return null;
  }
  walletCache.set(walletId, wallet);
  return wallet;
}

async function loadTrades(opts: CliOptions): Promise<TradeRecord[]> {
  if (opts.signature) {
    const { data, error } = await supabase
      .from(TABLES.TRADE)
      .select('*')
      .eq('txSignature', opts.signature);
    if (error) {
      throw new Error(`Failed to fetch trade by signature: ${error.message}`);
    }
    return (data as TradeRecord[]) ?? [];
  }

  if (opts.wallet) {
    const wallet = await walletRepo.findByAddress(opts.wallet);
    if (!wallet) {
      throw new Error(`Wallet ${opts.wallet} not found`);
    }
    const { data, error } = await supabase
      .from(TABLES.TRADE)
      .select('*')
      .eq('walletId', wallet.id)
      .order('timestamp', { ascending: true })
      .limit(opts.limit ?? 1000);
    if (error) {
      throw new Error(`Failed to fetch trades for wallet: ${error.message}`);
    }
    return (data as TradeRecord[]) ?? [];
  }

  if (opts.all) {
    const batchSize = opts.batchSize ?? 200;
    let offset = 0;
    const trades: TradeRecord[] = [];
    while (true) {
      const end = offset + batchSize - 1;
      const { data, error } = await supabase
        .from(TABLES.TRADE)
        .select('*')
        .order('timestamp', { ascending: true })
        .range(offset, end);
      if (error) {
        throw new Error(`Failed to fetch trades batch: ${error.message}`);
      }
      const batch = (data as TradeRecord[]) ?? [];
      trades.push(...batch);
      if (batch.length < batchSize) {
        break;
      }
      offset += batchSize;
    }
    return trades;
  }

  throw new Error(
    'Specify --signature <tx>, --wallet <address>, or --all to select trades.'
  );
}

async function convertNormalizedToUsd(
  normalized: NormalizedSwap
): Promise<{ amountBaseUsd: number; priceBasePerTokenUsd: number }> {
  let amountBaseUsd = 0;
  let priceBasePerTokenUsd = 0;

  if (normalized.baseToken === 'SOL') {
    const solPriceUsd = await binancePriceService.getSolPriceAtTimestamp(
      normalized.timestamp
    );
    amountBaseUsd = normalized.amountBase * solPriceUsd;
    priceBasePerTokenUsd = normalized.priceBasePerToken * solPriceUsd;
  } else if (
    normalized.baseToken === 'USDC' ||
    normalized.baseToken === 'USDT'
  ) {
    amountBaseUsd = normalized.amountBase;
    priceBasePerTokenUsd = normalized.priceBasePerToken;
  } else {
    const secondaryTokenPrice =
      await tokenPriceService.getTokenPriceAtDate(
        normalized.baseToken,
        normalized.timestamp
      );
    if (secondaryTokenPrice && secondaryTokenPrice > 0) {
      amountBaseUsd = normalized.amountBase * secondaryTokenPrice;
      priceBasePerTokenUsd =
        normalized.priceBasePerToken * secondaryTokenPrice;
    } else {
      console.warn(
        `   ⚠️  Nelze získat USD cenu pro sekundární token ${normalized.baseToken.substring(
          0,
          8
        )}..., fallback na SOL`
      );
      const solPriceUsd = await binancePriceService.getSolPriceAtTimestamp(
        normalized.timestamp
      );
      amountBaseUsd = normalized.amountBase * solPriceUsd;
      priceBasePerTokenUsd =
        normalized.priceBasePerToken * solPriceUsd;
    }
  }

  return {
    amountBaseUsd,
    priceBasePerTokenUsd,
  };
}

async function updateTradeRecord(
  trade: TradeRecord,
  normalized: NormalizedSwap,
  amountBaseUsd: number,
  priceBasePerTokenUsd: number,
  dryRun: boolean
) {
  const existingMeta = trade.meta ?? {};
  const nextMeta = {
    ...existingMeta,
    baseToken: normalized.baseToken,
    reprocessedAt: new Date().toISOString(),
    reprocessSource: 'rpc-script',
  };

  const updates = {
    amountToken: normalized.amountToken.toString(),
    amountBase: amountBaseUsd.toString(),
    priceBasePerToken: priceBasePerTokenUsd.toString(),
    valueUsd: amountBaseUsd.toString(),
    dex: normalized.dex,
    meta: nextMeta,
  };

  if (dryRun) {
    console.log(
      `   📝 [DRY RUN] Trade ${trade.id} -> amountBase=${
        updates.amountBase
      }, priceBasePerToken=${updates.priceBasePerToken}`
    );
    return;
  }

  const { error } = await supabase
    .from(TABLES.TRADE)
    .update(updates)
    .eq('id', trade.id);

  if (error) {
    throw new Error(`Failed to update trade ${trade.id}: ${error.message}`);
  }
}

async function processTrade(
  trade: TradeRecord,
  opts: CliOptions
): Promise<'updated' | 'skipped' | 'error'> {
  try {
    const wallet = await getWalletById(trade.walletId);
    if (!wallet) {
      return 'skipped';
    }

    const rpcTx = await fetchRpcTransaction(trade.txSignature);
    if (!rpcTx) {
      return 'skipped';
    }

    const normalized = normalizeQuickNodeSwap(
      rpcTx,
      wallet.address,
      rpcTx.blockTime
    );
    if (!normalized) {
      console.warn(
        `   ⚠️  normalizeQuickNodeSwap vrátil null pro ${trade.txSignature}`
      );
      return 'skipped';
    }

    const { amountBaseUsd, priceBasePerTokenUsd } =
      await convertNormalizedToUsd(normalized);

    // Pokud se nová hodnota prakticky neliší od staré, přeskoč
    const existingAmountBase = Number(trade.amountBase || 0);
    if (
      Math.abs(existingAmountBase - amountBaseUsd) < 0.001 &&
      normalized.dex === trade.dex
    ) {
      return 'skipped';
    }

    await updateTradeRecord(
      trade,
      normalized,
      amountBaseUsd,
      priceBasePerTokenUsd,
      !!opts.dryRun
    );
    return 'updated';
  } catch (error: any) {
    console.error(`   ❌ Chyba při reprocessingu trade ${trade.id}:`, error.message);
    return 'error';
  }
}

async function main() {
  const opts = parseArgs();
  console.log('🔄 Spouštím reprocess trades skript s parametry:', opts);

  const trades = await loadTrades(opts);
  console.log(`📦 Nalezeno ${trades.length} trade(s) k reprocessingu`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const trade of trades) {
    const result = await processTrade(trade, opts);
    if (result === 'updated') updated++;
    else if (result === 'skipped') skipped++;
    else errors++;
  }

  console.log('\n✅ Hotovo');
  console.log(`   Updated: ${updated}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Errors: ${errors}`);

  if (opts.dryRun) {
    console.log('\nℹ️  Byl použit --dry-run, žádná data se nezměnila.');
  }
}

main().catch((error) => {
  console.error('❌ Skript selhal:', error);
  process.exit(1);
});

