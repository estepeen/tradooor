-- Migration: Add trader correlation and automatic tagging
-- Run this in Supabase SQL Editor

-- 1. TraderCorrelation table - correlation mezi tradery (kdo tradeuje stejné tokeny)
CREATE TABLE IF NOT EXISTS "TraderCorrelation" (
  "id" TEXT PRIMARY KEY,
  "walletId1" TEXT NOT NULL REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  "walletId2" TEXT NOT NULL REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  
  -- Correlation metrics
  "tradesTogetherCount" INTEGER DEFAULT 0, -- Kolikrát tradeovali stejný token
  "firstTradeTogetherAt" TIMESTAMP WITH TIME ZONE, -- Kdy poprvé tradeovali stejný token
  "lastTradeTogetherAt" TIMESTAMP WITH TIME ZONE, -- Kdy naposledy tradeovali stejný token
  
  -- Timing correlation
  "avgTimeBetweenTradesSeconds" INTEGER, -- Průměrný čas mezi jejich tradey
  "sameDirectionCount" INTEGER DEFAULT 0, -- Kolikrát tradeovali stejným směrem (obě BUY nebo obě SELL)
  "oppositeDirectionCount" INTEGER DEFAULT 0, -- Kolikrát tradeovali opačným směrem (jeden BUY, druhý SELL)
  
  -- Success correlation
  "bothWinCount" INTEGER DEFAULT 0, -- Kolikrát oba vyhráli
  "bothLossCount" INTEGER DEFAULT 0, -- Kolikrát oba prohráli
  "oneWinOneLossCount" INTEGER DEFAULT 0, -- Kolikrát jeden vyhrál, druhý prohrál
  
  -- Correlation score (0-1, kde 1 = perfektní korelace)
  "correlationScore" DECIMAL(5, 4) DEFAULT 0,
  
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Unique constraint: jeden záznam pro každou dvojici walletů a token
  CONSTRAINT "TraderCorrelation_wallet1_wallet2_token_unique" UNIQUE ("walletId1", "walletId2", "tokenId")
);

CREATE INDEX IF NOT EXISTS "TraderCorrelation_walletId1_idx" ON "TraderCorrelation"("walletId1");
CREATE INDEX IF NOT EXISTS "TraderCorrelation_walletId2_idx" ON "TraderCorrelation"("walletId2");
CREATE INDEX IF NOT EXISTS "TraderCorrelation_tokenId_idx" ON "TraderCorrelation"("tokenId");
CREATE INDEX IF NOT EXISTS "TraderCorrelation_correlationScore_idx" ON "TraderCorrelation"("correlationScore");

-- 2. TraderBehaviorProfile table - automatické charakteristiky tradera
CREATE TABLE IF NOT EXISTS "TraderBehaviorProfile" (
  "id" TEXT PRIMARY KEY,
  "walletId" TEXT UNIQUE NOT NULL REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  
  -- Trading style characteristics
  "isSniper" BOOLEAN DEFAULT false, -- Tradeuje velmi brzy po launch tokenu
  "isDegen" BOOLEAN DEFAULT false, -- Tradeuje high-risk tokeny
  "isScalper" BOOLEAN DEFAULT false, -- Krátké holding times
  "isSwingTrader" BOOLEAN DEFAULT false, -- Dlouhé holding times
  "isCopyTrader" BOOLEAN DEFAULT false, -- Často tradeuje stejné tokeny jako jiní
  "isEarlyAdopter" BOOLEAN DEFAULT false, -- Tradeuje nové tokeny brzy
  "isMomentumTrader" BOOLEAN DEFAULT false, -- Tradeuje při momentum
  "isContrarian" BOOLEAN DEFAULT false, -- Tradeuje proti trendu
  
  -- Risk characteristics
  "riskTolerance" TEXT, -- 'low' | 'medium' | 'high' | 'extreme'
  "positionSizingStyle" TEXT, -- 'conservative' | 'moderate' | 'aggressive'
  "diversificationLevel" TEXT, -- 'low' | 'medium' | 'high'
  
  -- Timing characteristics
  "preferredTradingHours" INTEGER[], -- Preferované hodiny pro trading (0-23)
  "tradingFrequency" TEXT, -- 'low' | 'medium' | 'high' | 'very_high'
  
  -- Token preferences
  "prefersLowLiquidity" BOOLEAN DEFAULT false,
  "prefersNewTokens" BOOLEAN DEFAULT false,
  "prefersHighVolume" BOOLEAN DEFAULT false,
  
  -- Performance characteristics
  "avgWinSize" DECIMAL(36, 18), -- Průměrná velikost výhry
  "avgLossSize" DECIMAL(36, 18), -- Průměrná velikost prohry
  "riskRewardRatio" DECIMAL(36, 18), -- Risk/reward poměr
  
  -- Auto-generated tags (JSON array for flexibility)
  "autoTags" TEXT[] DEFAULT '{}',
  
  "calculatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "TraderBehaviorProfile_walletId_idx" ON "TraderBehaviorProfile"("walletId");
CREATE INDEX IF NOT EXISTS "TraderBehaviorProfile_isSniper_idx" ON "TraderBehaviorProfile"("isSniper");
CREATE INDEX IF NOT EXISTS "TraderBehaviorProfile_isDegen_idx" ON "TraderBehaviorProfile"("isDegen");
CREATE INDEX IF NOT EXISTS "TraderBehaviorProfile_riskTolerance_idx" ON "TraderBehaviorProfile"("riskTolerance");

-- 3. Extend TradeFeature with better correlation data
ALTER TABLE "TradeFeature" 
ADD COLUMN IF NOT EXISTS "otherSmartWalletsTradingSameTokenCount" INTEGER,
ADD COLUMN IF NOT EXISTS "otherSmartWalletsTradingSameTokenWithin1h" INTEGER,
ADD COLUMN IF NOT EXISTS "otherSmartWalletsTradingSameTokenWithin24h" INTEGER,
ADD COLUMN IF NOT EXISTS "avgTimeSinceOtherTradersTradeSeconds" INTEGER,
ADD COLUMN IF NOT EXISTS "copyTraderScore" DECIMAL(5, 4); -- 0-1, jak moc je to copy trading

-- Add comments
COMMENT ON TABLE "TraderCorrelation" IS 'Correlation between traders - who trades same tokens, timing, success rate';
COMMENT ON TABLE "TraderBehaviorProfile" IS 'Automatic trader characteristics and behavior patterns';
COMMENT ON COLUMN "TradeFeature"."otherSmartWalletsTradingSameTokenCount" IS 'Total count of other smart wallets trading same token';
COMMENT ON COLUMN "TradeFeature"."otherSmartWalletsTradingSameTokenWithin1h" IS 'Count within 1 hour';
COMMENT ON COLUMN "TradeFeature"."otherSmartWalletsTradingSameTokenWithin24h" IS 'Count within 24 hours';
COMMENT ON COLUMN "TradeFeature"."avgTimeSinceOtherTradersTradeSeconds" IS 'Average time since other traders traded same token';
COMMENT ON COLUMN "TradeFeature"."copyTraderScore" IS 'Copy trading score (0-1) - how much this looks like copy trading';

