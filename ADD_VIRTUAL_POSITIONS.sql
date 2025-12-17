-- ADD_VIRTUAL_POSITIONS.sql
-- Systém pro sledování virtuálních pozic z consensus signálů

-- ============================================
-- 1. VirtualPosition tabulka
-- ============================================

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
  "highestPriceUsd" DECIMAL(36, 18),      -- ATH since entry
  "lowestPriceUsd" DECIMAL(36, 18),       -- ATL since entry
  "maxDrawdownPercent" DECIMAL(10, 4),    -- Max dropdown from ATH
  
  -- Wallet tracking
  "activeWalletCount" INT NOT NULL DEFAULT 0,   -- Wallets still holding
  "exitedWalletCount" INT NOT NULL DEFAULT 0,   -- Wallets that sold
  "walletIds" TEXT[],                           -- Array of wallet IDs involved
  
  -- Position status
  "status" TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'partial_exit' | 'closed' | 'stopped'
  "exitReason" TEXT,                      -- 'take_profit' | 'stop_loss' | 'wallet_exit' | 'manual' | 'expired'
  "exitPriceUsd" DECIMAL(36, 18),
  "exitTime" TIMESTAMP WITH TIME ZONE,
  "realizedPnlPercent" DECIMAL(10, 4),
  "realizedPnlUsd" DECIMAL(36, 18),
  
  -- AI recommendations
  "lastAiDecision" TEXT,                  -- 'hold' | 'partial_tp' | 'full_exit'
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

-- ============================================
-- 2. Indexy pro rychlé dotazy
-- ============================================

CREATE INDEX IF NOT EXISTS "VirtualPosition_status_idx" ON "VirtualPosition" ("status");
CREATE INDEX IF NOT EXISTS "VirtualPosition_tokenId_idx" ON "VirtualPosition" ("tokenId");
CREATE INDEX IF NOT EXISTS "VirtualPosition_entryTime_idx" ON "VirtualPosition" ("entryTime" DESC);
CREATE INDEX IF NOT EXISTS "VirtualPosition_unrealizedPnlPercent_idx" ON "VirtualPosition" ("unrealizedPnlPercent" DESC);
CREATE INDEX IF NOT EXISTS "VirtualPosition_createdAt_idx" ON "VirtualPosition" ("createdAt" DESC);

-- ============================================
-- 3. PositionWalletActivity - sledování aktivity walletů
-- ============================================

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
  "status" TEXT NOT NULL DEFAULT 'holding', -- 'holding' | 'partial_exit' | 'full_exit'
  "holdingPercent" DECIMAL(5, 2) DEFAULT 100, -- % of original position still held
  
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

-- ============================================
-- 4. ExitSignal - záznamy o exit signálech
-- ============================================

CREATE TABLE IF NOT EXISTS "ExitSignal" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "positionId" TEXT NOT NULL REFERENCES "VirtualPosition"("id") ON DELETE CASCADE,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  
  -- Signal info
  "type" TEXT NOT NULL,  -- 'wallet_exit' | 'stop_loss' | 'take_profit' | 'trailing_stop' | 'ai_recommendation' | 'time_based'
  "strength" TEXT NOT NULL DEFAULT 'medium', -- 'weak' | 'medium' | 'strong'
  "recommendation" TEXT NOT NULL, -- 'hold' | 'partial_exit' | 'full_exit'
  
  -- Context at signal time
  "priceAtSignal" DECIMAL(36, 18),
  "pnlPercentAtSignal" DECIMAL(10, 4),
  "walletsExitedCount" INT,
  "walletsHoldingCount" INT,
  
  -- Trigger info
  "triggerWalletId" TEXT REFERENCES "SmartWallet"("id"),
  "triggerTradeId" TEXT,
  "triggerReason" TEXT,
  
  -- AI evaluation
  "aiDecision" TEXT,
  "aiConfidence" DECIMAL(5, 2),
  "aiReasoning" TEXT,
  
  -- Notification
  "notificationSent" BOOLEAN DEFAULT false,
  "notificationSentAt" TIMESTAMP WITH TIME ZONE,
  
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "ExitSignal_positionId_idx" ON "ExitSignal" ("positionId");
CREATE INDEX IF NOT EXISTS "ExitSignal_tokenId_idx" ON "ExitSignal" ("tokenId");
CREATE INDEX IF NOT EXISTS "ExitSignal_type_idx" ON "ExitSignal" ("type");
CREATE INDEX IF NOT EXISTS "ExitSignal_createdAt_idx" ON "ExitSignal" ("createdAt" DESC);

-- ============================================
-- 5. Trigger pro automatickou aktualizaci updatedAt
-- ============================================

CREATE OR REPLACE FUNCTION update_virtual_position_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS virtual_position_updated_at ON "VirtualPosition";
CREATE TRIGGER virtual_position_updated_at
  BEFORE UPDATE ON "VirtualPosition"
  FOR EACH ROW
  EXECUTE FUNCTION update_virtual_position_updated_at();

DROP TRIGGER IF EXISTS position_wallet_activity_updated_at ON "PositionWalletActivity";
CREATE TRIGGER position_wallet_activity_updated_at
  BEFORE UPDATE ON "PositionWalletActivity"
  FOR EACH ROW
  EXECUTE FUNCTION update_virtual_position_updated_at();

-- ============================================
-- 6. View pro aktivní pozice s detaily
-- ============================================

CREATE OR REPLACE VIEW "ActivePositionsView" AS
SELECT 
  vp."id",
  vp."status",
  vp."entryPriceUsd",
  vp."currentPriceUsd",
  vp."unrealizedPnlPercent",
  vp."unrealizedPnlUsd",
  vp."maxDrawdownPercent",
  vp."activeWalletCount",
  vp."exitedWalletCount",
  vp."entryTime",
  vp."lastAiDecision",
  vp."lastAiConfidence",
  vp."suggestedStopLoss",
  vp."suggestedTakeProfit",
  t."symbol" as "tokenSymbol",
  t."mintAddress" as "tokenMint",
  EXTRACT(EPOCH FROM (NOW() - vp."entryTime")) / 60 as "holdTimeMinutes"
FROM "VirtualPosition" vp
LEFT JOIN "Token" t ON vp."tokenId" = t."id"
WHERE vp."status" = 'open'
ORDER BY vp."unrealizedPnlPercent" DESC;

-- ============================================
-- HOTOVO!
-- ============================================


