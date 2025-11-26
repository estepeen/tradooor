-- ⚠️  WARNING: This script will DELETE ALL trading data and reset all wallet metrics!
-- Run this only if you want to start fresh from scratch.

-- 1. Delete all closed lots
DELETE FROM "ClosedLot";

-- 2. Delete all trade features (cascade from trades, but explicit for safety)
DELETE FROM "TradeFeature";

-- 3. Delete all trades (this will cascade delete trade features)
DELETE FROM "Trade";

-- 4. Delete all portfolio baseline cache
DELETE FROM "PortfolioBaseline";

-- 5. Clear wallet processing queue
DELETE FROM "WalletProcessingQueue";

-- 6. Reset all wallet metrics to default values
UPDATE "SmartWallet"
SET 
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
  "updatedAt" = NOW();

-- 7. Delete all metrics history
DELETE FROM "SmartWalletMetricsHistory";

-- 8. (Optional) Delete all tokens that are no longer referenced
-- This is safe because trades are already deleted
-- Uncomment if you want to clean up unused tokens:
-- DELETE FROM "Token" WHERE id NOT IN (SELECT DISTINCT "tokenId" FROM "Trade");

-- Summary
SELECT 
  (SELECT COUNT(*) FROM "Trade") as remaining_trades,
  (SELECT COUNT(*) FROM "ClosedLot") as remaining_closed_lots,
  (SELECT COUNT(*) FROM "TradeFeature") as remaining_trade_features,
  (SELECT COUNT(*) FROM "WalletProcessingQueue") as remaining_queue_jobs,
  (SELECT COUNT(*) FROM "SmartWallet") as total_wallets;



