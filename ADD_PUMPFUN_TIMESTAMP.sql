-- Migration: Add lastPumpfunTradeTimestamp to SmartWallet table
-- Run this in Supabase SQL Editor

ALTER TABLE "SmartWallet" 
ADD COLUMN IF NOT EXISTS "lastPumpfunTradeTimestamp" TIMESTAMP WITH TIME ZONE;

-- Add index for faster queries
CREATE INDEX IF NOT EXISTS "SmartWallet_lastPumpfunTradeTimestamp_idx" 
ON "SmartWallet"("lastPumpfunTradeTimestamp");

-- Set initial timestamp for existing wallets (optional - can be NULL)
-- UPDATE "SmartWallet" SET "lastPumpfunTradeTimestamp" = NOW() WHERE "lastPumpfunTradeTimestamp" IS NULL;

