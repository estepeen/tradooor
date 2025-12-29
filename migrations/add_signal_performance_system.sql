-- Migration: Add Signal Performance Tracking System
-- Description: Creates tables for tracking signal performance, virtual positions, exit signals, and wallet activity
-- Date: 2024-12-30

-- 1. Create SignalPerformance table
CREATE TABLE IF NOT EXISTS "SignalPerformance" (
    "id" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,

    -- Entry data
    "entryPriceUsd" DECIMAL(36, 18) NOT NULL,
    "entryMarketCapUsd" DECIMAL(36, 18),
    "entryLiquidityUsd" DECIMAL(36, 18),
    "entryTimestamp" TIMESTAMP(3) NOT NULL,

    -- Price tracking
    "currentPriceUsd" DECIMAL(36, 18),
    "highestPriceUsd" DECIMAL(36, 18),
    "lowestPriceUsd" DECIMAL(36, 18),
    "highestPriceTime" TIMESTAMP(3),
    "lowestPriceTime" TIMESTAMP(3),

    -- PnL tracking
    "currentPnlPercent" DECIMAL(36, 18),
    "maxPnlPercent" DECIMAL(36, 18),
    "minPnlPercent" DECIMAL(36, 18),
    "drawdownFromPeak" DECIMAL(36, 18),

    -- Milestone snapshots (JSON)
    "priceSnapshots" JSONB,
    "pnlSnapshots" JSONB,

    -- Timing analysis
    "timeToPeakMinutes" INTEGER,
    "timeToTroughMinutes" INTEGER,

    -- Outcome
    "status" TEXT NOT NULL DEFAULT 'active',
    "exitReason" TEXT,
    "exitPriceUsd" DECIMAL(36, 18),
    "exitTimestamp" TIMESTAMP(3),
    "realizedPnlPercent" DECIMAL(36, 18),

    -- Optimal exit analysis
    "optimalExitPrice" DECIMAL(36, 18),
    "optimalExitTime" TIMESTAMP(3),
    "missedPnlPercent" DECIMAL(36, 18),

    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalPerformance_pkey" PRIMARY KEY ("id")
);

-- 2. Create VirtualPosition table
CREATE TABLE IF NOT EXISTS "VirtualPosition" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "signalId" TEXT,
    "consensusSignalId" TEXT,

    -- Entry data
    "entryPriceUsd" DECIMAL(36, 18) NOT NULL,
    "entryTimestamp" TIMESTAMP(3) NOT NULL,
    "entryWalletCount" INTEGER NOT NULL DEFAULT 1,
    "entryMarketCapUsd" DECIMAL(36, 18),
    "entryLiquidityUsd" DECIMAL(36, 18),

    -- Position tracking
    "positionSizeUsd" DECIMAL(36, 18),
    "currentPriceUsd" DECIMAL(36, 18),
    "lastPriceUpdate" TIMESTAMP(3),

    -- PnL tracking
    "unrealizedPnlPercent" DECIMAL(36, 18),
    "unrealizedPnlUsd" DECIMAL(36, 18),

    -- Price extremes
    "highestPriceUsd" DECIMAL(36, 18),
    "lowestPriceUsd" DECIMAL(36, 18),
    "drawdownFromPeak" DECIMAL(36, 18),

    -- Wallet tracking
    "walletIds" TEXT[],
    "activeWalletCount" INTEGER NOT NULL DEFAULT 0,
    "exitedWalletCount" INTEGER NOT NULL DEFAULT 0,

    -- Exit strategy
    "suggestedStopLoss" DECIMAL(36, 18),
    "suggestedTakeProfit" DECIMAL(36, 18),
    "trailingStopPercent" DECIMAL(36, 18),
    "trailingStopPrice" DECIMAL(36, 18),

    -- AI exit tracking
    "lastAiDecision" TEXT,
    "lastAiConfidence" INTEGER,
    "lastAiReasoning" TEXT,
    "lastAiEvaluation" TIMESTAMP(3),

    -- Status
    "status" TEXT NOT NULL DEFAULT 'open',
    "exitReason" TEXT,
    "exitPriceUsd" DECIMAL(36, 18),
    "exitTimestamp" TIMESTAMP(3),
    "realizedPnlPercent" DECIMAL(36, 18),
    "realizedPnlUsd" DECIMAL(36, 18),

    -- Notifications
    "lastNotificationSent" TIMESTAMP(3),
    "notificationCount" INTEGER NOT NULL DEFAULT 0,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VirtualPosition_pkey" PRIMARY KEY ("id")
);

-- 3. Create ExitSignal table
CREATE TABLE IF NOT EXISTS "ExitSignal" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,

    -- Signal type
    "type" TEXT NOT NULL,
    "strength" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,

    -- Context at signal time
    "priceAtSignal" DECIMAL(36, 18),
    "pnlPercentAtSignal" DECIMAL(36, 18),
    "drawdownAtSignal" DECIMAL(36, 18),

    -- Wallet exit context
    "walletsExitedCount" INTEGER,
    "walletsHoldingCount" INTEGER,
    "triggerWalletId" TEXT,
    "triggerTradeId" TEXT,
    "triggerReason" TEXT,

    -- AI context
    "aiDecision" TEXT,
    "aiConfidence" INTEGER,
    "aiReasoning" TEXT,

    -- Market context
    "marketCapAtSignal" DECIMAL(36, 18),
    "liquidityAtSignal" DECIMAL(36, 18),
    "volume1hAtSignal" DECIMAL(36, 18),

    -- Notification
    "notificationSent" BOOLEAN NOT NULL DEFAULT false,
    "notificationSentAt" TIMESTAMP(3),
    "discordMessageId" TEXT,

    -- Outcome
    "wasActedOn" BOOLEAN,
    "pnlIfActed" DECIMAL(36, 18),
    "pnlActual" DECIMAL(36, 18),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExitSignal_pkey" PRIMARY KEY ("id")
);

-- 4. Create PositionWalletActivity table
CREATE TABLE IF NOT EXISTS "PositionWalletActivity" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,

    -- Entry data
    "entryTradeId" TEXT,
    "entryPriceUsd" DECIMAL(36, 18),
    "entryAmountUsd" DECIMAL(36, 18),
    "entryTimestamp" TIMESTAMP(3),

    -- Exit data
    "exitTradeId" TEXT,
    "exitPriceUsd" DECIMAL(36, 18),
    "exitAmountUsd" DECIMAL(36, 18),
    "exitTimestamp" TIMESTAMP(3),

    -- Status
    "status" TEXT NOT NULL DEFAULT 'holding',
    "holdingPercent" DECIMAL(36, 18) NOT NULL DEFAULT 100,

    -- PnL
    "realizedPnlPercent" DECIMAL(36, 18),
    "realizedPnlUsd" DECIMAL(36, 18),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionWalletActivity_pkey" PRIMARY KEY ("id")
);

-- 5. Create unique constraints
ALTER TABLE "SignalPerformance" ADD CONSTRAINT "SignalPerformance_signalId_key" UNIQUE ("signalId");
ALTER TABLE "PositionWalletActivity" ADD CONSTRAINT "PositionWalletActivity_positionId_walletId_key" UNIQUE ("positionId", "walletId");

-- 6. Create indexes for SignalPerformance
CREATE INDEX IF NOT EXISTS "SignalPerformance_signalId_idx" ON "SignalPerformance"("signalId");
CREATE INDEX IF NOT EXISTS "SignalPerformance_tokenId_idx" ON "SignalPerformance"("tokenId");
CREATE INDEX IF NOT EXISTS "SignalPerformance_status_idx" ON "SignalPerformance"("status");
CREATE INDEX IF NOT EXISTS "SignalPerformance_entryTimestamp_idx" ON "SignalPerformance"("entryTimestamp");

-- 7. Create indexes for VirtualPosition
CREATE INDEX IF NOT EXISTS "VirtualPosition_tokenId_idx" ON "VirtualPosition"("tokenId");
CREATE INDEX IF NOT EXISTS "VirtualPosition_signalId_idx" ON "VirtualPosition"("signalId");
CREATE INDEX IF NOT EXISTS "VirtualPosition_status_idx" ON "VirtualPosition"("status");
CREATE INDEX IF NOT EXISTS "VirtualPosition_entryTimestamp_idx" ON "VirtualPosition"("entryTimestamp");

-- 8. Create indexes for ExitSignal
CREATE INDEX IF NOT EXISTS "ExitSignal_positionId_idx" ON "ExitSignal"("positionId");
CREATE INDEX IF NOT EXISTS "ExitSignal_tokenId_idx" ON "ExitSignal"("tokenId");
CREATE INDEX IF NOT EXISTS "ExitSignal_type_idx" ON "ExitSignal"("type");
CREATE INDEX IF NOT EXISTS "ExitSignal_createdAt_idx" ON "ExitSignal"("createdAt");

-- 9. Create indexes for PositionWalletActivity
CREATE INDEX IF NOT EXISTS "PositionWalletActivity_positionId_idx" ON "PositionWalletActivity"("positionId");
CREATE INDEX IF NOT EXISTS "PositionWalletActivity_walletId_idx" ON "PositionWalletActivity"("walletId");
CREATE INDEX IF NOT EXISTS "PositionWalletActivity_status_idx" ON "PositionWalletActivity"("status");

-- 10. Add foreign key constraints
ALTER TABLE "SignalPerformance"
    ADD CONSTRAINT "SignalPerformance_signalId_fkey"
    FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SignalPerformance"
    ADD CONSTRAINT "SignalPerformance_tokenId_fkey"
    FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VirtualPosition"
    ADD CONSTRAINT "VirtualPosition_tokenId_fkey"
    FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VirtualPosition"
    ADD CONSTRAINT "VirtualPosition_signalId_fkey"
    FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ExitSignal"
    ADD CONSTRAINT "ExitSignal_positionId_fkey"
    FOREIGN KEY ("positionId") REFERENCES "VirtualPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExitSignal"
    ADD CONSTRAINT "ExitSignal_tokenId_fkey"
    FOREIGN KEY ("tokenId") REFERENCES "Token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PositionWalletActivity"
    ADD CONSTRAINT "PositionWalletActivity_positionId_fkey"
    FOREIGN KEY ("positionId") REFERENCES "VirtualPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PositionWalletActivity"
    ADD CONSTRAINT "PositionWalletActivity_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "SmartWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add comments for documentation
COMMENT ON TABLE "SignalPerformance" IS 'Tracks performance of each signal over time - price milestones, max/min, exit analysis';
COMMENT ON TABLE "VirtualPosition" IS 'Virtual positions created from consensus signals - tracks active holdings';
COMMENT ON TABLE "ExitSignal" IS 'Exit signals generated for virtual positions (wallet_exit, stop_loss, take_profit, etc.)';
COMMENT ON TABLE "PositionWalletActivity" IS 'Tracks individual wallet activity within a virtual position';
