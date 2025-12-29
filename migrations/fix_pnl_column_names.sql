-- Migration: Rename PnL columns to reflect correct currency (SOL/base instead of USD)
-- Date: 2025-12-29
--
-- Problem: Columns named "Usd" actually contain values in SOL (base currency)
-- This migration renames them to accurately reflect their content
--
-- IMPORTANT: Run this migration on production database to fix naming inconsistency

-- SmartWallet table: Rename recentPnl30dUsd → recentPnl30dBase
ALTER TABLE "SmartWallet"
  RENAME COLUMN "recentPnl30dUsd" TO "recentPnl30dBase";

COMMENT ON COLUMN "SmartWallet"."recentPnl30dBase" IS 'PnL for last 30 days in base currency (SOL/USDC/USDT)';

-- Verify the migration
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'SmartWallet'
    AND column_name = 'recentPnl30dBase'
  ) THEN
    RAISE NOTICE 'Migration successful: recentPnl30dUsd → recentPnl30dBase';
  ELSE
    RAISE EXCEPTION 'Migration failed: recentPnl30dBase column not found';
  END IF;
END $$;
