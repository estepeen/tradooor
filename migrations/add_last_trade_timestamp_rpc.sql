-- Migration: Add RPC function for fetching last trade timestamps efficiently
-- This replaces N+1 queries (200+ individual queries) with a single aggregated query
-- 
-- Run this in Supabase SQL Editor to create the function

-- Create function to get last trade timestamps for multiple wallets
CREATE OR REPLACE FUNCTION get_last_trade_timestamps(wallet_ids text[])
RETURNS TABLE (
  wallet_id text,
  last_timestamp timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT 
    "walletId" as wallet_id,
    MAX(timestamp) as last_timestamp
  FROM "Trade"
  WHERE "walletId" = ANY(wallet_ids)
  GROUP BY "walletId";
$$;

-- Add comment for documentation
COMMENT ON FUNCTION get_last_trade_timestamps(text[]) IS 
  'Returns the last trade timestamp for each wallet ID. Used to efficiently fetch last trade timestamps for wallet list without N+1 queries.';

-- Verify the Trade table has optimal indexes
-- These indexes should already exist based on schema, but let's ensure they're there

-- Index for walletId + timestamp (for sorting and filtering)
CREATE INDEX IF NOT EXISTS "Trade_walletId_timestamp_idx" ON "Trade" ("walletId", timestamp DESC);

-- Index for timestamp alone (for recent trades queries)  
CREATE INDEX IF NOT EXISTS "Trade_timestamp_idx" ON "Trade" (timestamp DESC);

-- Index for tokenId + walletId (for portfolio queries)
CREATE INDEX IF NOT EXISTS "Trade_tokenId_walletId_idx" ON "Trade" ("tokenId", "walletId");

-- ClosedLot indexes for portfolio queries
CREATE INDEX IF NOT EXISTS "ClosedLot_walletId_exitTime_idx" ON "ClosedLot" ("walletId", "exitTime" DESC);
CREATE INDEX IF NOT EXISTS "ClosedLot_walletId_tokenId_idx" ON "ClosedLot" ("walletId", "tokenId");

-- NormalizedTrade indexes for worker processing
CREATE INDEX IF NOT EXISTS "NormalizedTrade_status_timestamp_idx" ON "NormalizedTrade" (status, timestamp);

COMMIT;

