-- Paper Trading Tables
-- Fáze 1: Základní paper trading bez AI

-- Paper Trading Positions
CREATE TABLE IF NOT EXISTS "PaperTrade" (
  "id" TEXT PRIMARY KEY,
  "walletId" TEXT NOT NULL REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  "originalTradeId" TEXT REFERENCES "Trade"("id"), -- Reference na původní trade, který jsme kopírovali
  "side" TEXT NOT NULL CHECK ("side" IN ('buy', 'sell')),
  "amountToken" DECIMAL(36, 18) NOT NULL,
  "amountBase" DECIMAL(36, 18) NOT NULL,
  "priceBasePerToken" DECIMAL(36, 18) NOT NULL,
  "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "status" TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'closed', 'cancelled')),
  "realizedPnl" DECIMAL(36, 18), -- Po uzavření pozice
  "realizedPnlPercent" DECIMAL(10, 4), -- Po uzavření pozice
  "closedAt" TIMESTAMP WITH TIME ZONE, -- Kdy byla pozice uzavřena
  "meta" JSONB -- Doplňkové údaje (reasoning, confidence, etc.)
);

CREATE INDEX IF NOT EXISTS "PaperTrade_walletId_idx" ON "PaperTrade"("walletId");
CREATE INDEX IF NOT EXISTS "PaperTrade_tokenId_idx" ON "PaperTrade"("tokenId");
CREATE INDEX IF NOT EXISTS "PaperTrade_status_idx" ON "PaperTrade"("status");
CREATE INDEX IF NOT EXISTS "PaperTrade_timestamp_idx" ON "PaperTrade"("timestamp");
CREATE INDEX IF NOT EXISTS "PaperTrade_walletId_status_idx" ON "PaperTrade"("walletId", "status");

-- Paper Trading Portfolio Snapshot (periodické snapshoty pro tracking)
CREATE TABLE IF NOT EXISTS "PaperPortfolio" (
  "id" TEXT PRIMARY KEY,
  "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "totalValueUsd" DECIMAL(36, 18) NOT NULL DEFAULT 0,
  "totalCostUsd" DECIMAL(36, 18) NOT NULL DEFAULT 0,
  "totalPnlUsd" DECIMAL(36, 18) NOT NULL DEFAULT 0,
  "totalPnlPercent" DECIMAL(10, 4) NOT NULL DEFAULT 0,
  "openPositions" INT NOT NULL DEFAULT 0,
  "closedPositions" INT NOT NULL DEFAULT 0,
  "winRate" DECIMAL(5, 4), -- Procentuální win rate (0-1)
  "totalTrades" INT NOT NULL DEFAULT 0,
  "meta" JSONB -- Doplňkové metriky
);

CREATE INDEX IF NOT EXISTS "PaperPortfolio_timestamp_idx" ON "PaperPortfolio"("timestamp");

COMMENT ON TABLE "PaperTrade" IS 'Paper trading positions - simulované obchody pro testování strategií';
COMMENT ON TABLE "PaperPortfolio" IS 'Paper trading portfolio snapshots - periodické snapshoty pro tracking performance';
