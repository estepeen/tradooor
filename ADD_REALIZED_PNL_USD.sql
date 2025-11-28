-- Add realizedPnlUsd field to ClosedLot table
-- This stores the USD value of realized PnL at the time of position closure
-- This ensures PnL values don't change with fluctuating SOL prices

ALTER TABLE "ClosedLot" 
ADD COLUMN IF NOT EXISTS "realizedPnlUsd" DECIMAL(36, 18);

-- Add index for performance
CREATE INDEX IF NOT EXISTS "ClosedLot_realizedPnlUsd_idx" ON "ClosedLot"("realizedPnlUsd");

-- Add comment
COMMENT ON COLUMN "ClosedLot"."realizedPnlUsd" IS 'Realized PnL in USD at the time of position closure (fixed value, does not change with SOL price)';

