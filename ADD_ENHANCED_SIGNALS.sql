-- ADD_ENHANCED_SIGNALS.sql
-- Rozšíření signálového systému pro trading bot

-- ============================================
-- 1. Uprav Signal tabulku - přidej nové sloupce
-- ============================================

-- Entry/Exit data
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "entryPriceUsd" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "suggestedExitPriceUsd" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "stopLossPriceUsd" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "takeProfitPriceUsd" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "suggestedHoldTimeMinutes" INT;

-- Token market data at signal time
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "tokenMarketCapUsd" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "tokenLiquidityUsd" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "tokenVolume24hUsd" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "tokenAgeMinutes" INT;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "tokenHolders" INT;

-- AI Decision data (inline for quick access)
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "aiDecision" TEXT; -- 'buy' | 'sell' | 'skip' | 'hold'
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "aiConfidence" DECIMAL(5, 2);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "aiReasoning" TEXT;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "aiSuggestedPositionPercent" DECIMAL(5, 2);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "aiStopLossPercent" DECIMAL(5, 2);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "aiTakeProfitPercent" DECIMAL(5, 2);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "aiRiskScore" INT;

-- Position management (for future trading bot)
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "positionStatus" TEXT DEFAULT 'pending'; -- 'pending' | 'entered' | 'exited' | 'stopped' | 'skipped'
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "actualEntryPriceUsd" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "actualExitPriceUsd" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "actualPnlPercent" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "actualPnlUsd" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "enteredAt" TIMESTAMP WITH TIME ZONE;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "exitedAt" TIMESTAMP WITH TIME ZONE;

-- Notification tracking
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "notificationSent" BOOLEAN DEFAULT false;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "notificationSentAt" TIMESTAMP WITH TIME ZONE;

-- Signal strength and priority for bot
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "priority" INT DEFAULT 0; -- Higher = more important
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "strength" TEXT; -- 'weak' | 'medium' | 'strong'

-- ============================================
-- 2. Indexy pro rychlé dotazy
-- ============================================

CREATE INDEX IF NOT EXISTS "Signal_positionStatus_idx" ON "Signal" ("positionStatus");
CREATE INDEX IF NOT EXISTS "Signal_aiDecision_idx" ON "Signal" ("aiDecision");
CREATE INDEX IF NOT EXISTS "Signal_aiConfidence_idx" ON "Signal" ("aiConfidence" DESC);
CREATE INDEX IF NOT EXISTS "Signal_priority_idx" ON "Signal" ("priority" DESC);
CREATE INDEX IF NOT EXISTS "Signal_notificationSent_idx" ON "Signal" ("notificationSent");

-- ============================================
-- 3. View pro aktivní signály s AI rozhodnutím
-- ============================================

CREATE OR REPLACE VIEW "ActiveTradingSignals" AS
SELECT 
  s."id",
  s."type",
  s."model" as "signalType",
  s."strength",
  s."status",
  s."priority",
  
  -- Token info
  t."symbol" as "tokenSymbol",
  t."mintAddress" as "tokenMint",
  s."tokenMarketCapUsd",
  s."tokenLiquidityUsd",
  s."tokenVolume24hUsd",
  s."tokenAgeMinutes",
  
  -- Entry/Exit
  s."entryPriceUsd",
  s."suggestedExitPriceUsd",
  s."stopLossPriceUsd",
  s."takeProfitPriceUsd",
  s."suggestedHoldTimeMinutes",
  
  -- AI Decision
  s."aiDecision",
  s."aiConfidence",
  s."aiReasoning",
  s."aiSuggestedPositionPercent",
  s."aiStopLossPercent",
  s."aiTakeProfitPercent",
  s."aiRiskScore",
  
  -- Wallet info
  w."address" as "walletAddress",
  w."label" as "walletLabel",
  w."score" as "walletScore",
  w."winRate" as "walletWinRate",
  
  -- Position status
  s."positionStatus",
  s."actualEntryPriceUsd",
  s."actualPnlPercent",
  
  -- Timestamps
  s."createdAt",
  s."expiresAt"
  
FROM "Signal" s
LEFT JOIN "Token" t ON s."tokenId" = t."id"
LEFT JOIN "SmartWallet" w ON s."walletId" = w."id"
WHERE s."status" = 'active'
  AND s."aiDecision" = 'buy'
  AND s."aiConfidence" >= 60
ORDER BY s."priority" DESC, s."aiConfidence" DESC, s."createdAt" DESC;

-- ============================================
-- 4. Funkce pro trading bot - získání nejlepších signálů
-- ============================================

CREATE OR REPLACE FUNCTION get_best_trading_signals(
  min_confidence INT DEFAULT 60,
  max_signals INT DEFAULT 10
)
RETURNS TABLE (
  signal_id TEXT,
  token_mint TEXT,
  token_symbol TEXT,
  entry_price DECIMAL,
  stop_loss_price DECIMAL,
  take_profit_price DECIMAL,
  position_percent DECIMAL,
  ai_confidence DECIMAL,
  ai_reasoning TEXT,
  wallet_score DECIMAL,
  priority INT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    s."id"::TEXT,
    t."mintAddress"::TEXT,
    t."symbol"::TEXT,
    s."entryPriceUsd",
    s."stopLossPriceUsd",
    s."takeProfitPriceUsd",
    s."aiSuggestedPositionPercent",
    s."aiConfidence",
    s."aiReasoning",
    w."score",
    s."priority"
  FROM "Signal" s
  LEFT JOIN "Token" t ON s."tokenId" = t."id"
  LEFT JOIN "SmartWallet" w ON s."walletId" = w."id"
  WHERE s."status" = 'active'
    AND s."positionStatus" = 'pending'
    AND s."aiDecision" = 'buy'
    AND s."aiConfidence" >= min_confidence
    AND s."expiresAt" > NOW()
  ORDER BY s."priority" DESC, s."aiConfidence" DESC
  LIMIT max_signals;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 5. Trigger pro automatické nastavení priority
-- ============================================

CREATE OR REPLACE FUNCTION calculate_signal_priority()
RETURNS TRIGGER AS $$
BEGIN
  -- Vypočti priority na základě confidence a typu signálu
  NEW."priority" := COALESCE(NEW."aiConfidence", NEW."qualityScore", 50)::INT;
  
  -- Bonus pro strong signály
  IF NEW."strength" = 'strong' THEN
    NEW."priority" := NEW."priority" + 20;
  ELSIF NEW."strength" = 'medium' THEN
    NEW."priority" := NEW."priority" + 10;
  END IF;
  
  -- Bonus pro whale-entry a hot-token
  IF NEW."model" IN ('whale-entry', 'hot-token') THEN
    NEW."priority" := NEW."priority" + 15;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS signal_priority_trigger ON "Signal";
CREATE TRIGGER signal_priority_trigger
  BEFORE INSERT OR UPDATE ON "Signal"
  FOR EACH ROW
  EXECUTE FUNCTION calculate_signal_priority();

-- ============================================
-- HOTOVO!
-- ============================================

-- Nyní Signal tabulka obsahuje:
-- 1. Entry/Exit ceny
-- 2. Token market data (market cap, liquidity, volume, age)
-- 3. AI rozhodnutí (decision, confidence, reasoning, position size, SL/TP)
-- 4. Position tracking (pro trading bot)
-- 5. Notification tracking
-- 6. Priority pro řazení signálů

