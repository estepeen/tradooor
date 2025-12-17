-- PART 3: ExitSignal table + indexes
-- Spusť tuto část TŘETÍ

CREATE TABLE IF NOT EXISTS "ExitSignal" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "positionId" TEXT NOT NULL REFERENCES "VirtualPosition"("id") ON DELETE CASCADE,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  
  -- Signal info
  "type" TEXT NOT NULL,
  "strength" TEXT NOT NULL DEFAULT 'medium',
  "recommendation" TEXT NOT NULL,
  
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

