-- Migration: Add AI/ML data collection tables
-- Run this in Supabase SQL Editor

-- 1. TradeSequence table - sequence patterns for AI/ML
CREATE TABLE IF NOT EXISTS "TradeSequence" (
  "id" TEXT PRIMARY KEY,
  "tradeId" TEXT UNIQUE NOT NULL REFERENCES "Trade"("id") ON DELETE CASCADE,
  "walletId" TEXT NOT NULL REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  
  -- Sequence context
  "sequenceIndex" INTEGER,
  "sequenceLength" INTEGER,
  "timeSinceLastTradeSeconds" INTEGER,
  "timeSinceLastTokenTradeSeconds" INTEGER,
  
  -- Token switching patterns
  "isTokenSwitch" BOOLEAN DEFAULT false,
  "previousTokenId" TEXT,
  "tokensInSequence" INTEGER,
  
  -- Position sizing patterns
  "positionSizeChangePercent" DECIMAL(36, 18),
  "avgPositionSizeUsd" DECIMAL(36, 18),
  
  -- Trading frequency
  "tradesInLastHour" INTEGER,
  "tradesInLastDay" INTEGER,
  
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "TradeSequence_walletId_idx" ON "TradeSequence"("walletId");
CREATE INDEX IF NOT EXISTS "TradeSequence_tokenId_idx" ON "TradeSequence"("tokenId");
CREATE INDEX IF NOT EXISTS "TradeSequence_tradeId_idx" ON "TradeSequence"("tradeId");

-- 2. TradeOutcome table - outcome labels for AI/ML
CREATE TABLE IF NOT EXISTS "TradeOutcome" (
  "id" TEXT PRIMARY KEY,
  "tradeId" TEXT UNIQUE NOT NULL REFERENCES "Trade"("id") ON DELETE CASCADE,
  "walletId" TEXT NOT NULL REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  
  -- Trade outcome (pro BUY trades)
  "outcomeType" TEXT, -- 'win' | 'loss' | 'breakeven' | 'unknown'
  "outcomeCategory" TEXT, -- 'big_win' | 'small_win' | 'small_loss' | 'big_loss' | 'breakeven'
  "realizedPnlUsd" DECIMAL(36, 18),
  "realizedPnlPercent" DECIMAL(36, 18),
  
  -- Token outcome (jak dopadl token po trade)
  "tokenPriceChange1hPercent" DECIMAL(36, 18),
  "tokenPriceChange24hPercent" DECIMAL(36, 18),
  "tokenPriceChange7dPercent" DECIMAL(36, 18),
  "tokenOutcome" TEXT, -- 'pump' | 'dump' | 'sideways' | 'unknown'
  
  -- Position outcome (celkový výsledek pozice)
  "positionClosedAt" TIMESTAMP WITH TIME ZONE,
  "positionHoldTimeSeconds" INTEGER,
  "positionFinalPnlUsd" DECIMAL(36, 18),
  "positionFinalPnlPercent" DECIMAL(36, 18),
  
  -- Labels calculated at
  "calculatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "TradeOutcome_walletId_idx" ON "TradeOutcome"("walletId");
CREATE INDEX IF NOT EXISTS "TradeOutcome_tokenId_idx" ON "TradeOutcome"("tokenId");
CREATE INDEX IF NOT EXISTS "TradeOutcome_tradeId_idx" ON "TradeOutcome"("tradeId");
CREATE INDEX IF NOT EXISTS "TradeOutcome_outcomeType_idx" ON "TradeOutcome"("outcomeType");
CREATE INDEX IF NOT EXISTS "TradeOutcome_outcomeCategory_idx" ON "TradeOutcome"("outcomeCategory");

-- 3. Extend TradeFeature table with market context features
ALTER TABLE "TradeFeature" 
ADD COLUMN IF NOT EXISTS "priceMomentum1mPercent" DECIMAL(36, 18),
ADD COLUMN IF NOT EXISTS "priceMomentum5mPercent" DECIMAL(36, 18),
ADD COLUMN IF NOT EXISTS "priceMomentum15mPercent" DECIMAL(36, 18),
ADD COLUMN IF NOT EXISTS "priceMomentum1hPercent" DECIMAL(36, 18),
ADD COLUMN IF NOT EXISTS "volumeSpike1hMultiplier" DECIMAL(36, 18),
ADD COLUMN IF NOT EXISTS "volumeSpike24hMultiplier" DECIMAL(36, 18),
ADD COLUMN IF NOT EXISTS "marketRegime" TEXT, -- 'bull' | 'bear' | 'sideways'
ADD COLUMN IF NOT EXISTS "otherSmartWalletsTradingCount" INTEGER;

-- Add comments for documentation
COMMENT ON TABLE "TradeSequence" IS 'Sequence patterns for AI/ML training - order of trades, time between trades, token switching patterns';
COMMENT ON TABLE "TradeOutcome" IS 'Outcome labels for AI/ML training - win/loss categorization, token outcomes, position outcomes';
COMMENT ON COLUMN "TradeFeature"."priceMomentum1mPercent" IS 'Price change 1 minute before trade';
COMMENT ON COLUMN "TradeFeature"."priceMomentum5mPercent" IS 'Price change 5 minutes before trade';
COMMENT ON COLUMN "TradeFeature"."priceMomentum15mPercent" IS 'Price change 15 minutes before trade';
COMMENT ON COLUMN "TradeFeature"."priceMomentum1hPercent" IS 'Price change 1 hour before trade';
COMMENT ON COLUMN "TradeFeature"."volumeSpike1hMultiplier" IS 'Volume spike multiplier vs average (1h)';
COMMENT ON COLUMN "TradeFeature"."volumeSpike24hMultiplier" IS 'Volume spike multiplier vs average (24h)';
COMMENT ON COLUMN "TradeFeature"."marketRegime" IS 'Market regime: bull, bear, or sideways';
COMMENT ON COLUMN "TradeFeature"."otherSmartWalletsTradingCount" IS 'Number of other smart wallets trading same token';

