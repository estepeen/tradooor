-- Create open_positions table for storing current open positions
-- This table stores aggregated open positions (remaining lots) for each wallet/token
-- Updated whenever a new trade is processed

CREATE TABLE IF NOT EXISTS "OpenPosition" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "walletId" TEXT NOT NULL REFERENCES "SmartWallet"(id) ON DELETE CASCADE,
  "tokenId" TEXT NOT NULL REFERENCES "Token"(id) ON DELETE CASCADE,
  
  -- Position details
  balance DECIMAL(36, 18) NOT NULL, -- Current token balance (sum of remaining open lots)
  "totalCostBase" DECIMAL(36, 18) NOT NULL, -- Total cost basis in base currency (SOL/USDC/USDT)
  "averageBuyPrice" DECIMAL(36, 18) NOT NULL, -- Weighted average entry price
  "firstBuyTimestamp" TIMESTAMP, -- When the position was first opened
  "lastTradeTimestamp" TIMESTAMP, -- When the position was last updated
  
  -- Trade counts
  "buyCount" INTEGER NOT NULL DEFAULT 0, -- Number of BUY/ADD trades
  "sellCount" INTEGER NOT NULL DEFAULT 0, -- Number of SELL trades (partial sells)
  "removeCount" INTEGER NOT NULL DEFAULT 0, -- Number of REM trades
  
  -- Base token info
  "baseToken" TEXT NOT NULL DEFAULT 'SOL', -- Base token used (SOL, USDC, USDT)
  
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  
  -- Unique constraint: one open position per wallet/token
  UNIQUE("walletId", "tokenId")
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS "OpenPosition_walletId_idx" ON "OpenPosition"("walletId");
CREATE INDEX IF NOT EXISTS "OpenPosition_tokenId_idx" ON "OpenPosition"("tokenId");
CREATE INDEX IF NOT EXISTS "OpenPosition_walletId_tokenId_idx" ON "OpenPosition"("walletId", "tokenId");
CREATE INDEX IF NOT EXISTS "OpenPosition_lastTradeTimestamp_idx" ON "OpenPosition"("lastTradeTimestamp");

-- Add comment
COMMENT ON TABLE "OpenPosition" IS 'Stores current open positions (remaining lots) for each wallet/token, updated on each trade';
