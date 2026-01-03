import { prisma } from '../lib/prisma.js';
import { createId } from '@paralleldrive/cuid2';

export interface SignalGateCheckRecord {
  id: string;
  tokenMint: string;
  tokenSymbol: string | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;

  // LIQUIDITY GATE
  liquidity5minChange: number | null;
  liquidity15minChange: number | null;
  liquidityMcapRatio: number | null;
  liquidityGatePassed: boolean;
  liquidityGateReason: string | null;

  // MOMENTUM GATE
  buySellVolumeRatio: number | null;
  buyerSellerRatio: number | null;
  priceMomentum5min: number | null;
  priceAboveMa1min: boolean;
  priceAboveMa5min: boolean;
  momentumGatePassed: boolean;
  momentumGateReason: string | null;

  // RISK GATE
  largeSellDetected: boolean;
  largeSellPercent: number | null;
  largeSellValueUsd: number | null;
  riskGatePassed: boolean;
  riskGateReason: string | null;

  // WALLET GATE
  tier: string | null;
  walletCount: number | null;
  requiredWallets: number | null;
  uniqueBuyersInWindow: number | null;
  requiredUniqueBuyers: number | null;
  qualityWalletCount: number | null;
  requiredQualityWallets: number | null;
  walletGatePassed: boolean;
  walletGateReason: string | null;

  // Overall
  allGatesPassed: boolean;
  signalEmitted: boolean;
  blockReason: string | null;

  // Priority fee
  priorityFeeLamports: number | null;
  priorityFeeReason: string | null;

  // Timing metrics (ms)
  totalProcessingMs: number | null;
  holderCheckMs: number | null;
  insiderCheckMs: number | null;
  preChecksMs: number | null;

  createdAt: Date;
}

export interface GateCheckInput {
  tokenMint: string;
  tokenSymbol?: string;
  marketCapUsd?: number;
  liquidityUsd?: number;

  // LIQUIDITY GATE
  liquidity5minChange?: number;
  liquidity15minChange?: number;
  liquidityMcapRatio?: number;
  liquidityGatePassed?: boolean;
  liquidityGateReason?: string;

  // MOMENTUM GATE
  buySellVolumeRatio?: number;
  buyerSellerRatio?: number;
  priceMomentum5min?: number;
  priceAboveMa1min?: boolean;
  priceAboveMa5min?: boolean;
  momentumGatePassed?: boolean;
  momentumGateReason?: string;

  // RISK GATE
  largeSellDetected?: boolean;
  largeSellPercent?: number;
  largeSellValueUsd?: number;
  riskGatePassed?: boolean;
  riskGateReason?: string;

  // WALLET GATE
  tier?: string;
  walletCount?: number;
  requiredWallets?: number;
  uniqueBuyersInWindow?: number;
  requiredUniqueBuyers?: number;
  qualityWalletCount?: number;
  requiredQualityWallets?: number;
  walletGatePassed?: boolean;
  walletGateReason?: string;

  // Overall
  allGatesPassed?: boolean;
  signalEmitted?: boolean;
  blockReason?: string;

  // Priority fee
  priorityFeeLamports?: number;
  priorityFeeReason?: string;

  // Timing metrics (ms)
  totalProcessingMs?: number;
  holderCheckMs?: number;
  insiderCheckMs?: number;
  preChecksMs?: number;
}

export class SignalGateCheckRepository {
  /**
   * Log a gate check result
   */
  async create(data: GateCheckInput): Promise<SignalGateCheckRecord> {
    const id = createId();
    const result = await prisma.$queryRaw<SignalGateCheckRecord[]>`
      INSERT INTO "SignalGateCheck" (
        "id", "tokenMint", "tokenSymbol", "marketCapUsd", "liquidityUsd",
        "liquidity5minChange", "liquidity15minChange", "liquidityMcapRatio",
        "liquidityGatePassed", "liquidityGateReason",
        "buySellVolumeRatio", "buyerSellerRatio", "priceMomentum5min",
        "priceAboveMa1min", "priceAboveMa5min", "momentumGatePassed", "momentumGateReason",
        "largeSellDetected", "largeSellPercent", "largeSellValueUsd",
        "riskGatePassed", "riskGateReason",
        "tier", "walletCount", "requiredWallets",
        "uniqueBuyersInWindow", "requiredUniqueBuyers",
        "qualityWalletCount", "requiredQualityWallets",
        "walletGatePassed", "walletGateReason",
        "allGatesPassed", "signalEmitted", "blockReason",
        "priorityFeeLamports", "priorityFeeReason",
        "totalProcessingMs", "holderCheckMs", "insiderCheckMs", "preChecksMs"
      ) VALUES (
        ${id}, ${data.tokenMint}, ${data.tokenSymbol ?? null}, ${data.marketCapUsd ?? null}, ${data.liquidityUsd ?? null},
        ${data.liquidity5minChange ?? null}, ${data.liquidity15minChange ?? null}, ${data.liquidityMcapRatio ?? null},
        ${data.liquidityGatePassed ?? false}, ${data.liquidityGateReason ?? null},
        ${data.buySellVolumeRatio ?? null}, ${data.buyerSellerRatio ?? null}, ${data.priceMomentum5min ?? null},
        ${data.priceAboveMa1min ?? false}, ${data.priceAboveMa5min ?? false}, ${data.momentumGatePassed ?? false}, ${data.momentumGateReason ?? null},
        ${data.largeSellDetected ?? false}, ${data.largeSellPercent ?? null}, ${data.largeSellValueUsd ?? null},
        ${data.riskGatePassed ?? false}, ${data.riskGateReason ?? null},
        ${data.tier ?? null}, ${data.walletCount ?? null}, ${data.requiredWallets ?? null},
        ${data.uniqueBuyersInWindow ?? null}, ${data.requiredUniqueBuyers ?? null},
        ${data.qualityWalletCount ?? null}, ${data.requiredQualityWallets ?? null},
        ${data.walletGatePassed ?? false}, ${data.walletGateReason ?? null},
        ${data.allGatesPassed ?? false}, ${data.signalEmitted ?? false}, ${data.blockReason ?? null},
        ${data.priorityFeeLamports ?? null}, ${data.priorityFeeReason ?? null},
        ${data.totalProcessingMs ?? null}, ${data.holderCheckMs ?? null}, ${data.insiderCheckMs ?? null}, ${data.preChecksMs ?? null}
      )
      RETURNING *
    `;
    return result[0];
  }

  /**
   * Get gate check stats for a date range
   */
  async getStatsForDateRange(startDate: Date, endDate: Date): Promise<{
    total: number;
    passed: number;
    blocked: number;
    blockedByLiquidity: number;
    blockedByMomentum: number;
    blockedByRisk: number;
    blockedByWallet: number;
  }> {
    const result = await prisma.$queryRaw<Array<{
      total: bigint;
      passed: bigint;
      blocked: bigint;
      blocked_liquidity: bigint;
      blocked_momentum: bigint;
      blocked_risk: bigint;
      blocked_wallet: bigint;
    }>>`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE "allGatesPassed" = true) as passed,
        COUNT(*) FILTER (WHERE "allGatesPassed" = false) as blocked,
        COUNT(*) FILTER (WHERE "liquidityGatePassed" = false) as blocked_liquidity,
        COUNT(*) FILTER (WHERE "momentumGatePassed" = false AND "liquidityGatePassed" = true) as blocked_momentum,
        COUNT(*) FILTER (WHERE "riskGatePassed" = false AND "momentumGatePassed" = true AND "liquidityGatePassed" = true) as blocked_risk,
        COUNT(*) FILTER (WHERE "walletGatePassed" = false AND "riskGatePassed" = true AND "momentumGatePassed" = true AND "liquidityGatePassed" = true) as blocked_wallet
      FROM "SignalGateCheck"
      WHERE "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
    `;

    const stats = result[0];
    return {
      total: Number(stats.total),
      passed: Number(stats.passed),
      blocked: Number(stats.blocked),
      blockedByLiquidity: Number(stats.blocked_liquidity),
      blockedByMomentum: Number(stats.blocked_momentum),
      blockedByRisk: Number(stats.blocked_risk),
      blockedByWallet: Number(stats.blocked_wallet),
    };
  }

  /**
   * Get recent gate checks (for debugging)
   */
  async getRecent(limit: number = 20): Promise<SignalGateCheckRecord[]> {
    return prisma.$queryRaw<SignalGateCheckRecord[]>`
      SELECT * FROM "SignalGateCheck"
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;
  }

  /**
   * Get top block reasons for a date range
   */
  async getTopBlockReasons(startDate: Date, endDate: Date, limit: number = 10): Promise<Array<{ reason: string; count: number }>> {
    const result = await prisma.$queryRaw<Array<{ reason: string; count: bigint }>>`
      SELECT "blockReason" as reason, COUNT(*) as count
      FROM "SignalGateCheck"
      WHERE "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
        AND "blockReason" IS NOT NULL
      GROUP BY "blockReason"
      ORDER BY count DESC
      LIMIT ${limit}
    `;
    return result.map(r => ({ reason: r.reason, count: Number(r.count) }));
  }

  /**
   * Get unique tokens checked in date range
   */
  async getUniqueTokensCount(startDate: Date, endDate: Date): Promise<number> {
    const result = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT "tokenMint") as count
      FROM "SignalGateCheck"
      WHERE "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
    `;
    return Number(result[0].count);
  }

  /**
   * Get timing statistics for emitted signals in a date range
   */
  async getTimingStatsForDateRange(startDate: Date, endDate: Date): Promise<{
    count: number;
    avgTotalMs: number | null;
    minTotalMs: number | null;
    maxTotalMs: number | null;
    avgHolderCheckMs: number | null;
    avgInsiderCheckMs: number | null;
    avgPreChecksMs: number | null;
  }> {
    const result = await prisma.$queryRaw<Array<{
      count: bigint;
      avg_total: number | null;
      min_total: number | null;
      max_total: number | null;
      avg_holder: number | null;
      avg_insider: number | null;
      avg_pre: number | null;
    }>>`
      SELECT
        COUNT(*) as count,
        AVG("totalProcessingMs")::float as avg_total,
        MIN("totalProcessingMs") as min_total,
        MAX("totalProcessingMs") as max_total,
        AVG("holderCheckMs")::float as avg_holder,
        AVG("insiderCheckMs")::float as avg_insider,
        AVG("preChecksMs")::float as avg_pre
      FROM "SignalGateCheck"
      WHERE "signalEmitted" = true
        AND "totalProcessingMs" IS NOT NULL
        AND "createdAt" >= ${startDate} AND "createdAt" < ${endDate}
    `;

    const stats = result[0];
    return {
      count: Number(stats.count),
      avgTotalMs: stats.avg_total,
      minTotalMs: stats.min_total,
      maxTotalMs: stats.max_total,
      avgHolderCheckMs: stats.avg_holder,
      avgInsiderCheckMs: stats.avg_insider,
      avgPreChecksMs: stats.avg_pre,
    };
  }
}
