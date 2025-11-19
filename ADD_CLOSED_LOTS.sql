-- Create closed_lots table for FIFO lot-matching
-- This table stores matched buy/sell pairs with accurate PnL and hold time

CREATE TABLE IF NOT EXISTS "ClosedLot" (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "walletId" TEXT NOT NULL REFERENCES "SmartWallet"(id) ON DELETE CASCADE,
  "tokenId" TEXT NOT NULL REFERENCES "Token"(id) ON DELETE CASCADE,
  
  -- Lot details
  size DECIMAL(36, 18) NOT NULL, -- Amount of tokens in this lot
  "entryPrice" DECIMAL(36, 18) NOT NULL, -- Buy price per token
  "exitPrice" DECIMAL(36, 18) NOT NULL, -- Sell price per token
  "entryTime" TIMESTAMP NOT NULL, -- When the lot was bought
  "exitTime" TIMESTAMP NOT NULL, -- When the lot was sold
  "holdTimeMinutes" INTEGER NOT NULL, -- Hold time in minutes (exitTime - entryTime)
  
  -- PnL calculations
  "costBasis" DECIMAL(36, 18) NOT NULL, -- size * entryPrice (total cost)
  "proceeds" DECIMAL(36, 18) NOT NULL, -- size * exitPrice (total proceeds)
  "realizedPnl" DECIMAL(36, 18) NOT NULL, -- proceeds - costBasis
  "realizedPnlPercent" DECIMAL(36, 18) NOT NULL, -- (realizedPnl / costBasis) * 100
  
  -- Trade references
  "buyTradeId" TEXT REFERENCES "Trade"(id) ON DELETE CASCADE, -- NULL for synthetic/pre-history lots
  "sellTradeId" TEXT NOT NULL REFERENCES "Trade"(id) ON DELETE CASCADE,
  
  -- Flags
  "isPreHistory" BOOLEAN NOT NULL DEFAULT false, -- True if this lot was created from pre-history (synthetic)
  "costKnown" BOOLEAN NOT NULL DEFAULT true, -- True if we know the actual cost basis (false for pre-history)
  
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS "ClosedLot_walletId_idx" ON "ClosedLot"("walletId");
CREATE INDEX IF NOT EXISTS "ClosedLot_tokenId_idx" ON "ClosedLot"("tokenId");
CREATE INDEX IF NOT EXISTS "ClosedLot_walletId_tokenId_idx" ON "ClosedLot"("walletId", "tokenId");
CREATE INDEX IF NOT EXISTS "ClosedLot_exitTime_idx" ON "ClosedLot"("exitTime");
CREATE INDEX IF NOT EXISTS "ClosedLot_buyTradeId_idx" ON "ClosedLot"("buyTradeId");
CREATE INDEX IF NOT EXISTS "ClosedLot_sellTradeId_idx" ON "ClosedLot"("sellTradeId");
CREATE INDEX IF NOT EXISTS "ClosedLot_costKnown_idx" ON "ClosedLot"("costKnown");
CREATE INDEX IF NOT EXISTS "ClosedLot_isPreHistory_idx" ON "ClosedLot"("isPreHistory");

-- Add comment
COMMENT ON TABLE "ClosedLot" IS 'Stores matched buy/sell pairs (lots) with accurate PnL and hold time using FIFO matching';

