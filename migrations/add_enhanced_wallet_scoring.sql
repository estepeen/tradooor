-- Migration: Add enhanced wallet scoring columns and trade feature fields
-- Description:
--   - Adds enhanced scoring columns to SmartWallet
--   - Adds entry/exit timing and category fields to TradeFeature
-- Run this in Supabase (or directly on the Postgres instance used by the app).

-- Enhanced scoring columns on SmartWallet
ALTER TABLE "SmartWallet"
  ADD COLUMN IF NOT EXISTS "enhancedScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "percentileRankWinRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "percentileRankRoi" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "positionDisciplineScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "timingIntelligenceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "categorySpecializationBonus" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "marketRegime" TEXT;

-- Enhanced per-trade features for timing and category specialization
ALTER TABLE "TradeFeature"
  ADD COLUMN IF NOT EXISTS "entryRankPercentile" NUMERIC(36, 18),
  ADD COLUMN IF NOT EXISTS "exitEfficiency" NUMERIC(36, 18),
  ADD COLUMN IF NOT EXISTS "tokenCategory" TEXT;

COMMIT;


