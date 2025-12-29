-- Add score7d, score30d, recentPnl7dPercent, recentPnl7dBase columns to SmartWallet
-- This enables 7d/30d hybrid scoring for better memecoin trader evaluation

-- Add new score columns
ALTER TABLE "SmartWallet" ADD COLUMN IF NOT EXISTS "score7d" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "SmartWallet" ADD COLUMN IF NOT EXISTS "score30d" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Add new 7d PnL tracking columns
ALTER TABLE "SmartWallet" ADD COLUMN IF NOT EXISTS "recentPnl7dPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "SmartWallet" ADD COLUMN IF NOT EXISTS "recentPnl7dBase" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Add comments for documentation
COMMENT ON COLUMN "SmartWallet"."score7d" IS 'Skóre založené na posledních 7 dnech (0-100) - better for memecoin volatility';
COMMENT ON COLUMN "SmartWallet"."score30d" IS 'Skóre založené na posledních 30 dnech (0-100) - longer term view';
COMMENT ON COLUMN "SmartWallet"."recentPnl7dPercent" IS 'PnL za posledních 7 dní v %';
COMMENT ON COLUMN "SmartWallet"."recentPnl7dBase" IS 'PnL for last 7 days in base currency (SOL/USDC/USDT)';
