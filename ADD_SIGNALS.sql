-- Signals table for buy/sell signals based on smart wallet trades
CREATE TABLE IF NOT EXISTS "Signal" (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL CHECK ("type" IN ('buy', 'sell')),
  "walletId" TEXT NOT NULL REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  "originalTradeId" TEXT REFERENCES "Trade"("id") ON DELETE SET NULL,
  "priceBasePerToken" NUMERIC NOT NULL,
  "amountBase" NUMERIC,
  "amountToken" NUMERIC,
  "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'executed', 'expired', 'cancelled')),
  "expiresAt" TIMESTAMP WITH TIME ZONE,
  "qualityScore" NUMERIC, -- 0-100
  "riskLevel" TEXT CHECK ("riskLevel" IN ('low', 'medium', 'high')),
  "model" TEXT CHECK ("model" IN ('smart-copy', 'consensus', 'ai')),
  "reasoning" TEXT, -- Proč byl signál vygenerován
  "meta" JSONB DEFAULT '{}',
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexy pro rychlé vyhledávání
CREATE INDEX IF NOT EXISTS "idx_signal_type" ON "Signal"("type");
CREATE INDEX IF NOT EXISTS "idx_signal_status" ON "Signal"("status");
CREATE INDEX IF NOT EXISTS "idx_signal_timestamp" ON "Signal"("timestamp" DESC);
CREATE INDEX IF NOT EXISTS "idx_signal_wallet_token" ON "Signal"("walletId", "tokenId");
CREATE INDEX IF NOT EXISTS "idx_signal_active" ON "Signal"("status", "type", "timestamp" DESC) WHERE "status" = 'active';

-- Komentáře
COMMENT ON TABLE "Signal" IS 'Trading signals generated from smart wallet activity';
COMMENT ON COLUMN "Signal"."type" IS 'Type of signal: buy or sell';
COMMENT ON COLUMN "Signal"."status" IS 'Signal status: active (pending), executed (used), expired, cancelled';
COMMENT ON COLUMN "Signal"."qualityScore" IS 'Quality score 0-100 based on wallet metrics';
COMMENT ON COLUMN "Signal"."riskLevel" IS 'Risk level: low, medium, high';
COMMENT ON COLUMN "Signal"."model" IS 'Model that generated the signal: smart-copy, consensus, ai';
COMMENT ON COLUMN "Signal"."reasoning" IS 'Human-readable explanation why this signal was generated';
