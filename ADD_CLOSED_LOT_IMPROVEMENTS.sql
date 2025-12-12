-- Add improvements to ClosedLot table for copytrading data collection
-- Priority 1: Entry/Exit Timing, Market Conditions, Stop-Loss/Take-Profit detection

-- 1. Entry/Exit Timing Metrics
ALTER TABLE "ClosedLot" 
ADD COLUMN IF NOT EXISTS "entryHourOfDay" INTEGER, -- Hour of day (0-23) when entry occurred
ADD COLUMN IF NOT EXISTS "entryDayOfWeek" INTEGER, -- Day of week (0=Sunday, 1=Monday, ..., 6=Saturday)
ADD COLUMN IF NOT EXISTS "exitHourOfDay" INTEGER, -- Hour of day (0-23) when exit occurred
ADD COLUMN IF NOT EXISTS "exitDayOfWeek" INTEGER; -- Day of week (0=Sunday, 1=Monday, ..., 6=Saturday)

-- 2. Market Conditions at Entry/Exit
ALTER TABLE "ClosedLot"
ADD COLUMN IF NOT EXISTS "entryMarketCap" DECIMAL(36, 18), -- Market cap at entry (USD)
ADD COLUMN IF NOT EXISTS "exitMarketCap" DECIMAL(36, 18), -- Market cap at exit (USD)
ADD COLUMN IF NOT EXISTS "entryLiquidity" DECIMAL(36, 18), -- Liquidity at entry (USD)
ADD COLUMN IF NOT EXISTS "exitLiquidity" DECIMAL(36, 18), -- Liquidity at exit (USD)
ADD COLUMN IF NOT EXISTS "entryVolume24h" DECIMAL(36, 18), -- 24h volume at entry (USD)
ADD COLUMN IF NOT EXISTS "exitVolume24h" DECIMAL(36, 18), -- 24h volume at exit (USD)
ADD COLUMN IF NOT EXISTS "tokenAgeAtEntryMinutes" INTEGER; -- Token age in minutes at entry

-- 3. Stop-Loss/Take-Profit Detection
ALTER TABLE "ClosedLot"
ADD COLUMN IF NOT EXISTS "exitReason" TEXT, -- 'take_profit' | 'stop_loss' | 'manual' | 'unknown'
ADD COLUMN IF NOT EXISTS "maxProfitPercent" DECIMAL(36, 18), -- Maximum profit % during hold period
ADD COLUMN IF NOT EXISTS "maxDrawdownPercent" DECIMAL(36, 18), -- Maximum drawdown % during hold period
ADD COLUMN IF NOT EXISTS "timeToMaxProfitMinutes" INTEGER; -- Time to reach max profit (minutes from entry)

-- 4. DCA Tracking (if multiple buys before sell)
ALTER TABLE "ClosedLot"
ADD COLUMN IF NOT EXISTS "dcaEntryCount" INTEGER, -- Number of BUY trades that form this closed lot
ADD COLUMN IF NOT EXISTS "dcaTimeSpanMinutes" INTEGER; -- Time span from first BUY to last BUY before SELL

-- 5. Re-entry Patterns
ALTER TABLE "ClosedLot"
ADD COLUMN IF NOT EXISTS "reentryTimeMinutes" INTEGER, -- Time from previous exit to this entry (null for first cycle)
ADD COLUMN IF NOT EXISTS "reentryPriceChangePercent" DECIMAL(36, 18), -- Price change % from previous exit
ADD COLUMN IF NOT EXISTS "previousCyclePnl" DECIMAL(36, 18); -- PnL of previous cycle (for comparison)

-- Indexes for performance
CREATE INDEX IF NOT EXISTS "ClosedLot_entryHourOfDay_idx" ON "ClosedLot"("entryHourOfDay");
CREATE INDEX IF NOT EXISTS "ClosedLot_entryDayOfWeek_idx" ON "ClosedLot"("entryDayOfWeek");
CREATE INDEX IF NOT EXISTS "ClosedLot_exitHourOfDay_idx" ON "ClosedLot"("exitHourOfDay");
CREATE INDEX IF NOT EXISTS "ClosedLot_exitDayOfWeek_idx" ON "ClosedLot"("exitDayOfWeek");
CREATE INDEX IF NOT EXISTS "ClosedLot_exitReason_idx" ON "ClosedLot"("exitReason");
CREATE INDEX IF NOT EXISTS "ClosedLot_tokenAgeAtEntryMinutes_idx" ON "ClosedLot"("tokenAgeAtEntryMinutes");

-- Comments
COMMENT ON COLUMN "ClosedLot"."entryHourOfDay" IS 'Hour of day (0-23) when entry occurred - for timing analysis';
COMMENT ON COLUMN "ClosedLot"."entryDayOfWeek" IS 'Day of week (0=Sunday, 6=Saturday) when entry occurred - for timing analysis';
COMMENT ON COLUMN "ClosedLot"."exitHourOfDay" IS 'Hour of day (0-23) when exit occurred - for timing analysis';
COMMENT ON COLUMN "ClosedLot"."exitDayOfWeek" IS 'Day of week (0=Sunday, 6=Saturday) when exit occurred - for timing analysis';
COMMENT ON COLUMN "ClosedLot"."entryMarketCap" IS 'Market cap at entry (USD) - for market condition analysis';
COMMENT ON COLUMN "ClosedLot"."exitMarketCap" IS 'Market cap at exit (USD) - for market condition analysis';
COMMENT ON COLUMN "ClosedLot"."entryLiquidity" IS 'Liquidity at entry (USD) - for market condition analysis';
COMMENT ON COLUMN "ClosedLot"."exitLiquidity" IS 'Liquidity at exit (USD) - for market condition analysis';
COMMENT ON COLUMN "ClosedLot"."entryVolume24h" IS '24h volume at entry (USD) - for market condition analysis';
COMMENT ON COLUMN "ClosedLot"."exitVolume24h" IS '24h volume at exit (USD) - for market condition analysis';
COMMENT ON COLUMN "ClosedLot"."tokenAgeAtEntryMinutes" IS 'Token age in minutes at entry - for sniper trade detection';
COMMENT ON COLUMN "ClosedLot"."exitReason" IS 'Exit reason: take_profit, stop_loss, manual, or unknown';
COMMENT ON COLUMN "ClosedLot"."maxProfitPercent" IS 'Maximum profit % during hold period - for take-profit detection';
COMMENT ON COLUMN "ClosedLot"."maxDrawdownPercent" IS 'Maximum drawdown % during hold period - for stop-loss detection';
COMMENT ON COLUMN "ClosedLot"."timeToMaxProfitMinutes" IS 'Time to reach max profit (minutes from entry) - for timing analysis';
COMMENT ON COLUMN "ClosedLot"."dcaEntryCount" IS 'Number of BUY trades that form this closed lot - for DCA tracking';
COMMENT ON COLUMN "ClosedLot"."dcaTimeSpanMinutes" IS 'Time span from first BUY to last BUY before SELL - for DCA tracking';
COMMENT ON COLUMN "ClosedLot"."reentryTimeMinutes" IS 'Time from previous exit to this entry (null for first cycle) - for re-entry pattern analysis';
COMMENT ON COLUMN "ClosedLot"."reentryPriceChangePercent" IS 'Price change % from previous exit - for re-entry pattern analysis';
COMMENT ON COLUMN "ClosedLot"."previousCyclePnl" IS 'PnL of previous cycle (for comparison) - for re-entry pattern analysis';
