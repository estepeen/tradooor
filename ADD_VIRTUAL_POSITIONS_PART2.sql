-- PART 2: PositionWalletActivity table + indexes
-- Spusť tuto část DRUHOU

CREATE TABLE IF NOT EXISTS "PositionWalletActivity" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "positionId" TEXT NOT NULL REFERENCES "VirtualPosition"("id") ON DELETE CASCADE,
  "walletId" TEXT NOT NULL REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  
  -- Entry info
  "entryTradeId" TEXT,
  "entryPriceUsd" DECIMAL(36, 18),
  "entryAmountUsd" DECIMAL(36, 18),
  "entryTime" TIMESTAMP WITH TIME ZONE,
  
  -- Exit info (if sold)
  "exitTradeId" TEXT,
  "exitPriceUsd" DECIMAL(36, 18),
  "exitAmountUsd" DECIMAL(36, 18),
  "exitTime" TIMESTAMP WITH TIME ZONE,
  
  -- Status
  "status" TEXT NOT NULL DEFAULT 'holding',
  "holdingPercent" DECIMAL(5, 2) DEFAULT 100,
  
  -- P&L
  "realizedPnlPercent" DECIMAL(10, 4),
  "realizedPnlUsd" DECIMAL(36, 18),
  
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE("positionId", "walletId")
);

CREATE INDEX IF NOT EXISTS "PositionWalletActivity_positionId_idx" ON "PositionWalletActivity" ("positionId");
CREATE INDEX IF NOT EXISTS "PositionWalletActivity_walletId_idx" ON "PositionWalletActivity" ("walletId");
CREATE INDEX IF NOT EXISTS "PositionWalletActivity_status_idx" ON "PositionWalletActivity" ("status");

