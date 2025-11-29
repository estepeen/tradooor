-- Add sequenceNumber field to ClosedLot table
-- This field indicates which BUY-SELL cycle (1st, 2nd, 3rd, etc.) a closed lot belongs to for a given token
-- This allows distinguishing between multiple trading cycles for the same token

ALTER TABLE "ClosedLot" 
ADD COLUMN IF NOT EXISTS "sequenceNumber" INTEGER;

-- Add index for performance (when querying by token and sequence)
CREATE INDEX IF NOT EXISTS "ClosedLot_tokenId_sequenceNumber_idx" ON "ClosedLot"("tokenId", "sequenceNumber");

-- Add comment
COMMENT ON COLUMN "ClosedLot"."sequenceNumber" IS 'Indicates which BUY-SELL cycle (1st, 2nd, 3rd, etc.) this closed lot belongs to for the given token. NULL for old records without sequence tracking.';

