-- Migration: Add USD value and PnL columns to Trade table
-- Run this in Supabase SQL Editor

ALTER TABLE "Trade" 
ADD COLUMN IF NOT EXISTS "valueUsd" DECIMAL(36, 18),
ADD COLUMN IF NOT EXISTS "pnlUsd" DECIMAL(36, 18),
ADD COLUMN IF NOT EXISTS "pnlPercent" DECIMAL(36, 18);

-- Add index for faster queries
CREATE INDEX IF NOT EXISTS "Trade_valueUsd_idx" ON "Trade"("valueUsd");
CREATE INDEX IF NOT EXISTS "Trade_pnlUsd_idx" ON "Trade"("pnlUsd");

