-- ADD_AI_SIGNALS.sql
-- Migrace pro rozšířený signálový systém s AI vrstvou

-- ============================================
-- 1. Aktualizuj Signal tabulku (pokud už existuje)
-- ============================================

-- Přidej nové sloupce do Signal tabulky
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "signalSubType" TEXT;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "strength" TEXT;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "aiDecisionId" TEXT;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "executed" BOOLEAN DEFAULT false;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "executedAt" TIMESTAMP WITH TIME ZONE;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "resultPnlPercent" DECIMAL(36, 18);

-- Přidej index pro model/signalSubType
CREATE INDEX IF NOT EXISTS "Signal_model_idx" ON "Signal" ("model");
CREATE INDEX IF NOT EXISTS "Signal_signalSubType_idx" ON "Signal" ("signalSubType");
CREATE INDEX IF NOT EXISTS "Signal_status_createdAt_idx" ON "Signal" ("status", "createdAt" DESC);

-- ============================================
-- 2. Vytvoř AIDecision tabulku
-- ============================================

CREATE TABLE IF NOT EXISTS "AIDecision" (
  "id" TEXT PRIMARY KEY,
  "signalId" TEXT REFERENCES "Signal"("id") ON DELETE SET NULL,
  "tradeId" TEXT REFERENCES "Trade"("id") ON DELETE SET NULL,
  "tokenId" TEXT REFERENCES "Token"("id") ON DELETE CASCADE,
  "walletId" TEXT REFERENCES "SmartWallet"("id") ON DELETE SET NULL,
  
  -- Decision data
  "decision" TEXT NOT NULL, -- 'buy' | 'sell' | 'hold' | 'skip'
  "confidence" DECIMAL(5, 2) NOT NULL, -- 0-100
  "reasoning" TEXT,
  
  -- Position management
  "suggestedPositionPercent" DECIMAL(5, 2),
  "stopLossPercent" DECIMAL(5, 2),
  "takeProfitPercent" DECIMAL(5, 2),
  "expectedHoldTimeMinutes" INT,
  "riskScore" INT, -- 1-10
  
  -- LLM metadata
  "model" TEXT NOT NULL,
  "promptTokens" INT,
  "completionTokens" INT,
  "latencyMs" INT,
  "prompt" TEXT,
  "response" TEXT,
  
  -- Execution tracking
  "executed" BOOLEAN DEFAULT false,
  "executedAt" TIMESTAMP WITH TIME ZONE,
  "resultPnlPercent" DECIMAL(36, 18),
  "resultPnlUsd" DECIMAL(36, 18),
  
  -- Timestamps
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexy pro AIDecision
CREATE INDEX IF NOT EXISTS "AIDecision_tokenId_idx" ON "AIDecision" ("tokenId");
CREATE INDEX IF NOT EXISTS "AIDecision_walletId_idx" ON "AIDecision" ("walletId");
CREATE INDEX IF NOT EXISTS "AIDecision_decision_idx" ON "AIDecision" ("decision");
CREATE INDEX IF NOT EXISTS "AIDecision_createdAt_idx" ON "AIDecision" ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "AIDecision_model_idx" ON "AIDecision" ("model");
CREATE INDEX IF NOT EXISTS "AIDecision_confidence_idx" ON "AIDecision" ("confidence" DESC);

-- ============================================
-- 3. Vytvoř AIPerformanceMetrics tabulku
-- ============================================

CREATE TABLE IF NOT EXISTS "AIPerformanceMetrics" (
  "id" TEXT PRIMARY KEY,
  "date" DATE NOT NULL,
  "model" TEXT NOT NULL,
  
  -- Decision metrics
  "totalDecisions" INT DEFAULT 0,
  "buyDecisions" INT DEFAULT 0,
  "sellDecisions" INT DEFAULT 0,
  "skipDecisions" INT DEFAULT 0,
  
  -- Execution metrics
  "executedDecisions" INT DEFAULT 0,
  "successfulTrades" INT DEFAULT 0,
  "failedTrades" INT DEFAULT 0,
  
  -- Performance metrics
  "totalPnlPercent" DECIMAL(36, 18) DEFAULT 0,
  "totalPnlUsd" DECIMAL(36, 18) DEFAULT 0,
  "avgPnlPercent" DECIMAL(36, 18) DEFAULT 0,
  "winRate" DECIMAL(5, 4) DEFAULT 0,
  
  -- Quality metrics
  "avgConfidence" DECIMAL(5, 2) DEFAULT 0,
  "avgLatencyMs" INT DEFAULT 0,
  "totalPromptTokens" INT DEFAULT 0,
  "totalCompletionTokens" INT DEFAULT 0,
  "estimatedCostUsd" DECIMAL(10, 4) DEFAULT 0,
  
  -- Timestamps
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE ("date", "model")
);

-- Indexy pro AIPerformanceMetrics
CREATE INDEX IF NOT EXISTS "AIPerformanceMetrics_date_idx" ON "AIPerformanceMetrics" ("date" DESC);
CREATE INDEX IF NOT EXISTS "AIPerformanceMetrics_model_idx" ON "AIPerformanceMetrics" ("model");

-- ============================================
-- 4. Vytvoř SignalPerformance tabulku (tracking signal outcomes)
-- ============================================

CREATE TABLE IF NOT EXISTS "SignalPerformance" (
  "id" TEXT PRIMARY KEY,
  "signalId" TEXT REFERENCES "Signal"("id") ON DELETE CASCADE,
  "signalType" TEXT NOT NULL,
  
  -- Entry data
  "entryPriceUsd" DECIMAL(36, 18),
  "entryTimestamp" TIMESTAMP WITH TIME ZONE,
  "positionSizeUsd" DECIMAL(36, 18),
  
  -- Exit data (filled when position closes)
  "exitPriceUsd" DECIMAL(36, 18),
  "exitTimestamp" TIMESTAMP WITH TIME ZONE,
  "holdTimeMinutes" INT,
  
  -- Performance
  "pnlPercent" DECIMAL(36, 18),
  "pnlUsd" DECIMAL(36, 18),
  "maxDrawdownPercent" DECIMAL(36, 18),
  "maxGainPercent" DECIMAL(36, 18),
  
  -- Classification
  "outcome" TEXT, -- 'win' | 'loss' | 'breakeven' | 'open'
  "hitStopLoss" BOOLEAN DEFAULT false,
  "hitTakeProfit" BOOLEAN DEFAULT false,
  
  -- Timestamps
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexy pro SignalPerformance
CREATE INDEX IF NOT EXISTS "SignalPerformance_signalId_idx" ON "SignalPerformance" ("signalId");
CREATE INDEX IF NOT EXISTS "SignalPerformance_signalType_idx" ON "SignalPerformance" ("signalType");
CREATE INDEX IF NOT EXISTS "SignalPerformance_outcome_idx" ON "SignalPerformance" ("outcome");
CREATE INDEX IF NOT EXISTS "SignalPerformance_createdAt_idx" ON "SignalPerformance" ("createdAt" DESC);

-- ============================================
-- 5. Funkce pro automatické aktualizace
-- ============================================

-- Funkce pro aktualizaci AI performance metrics
CREATE OR REPLACE FUNCTION update_ai_performance_metrics(target_date DATE, target_model TEXT)
RETURNS VOID AS $$
BEGIN
  INSERT INTO "AIPerformanceMetrics" (
    "id", "date", "model",
    "totalDecisions", "buyDecisions", "sellDecisions", "skipDecisions",
    "executedDecisions", "avgConfidence", "avgLatencyMs",
    "totalPromptTokens", "totalCompletionTokens"
  )
  SELECT 
    gen_random_uuid()::text,
    target_date,
    target_model,
    COUNT(*),
    COUNT(*) FILTER (WHERE "decision" = 'buy'),
    COUNT(*) FILTER (WHERE "decision" = 'sell'),
    COUNT(*) FILTER (WHERE "decision" = 'skip'),
    COUNT(*) FILTER (WHERE "executed" = true),
    AVG("confidence"),
    AVG("latencyMs"),
    SUM("promptTokens"),
    SUM("completionTokens")
  FROM "AIDecision"
  WHERE DATE("createdAt") = target_date
    AND "model" = target_model
  ON CONFLICT ("date", "model") DO UPDATE SET
    "totalDecisions" = EXCLUDED."totalDecisions",
    "buyDecisions" = EXCLUDED."buyDecisions",
    "sellDecisions" = EXCLUDED."sellDecisions",
    "skipDecisions" = EXCLUDED."skipDecisions",
    "executedDecisions" = EXCLUDED."executedDecisions",
    "avgConfidence" = EXCLUDED."avgConfidence",
    "avgLatencyMs" = EXCLUDED."avgLatencyMs",
    "totalPromptTokens" = EXCLUDED."totalPromptTokens",
    "totalCompletionTokens" = EXCLUDED."totalCompletionTokens",
    "updatedAt" = NOW();
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 6. View pro signal dashboard
-- ============================================

CREATE OR REPLACE VIEW "SignalDashboard" AS
SELECT 
  s."id",
  s."type",
  s."model" as "signalModel",
  s."status",
  s."qualityScore",
  s."riskLevel",
  s."reasoning",
  s."createdAt",
  s."meta",
  t."symbol" as "tokenSymbol",
  t."mintAddress" as "tokenMint",
  w."address" as "walletAddress",
  w."label" as "walletLabel",
  w."score" as "walletScore",
  ai."decision" as "aiDecision",
  ai."confidence" as "aiConfidence",
  ai."reasoning" as "aiReasoning",
  sp."pnlPercent" as "resultPnl",
  sp."outcome" as "tradeOutcome"
FROM "Signal" s
LEFT JOIN "Token" t ON s."tokenId" = t."id"
LEFT JOIN "SmartWallet" w ON s."walletId" = w."id"
LEFT JOIN "AIDecision" ai ON s."aiDecisionId" = ai."id"
LEFT JOIN "SignalPerformance" sp ON sp."signalId" = s."id"
ORDER BY s."createdAt" DESC;

-- ============================================
-- 7. View pro AI performance dashboard
-- ============================================

CREATE OR REPLACE VIEW "AIPerformanceDashboard" AS
SELECT 
  "model",
  SUM("totalDecisions") as "totalDecisions",
  SUM("buyDecisions") as "buyDecisions",
  SUM("sellDecisions") as "sellDecisions",
  SUM("executedDecisions") as "executedDecisions",
  AVG("avgConfidence") as "avgConfidence",
  AVG("avgLatencyMs") as "avgLatencyMs",
  SUM("totalPromptTokens") as "totalTokens",
  SUM("totalPnlPercent") as "totalPnl",
  AVG("winRate") as "avgWinRate"
FROM "AIPerformanceMetrics"
GROUP BY "model";

-- ============================================
-- HOTOVO!
-- ============================================

-- Poznámky:
-- 1. Spusť tento SQL v Supabase SQL Editoru
-- 2. Signal tabulka už musí existovat (z ADD_SIGNALS.sql)
-- 3. Tyto tabulky podporují:
--    - Rozšířené typy signálů (whale, sniper, momentum, etc.)
--    - AI rozhodnutí s LLM metadaty
--    - Performance tracking pro signály i AI
--    - Dashboard views pro frontend

