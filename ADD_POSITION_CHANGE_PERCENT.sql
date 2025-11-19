-- Migration: Add positionChangePercent column to Trade table
-- This column tracks the percentage change in position size for each trade
-- Positive values indicate buying (increasing position), negative values indicate selling (decreasing position)

ALTER TABLE "Trade" 
ADD COLUMN IF NOT EXISTS "positionChangePercent" DECIMAL(36, 18);

-- Add comment to column
COMMENT ON COLUMN "Trade"."positionChangePercent" IS 'Percentage change in position size for this trade. Positive = buy (increased position), Negative = sell (decreased position)';




