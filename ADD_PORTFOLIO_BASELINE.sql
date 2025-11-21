-- Create a simple table to store the last baseline snapshot of a wallet's portfolio.
-- One row per walletId; upserted on each manual Refresh.

CREATE TABLE IF NOT EXISTS "PortfolioBaseline" (
  "walletId" TEXT PRIMARY KEY REFERENCES "SmartWallet"("id") ON DELETE CASCADE,
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "totalValueUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "holdings" JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS "PortfolioBaseline_updatedAt_idx" ON "PortfolioBaseline"("updatedAt");






