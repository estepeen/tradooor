-- ADD_LEVEL_1_2_FEATURES.sql
-- Level 1 + Level 2 features pro trading bot

-- ============================================
-- LEVEL 1.1: SUCCESS RATE TRACKING
-- ============================================

-- Rozšíření Signal tabulky pro tracking výsledků
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "outcomeStatus" TEXT; -- 'pending' | 'win' | 'loss' | 'breakeven' | 'expired'
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "outcomeCheckedAt" TIMESTAMP WITH TIME ZONE;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "outcomePriceAtCheck" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "outcomePnlPercent" DECIMAL(10, 4);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "outcomeHitSL" BOOLEAN DEFAULT false;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "outcomeHitTP" BOOLEAN DEFAULT false;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "outcomeMaxPriceUsd" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "outcomeMinPriceUsd" DECIMAL(36, 18);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "outcomeMaxPnlPercent" DECIMAL(10, 4);
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "outcomeMinPnlPercent" DECIMAL(10, 4);

-- Tabulka pro historické ceny tokenů (pro tracking)
CREATE TABLE IF NOT EXISTS "TokenPriceHistory" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  "mintAddress" TEXT NOT NULL,
  "priceUsd" DECIMAL(36, 18) NOT NULL,
  "marketCapUsd" DECIMAL(36, 18),
  "liquidityUsd" DECIMAL(36, 18),
  "volume24hUsd" DECIMAL(36, 18),
  "timestamp" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "source" TEXT DEFAULT 'birdeye' -- 'birdeye' | 'jupiter' | 'dexscreener'
);

CREATE INDEX IF NOT EXISTS "TokenPriceHistory_tokenId_timestamp_idx" ON "TokenPriceHistory" ("tokenId", "timestamp" DESC);
CREATE INDEX IF NOT EXISTS "TokenPriceHistory_mintAddress_timestamp_idx" ON "TokenPriceHistory" ("mintAddress", "timestamp" DESC);

-- Agregovaná statistika signálů
CREATE TABLE IF NOT EXISTS "SignalStats" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "period" TEXT NOT NULL, -- 'daily' | 'weekly' | 'monthly' | 'all_time'
  "periodStart" DATE NOT NULL,
  "signalType" TEXT, -- NULL = all types
  "totalSignals" INT DEFAULT 0,
  "winCount" INT DEFAULT 0,
  "lossCount" INT DEFAULT 0,
  "breakevenCount" INT DEFAULT 0,
  "expiredCount" INT DEFAULT 0,
  "winRate" DECIMAL(5, 2),
  "avgPnlPercent" DECIMAL(10, 4),
  "avgWinPnlPercent" DECIMAL(10, 4),
  "avgLossPnlPercent" DECIMAL(10, 4),
  "bestPnlPercent" DECIMAL(10, 4),
  "worstPnlPercent" DECIMAL(10, 4),
  "avgHoldTimeMinutes" INT,
  "aiAccuracy" DECIMAL(5, 2), -- % of AI "buy" that were wins
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE("period", "periodStart", "signalType")
);

-- ============================================
-- LEVEL 1.2: REAL-TIME PRICE MONITORING
-- ============================================

-- Aktivní price alerts
CREATE TABLE IF NOT EXISTS "PriceAlert" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "signalId" TEXT REFERENCES "Signal"("id") ON DELETE CASCADE,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  "mintAddress" TEXT NOT NULL,
  "alertType" TEXT NOT NULL, -- 'stop_loss' | 'take_profit' | 'price_above' | 'price_below'
  "triggerPrice" DECIMAL(36, 18) NOT NULL,
  "currentPrice" DECIMAL(36, 18),
  "entryPrice" DECIMAL(36, 18),
  "status" TEXT DEFAULT 'active', -- 'active' | 'triggered' | 'cancelled' | 'expired'
  "triggeredAt" TIMESTAMP WITH TIME ZONE,
  "notificationSent" BOOLEAN DEFAULT false,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "expiresAt" TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS "PriceAlert_status_idx" ON "PriceAlert" ("status");
CREATE INDEX IF NOT EXISTS "PriceAlert_mintAddress_status_idx" ON "PriceAlert" ("mintAddress", "status");

-- ============================================
-- LEVEL 1.3: ENHANCED NOTIFICATIONS
-- ============================================

-- Notification log
CREATE TABLE IF NOT EXISTS "NotificationLog" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "type" TEXT NOT NULL, -- 'signal' | 'price_alert' | 'outcome' | 'daily_summary'
  "channel" TEXT NOT NULL, -- 'discord' | 'telegram' | 'webhook'
  "signalId" TEXT REFERENCES "Signal"("id") ON DELETE SET NULL,
  "alertId" TEXT REFERENCES "PriceAlert"("id") ON DELETE SET NULL,
  "title" TEXT,
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "status" TEXT DEFAULT 'pending', -- 'pending' | 'sent' | 'failed'
  "errorMessage" TEXT,
  "sentAt" TIMESTAMP WITH TIME ZONE,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "NotificationLog_status_idx" ON "NotificationLog" ("status");
CREATE INDEX IF NOT EXISTS "NotificationLog_type_createdAt_idx" ON "NotificationLog" ("type", "createdAt" DESC);

-- ============================================
-- LEVEL 2.1: HISTORICAL BACKTESTING
-- ============================================

-- Backtest runs
CREATE TABLE IF NOT EXISTS "BacktestRun" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "startDate" TIMESTAMP WITH TIME ZONE NOT NULL,
  "endDate" TIMESTAMP WITH TIME ZONE NOT NULL,
  "config" JSONB NOT NULL, -- signal types, thresholds, position sizing, etc.
  "status" TEXT DEFAULT 'pending', -- 'pending' | 'running' | 'completed' | 'failed'
  "totalSignals" INT,
  "totalTrades" INT,
  "winCount" INT,
  "lossCount" INT,
  "winRate" DECIMAL(5, 2),
  "totalPnlPercent" DECIMAL(10, 4),
  "maxDrawdownPercent" DECIMAL(10, 4),
  "sharpeRatio" DECIMAL(10, 4),
  "results" JSONB,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "completedAt" TIMESTAMP WITH TIME ZONE
);

-- Backtest individual trades
CREATE TABLE IF NOT EXISTS "BacktestTrade" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "backtestId" TEXT NOT NULL REFERENCES "BacktestRun"("id") ON DELETE CASCADE,
  "signalId" TEXT,
  "tokenId" TEXT NOT NULL,
  "tokenSymbol" TEXT,
  "entryPrice" DECIMAL(36, 18) NOT NULL,
  "exitPrice" DECIMAL(36, 18),
  "entryTime" TIMESTAMP WITH TIME ZONE NOT NULL,
  "exitTime" TIMESTAMP WITH TIME ZONE,
  "positionSizePercent" DECIMAL(5, 2),
  "pnlPercent" DECIMAL(10, 4),
  "exitReason" TEXT, -- 'take_profit' | 'stop_loss' | 'time_exit' | 'signal'
  "metadata" JSONB
);

CREATE INDEX IF NOT EXISTS "BacktestTrade_backtestId_idx" ON "BacktestTrade" ("backtestId");

-- ============================================
-- LEVEL 2.2: WALLET CORRELATION ANALYSIS
-- ============================================

-- Wallet correlations (updated periodically)
CREATE TABLE IF NOT EXISTS "WalletCorrelation" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "walletId1" TEXT NOT NULL REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  "walletId2" TEXT NOT NULL REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  "correlationScore" DECIMAL(5, 4), -- -1 to 1
  "sharedTokensCount" INT DEFAULT 0,
  "sameDirectionPercent" DECIMAL(5, 2), -- % of time they trade in same direction
  "avgTimeDifferenceMinutes" DECIMAL(10, 2), -- avg time between their trades on same token
  "suspectedGroup" TEXT, -- Group identifier if detected
  "lastCalculatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE("walletId1", "walletId2")
);

CREATE INDEX IF NOT EXISTS "WalletCorrelation_walletId1_idx" ON "WalletCorrelation" ("walletId1");
CREATE INDEX IF NOT EXISTS "WalletCorrelation_walletId2_idx" ON "WalletCorrelation" ("walletId2");
CREATE INDEX IF NOT EXISTS "WalletCorrelation_correlationScore_idx" ON "WalletCorrelation" ("correlationScore" DESC);

-- Wallet groups (clusters of correlated wallets)
CREATE TABLE IF NOT EXISTS "WalletGroup" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "name" TEXT,
  "groupType" TEXT, -- 'smart_money' | 'shill_network' | 'unknown'
  "walletIds" TEXT[] NOT NULL,
  "avgCorrelation" DECIMAL(5, 4),
  "avgWalletScore" DECIMAL(5, 2),
  "avgWinRate" DECIMAL(5, 2),
  "totalTrades" INT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Rozšíření SmartWallet pro correlation data
ALTER TABLE "SmartWallet" ADD COLUMN IF NOT EXISTS "correlationGroupId" TEXT;
ALTER TABLE "SmartWallet" ADD COLUMN IF NOT EXISTS "isSuspectedShill" BOOLEAN DEFAULT false;
ALTER TABLE "SmartWallet" ADD COLUMN IF NOT EXISTS "trustScore" DECIMAL(5, 2); -- adjusted score based on correlations

-- ============================================
-- LEVEL 2.3: TOKEN RISK SCORING
-- ============================================

-- Token risk analysis
CREATE TABLE IF NOT EXISTS "TokenRiskAnalysis" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  "mintAddress" TEXT NOT NULL,
  
  -- Risk scores (0-100, higher = more risky)
  "overallRiskScore" INT NOT NULL,
  "liquidityRiskScore" INT,
  "holderRiskScore" INT,
  "contractRiskScore" INT,
  "volumeRiskScore" INT,
  "ageRiskScore" INT,
  
  -- Contract analysis
  "isRenounced" BOOLEAN,
  "isMintable" BOOLEAN,
  "isFreezable" BOOLEAN,
  "hasHoneypotRisk" BOOLEAN,
  "lpLocked" BOOLEAN,
  "lpLockDays" INT,
  
  -- Holder analysis
  "topHolderPercent" DECIMAL(5, 2), -- Top holder ownership %
  "top10HolderPercent" DECIMAL(5, 2),
  "uniqueHolders" INT,
  "holderGrowthRate" DECIMAL(10, 4), -- % growth in last 24h
  
  -- Trading patterns
  "buyToSellRatio" DECIMAL(5, 2),
  "avgTradeSize" DECIMAL(36, 18),
  "suspiciousTradingPattern" BOOLEAN,
  
  -- Social signals
  "hasTwitter" BOOLEAN,
  "hasTelegram" BOOLEAN,
  "hasWebsite" BOOLEAN,
  
  -- Timestamps
  "analyzedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "expiresAt" TIMESTAMP WITH TIME ZONE, -- Cache expiry
  
  UNIQUE("tokenId")
);

CREATE INDEX IF NOT EXISTS "TokenRiskAnalysis_mintAddress_idx" ON "TokenRiskAnalysis" ("mintAddress");
CREATE INDEX IF NOT EXISTS "TokenRiskAnalysis_overallRiskScore_idx" ON "TokenRiskAnalysis" ("overallRiskScore");

-- Rozšíření Signal o risk data
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "tokenRiskScore" INT;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "tokenRiskDetails" JSONB;

-- ============================================
-- VIEWS PRO DASHBOARD
-- ============================================

-- Signal performance view
CREATE OR REPLACE VIEW "SignalPerformanceView" AS
SELECT 
  DATE_TRUNC('day', s."createdAt") as date,
  s.model as signal_type,
  COUNT(*) as total_signals,
  COUNT(CASE WHEN s."outcomeStatus" = 'win' THEN 1 END) as wins,
  COUNT(CASE WHEN s."outcomeStatus" = 'loss' THEN 1 END) as losses,
  COUNT(CASE WHEN s."aiDecision" = 'buy' THEN 1 END) as ai_buy_count,
  COUNT(CASE WHEN s."aiDecision" = 'buy' AND s."outcomeStatus" = 'win' THEN 1 END) as ai_buy_wins,
  AVG(s."outcomePnlPercent") as avg_pnl,
  AVG(s."aiConfidence") as avg_ai_confidence,
  AVG(s."tokenRiskScore") as avg_risk_score
FROM "Signal" s
WHERE s."createdAt" > NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', s."createdAt"), s.model
ORDER BY date DESC, signal_type;

-- Active alerts view
CREATE OR REPLACE VIEW "ActiveAlertsView" AS
SELECT 
  pa.*,
  t.symbol as token_symbol,
  s."aiDecision",
  s."aiConfidence",
  s."entryPriceUsd" as signal_entry_price
FROM "PriceAlert" pa
JOIN "Token" t ON pa."tokenId" = t.id
LEFT JOIN "Signal" s ON pa."signalId" = s.id
WHERE pa.status = 'active'
ORDER BY pa."createdAt" DESC;

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to calculate signal outcome
CREATE OR REPLACE FUNCTION calculate_signal_outcome(
  signal_id_param TEXT,
  current_price_param DECIMAL,
  check_time_param TIMESTAMP WITH TIME ZONE DEFAULT NOW()
)
RETURNS TABLE (
  outcome_status TEXT,
  pnl_percent DECIMAL,
  hit_sl BOOLEAN,
  hit_tp BOOLEAN
) AS $$
DECLARE
  entry_price DECIMAL;
  sl_price DECIMAL;
  tp_price DECIMAL;
  pnl DECIMAL;
BEGIN
  -- Get signal data
  SELECT "entryPriceUsd", "stopLossPriceUsd", "takeProfitPriceUsd"
  INTO entry_price, sl_price, tp_price
  FROM "Signal"
  WHERE id = signal_id_param;

  IF entry_price IS NULL OR entry_price = 0 THEN
    RETURN QUERY SELECT 'pending'::TEXT, 0::DECIMAL, false, false;
    RETURN;
  END IF;

  -- Calculate PnL
  pnl := ((current_price_param - entry_price) / entry_price) * 100;

  -- Determine outcome
  IF sl_price IS NOT NULL AND current_price_param <= sl_price THEN
    RETURN QUERY SELECT 'loss'::TEXT, pnl, true, false;
  ELSIF tp_price IS NOT NULL AND current_price_param >= tp_price THEN
    RETURN QUERY SELECT 'win'::TEXT, pnl, false, true;
  ELSIF pnl >= 10 THEN
    RETURN QUERY SELECT 'win'::TEXT, pnl, false, false;
  ELSIF pnl <= -20 THEN
    RETURN QUERY SELECT 'loss'::TEXT, pnl, false, false;
  ELSE
    RETURN QUERY SELECT 'pending'::TEXT, pnl, false, false;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- DONE
-- ============================================
-- Nyní můžeš:
-- 1. Trackovat success rate signálů
-- 2. Monitorovat ceny v reálném čase
-- 3. Logovat notifikace
-- 4. Spouštět backtesty
-- 5. Analyzovat korelace walletů
-- 6. Detekovat rizikové tokeny

