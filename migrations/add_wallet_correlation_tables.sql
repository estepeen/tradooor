-- Migration: Add WalletCorrelation and SharedTradeIndex tables
-- Date: 2025-12-29
--
-- Purpose: Enable correlation cluster detection for enhanced signal quality
-- When correlated traders buy together → stronger signal
--
-- Tables:
-- 1. WalletCorrelation - Tracks correlation metrics between wallet pairs
-- 2. SharedTradeIndex - Fast lookup for shared trades (denormalized for performance)

-- Create WalletCorrelation table
CREATE TABLE IF NOT EXISTS "WalletCorrelation" (
  "id" TEXT PRIMARY KEY,
  "walletAId" TEXT NOT NULL,
  "walletBId" TEXT NOT NULL,

  -- Shared trading metrics
  "sharedTrades" INTEGER NOT NULL DEFAULT 0,
  "totalTradesA" INTEGER NOT NULL DEFAULT 0,
  "totalTradesB" INTEGER NOT NULL DEFAULT 0,
  "overlapPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,

  -- Timing correlation
  "avgTimeDiffMinutes" INTEGER NOT NULL DEFAULT 0,

  -- Performance correlation
  "jointSuccessRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "profitCorrelation" DOUBLE PRECISION NOT NULL DEFAULT 0,

  -- Overall cluster strength (0-100 score)
  "clusterStrength" INTEGER NOT NULL DEFAULT 0,

  -- Metadata
  "lastCalculated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  -- Foreign keys
  CONSTRAINT "WalletCorrelation_walletAId_fkey" FOREIGN KEY ("walletAId") REFERENCES "SmartWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WalletCorrelation_walletBId_fkey" FOREIGN KEY ("walletBId") REFERENCES "SmartWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE,

  -- Unique constraint
  CONSTRAINT "WalletCorrelation_walletAId_walletBId_key" UNIQUE ("walletAId", "walletBId")
);

-- Create indexes for WalletCorrelation
CREATE INDEX IF NOT EXISTS "WalletCorrelation_clusterStrength_idx" ON "WalletCorrelation"("clusterStrength" DESC);
CREATE INDEX IF NOT EXISTS "WalletCorrelation_walletAId_idx" ON "WalletCorrelation"("walletAId");
CREATE INDEX IF NOT EXISTS "WalletCorrelation_walletBId_idx" ON "WalletCorrelation"("walletBId");
CREATE INDEX IF NOT EXISTS "WalletCorrelation_lastCalculated_idx" ON "WalletCorrelation"("lastCalculated");

-- Create SharedTradeIndex table
CREATE TABLE IF NOT EXISTS "SharedTradeIndex" (
  "id" TEXT PRIMARY KEY,
  "walletAId" TEXT NOT NULL,
  "walletBId" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,

  -- Trade timestamps
  "tradeAId" TEXT NOT NULL,
  "tradeBId" TEXT NOT NULL,
  "tradeATimestamp" TIMESTAMP(3) NOT NULL,
  "tradeBTimestamp" TIMESTAMP(3) NOT NULL,
  "timeDiffMinutes" INTEGER NOT NULL,

  -- Trade outcomes (for correlation calculation)
  "tradeAPnl" DOUBLE PRECISION,
  "tradeBPnl" DOUBLE PRECISION,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Unique constraint
  CONSTRAINT "SharedTradeIndex_tradeAId_tradeBId_key" UNIQUE ("tradeAId", "tradeBId")
);

-- Create indexes for SharedTradeIndex
CREATE INDEX IF NOT EXISTS "SharedTradeIndex_walletAId_walletBId_idx" ON "SharedTradeIndex"("walletAId", "walletBId");
CREATE INDEX IF NOT EXISTS "SharedTradeIndex_tokenId_idx" ON "SharedTradeIndex"("tokenId");
CREATE INDEX IF NOT EXISTS "SharedTradeIndex_tradeATimestamp_idx" ON "SharedTradeIndex"("tradeATimestamp");

-- Verify migration
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'WalletCorrelation'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'SharedTradeIndex'
  ) THEN
    RAISE NOTICE 'Migration successful: WalletCorrelation and SharedTradeIndex tables created';
  ELSE
    RAISE EXCEPTION 'Migration failed: tables not found';
  END IF;
END $$;
