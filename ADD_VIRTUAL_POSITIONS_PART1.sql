-- PART 1: VirtualPosition table + indexes
-- Spusť tuto část PRVNÍ

CREATE TABLE IF NOT EXISTS "VirtualPosition" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  
  -- Základní info
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  "consensusSignalId" TEXT REFERENCES "ConsensusSignal"("id") ON DELETE SET NULL,
  
  -- Entry info
  "entryPriceUsd" DECIMAL(36, 18) NOT NULL,
  "entryTime" TIMESTAMP WITH TIME ZONE NOT NULL,
  "entryWalletCount" INT NOT NULL DEFAULT 2,
  "entryMarketCapUsd" DECIMAL(36, 18),
  "entryLiquidityUsd" DECIMAL(36, 18),
  
  -- Current state
  "currentPriceUsd" DECIMAL(36, 18),
  "currentMarketCapUsd" DECIMAL(36, 18),
  "lastPriceUpdate" TIMESTAMP WITH TIME ZONE,
  
  -- P&L tracking
  "unrealizedPnlPercent" DECIMAL(10, 4),
  "unrealizedPnlUsd" DECIMAL(36, 18),
  "highestPriceUsd" DECIMAL(36, 18),
  "lowestPriceUsd" DECIMAL(36, 18),
  "maxDrawdownPercent" DECIMAL(10, 4),
  
  -- Wallet tracking
  "activeWalletCount" INT NOT NULL DEFAULT 0,
  "exitedWalletCount" INT NOT NULL DEFAULT 0,
  "walletIds" TEXT[],
  
  -- Position status
  "status" TEXT NOT NULL DEFAULT 'open',
  "exitReason" TEXT,
  "exitPriceUsd" DECIMAL(36, 18),
  "exitTime" TIMESTAMP WITH TIME ZONE,
  "realizedPnlPercent" DECIMAL(10, 4),
  "realizedPnlUsd" DECIMAL(36, 18),
  
  -- AI recommendations
  "lastAiDecision" TEXT,
  "lastAiConfidence" DECIMAL(5, 2),
  "lastAiReasoning" TEXT,
  "lastAiEvaluation" TIMESTAMP WITH TIME ZONE,
  
  -- Risk management
  "suggestedStopLoss" DECIMAL(36, 18),
  "suggestedTakeProfit" DECIMAL(36, 18),
  "trailingStopPercent" DECIMAL(5, 2),
  
  -- Notifications
  "lastNotificationSent" TIMESTAMP WITH TIME ZONE,
  "notificationCount" INT DEFAULT 0,
  
  -- Timestamps
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexy
CREATE INDEX IF NOT EXISTS "VirtualPosition_status_idx" ON "VirtualPosition" ("status");
CREATE INDEX IF NOT EXISTS "VirtualPosition_tokenId_idx" ON "VirtualPosition" ("tokenId");
CREATE INDEX IF NOT EXISTS "VirtualPosition_entryTime_idx" ON "VirtualPosition" ("entryTime" DESC);
CREATE INDEX IF NOT EXISTS "VirtualPosition_unrealizedPnlPercent_idx" ON "VirtualPosition" ("unrealizedPnlPercent" DESC);
CREATE INDEX IF NOT EXISTS "VirtualPosition_createdAt_idx" ON "VirtualPosition" ("createdAt" DESC);

