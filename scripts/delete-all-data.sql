-- Script to delete all trades and related data from PostgreSQL database
-- WARNING: This will permanently delete all trade data!
-- IMPORTANT: SIGNALS are PRESERVED - Signal and ConsensusSignal tables are NOT deleted!

-- Disable foreign key checks temporarily (PostgreSQL doesn't have this, but we'll delete in correct order)
-- Delete in order respecting foreign key constraints

-- 1. Delete closed lots
DELETE FROM "ClosedLot";
-- Output: DELETE count

-- 2. Delete trade features
DELETE FROM "TradeFeature";
-- Output: DELETE count

-- 3. Delete normalized trades
DELETE FROM "NormalizedTrade";
-- Output: DELETE count

-- 4. Delete paper trades (they reference Trade via foreign key)
DELETE FROM "PaperTrade";
-- Output: DELETE count

-- 5. Delete trades
DELETE FROM "Trade";
-- Output: DELETE count

-- 6. Delete trade sequences
DELETE FROM "TradeSequence";
-- Output: DELETE count

-- 7. Delete trade outcomes
DELETE FROM "TradeOutcome";
-- Output: DELETE count

-- 8. Delete metrics history
DELETE FROM "SmartWalletMetricsHistory";
-- Output: DELETE count

-- 9. Clear wallet processing queue
DELETE FROM "WalletProcessingQueue";
-- Output: DELETE count

-- 10. Reset all wallet metrics
UPDATE "SmartWallet" SET
  score = 0,
  "totalTrades" = 0,
  "winRate" = 0,
  "avgRr" = 0,
  "avgPnlPercent" = 0,
  "pnlTotalBase" = 0,
  "avgHoldingTimeMin" = 0,
  "maxDrawdownPercent" = 0,
  "recentPnl30dPercent" = 0,
  "recentPnl30dUsd" = 0,
  "advancedStats" = NULL,
  tags = '{}',
  "updatedAt" = NOW();
-- Output: UPDATE count

-- Note: Signal and ConsensusSignal tables are NOT deleted (preserved)

