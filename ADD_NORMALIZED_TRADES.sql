-- Stores normalized swaps straight from QuickNode before valuation/ingestion
CREATE TABLE IF NOT EXISTS "NormalizedTrade" (
  "id" text PRIMARY KEY,
  "txSignature" text NOT NULL,
  "walletId" text NOT NULL REFERENCES "SmartWallet"(id) ON DELETE CASCADE,
  "tokenId" text NOT NULL REFERENCES "Token"(id) ON DELETE CASCADE,
  "tokenMint" text NOT NULL,
  "side" text NOT NULL,
  "amountToken" numeric(36, 18) NOT NULL,
  "amountBaseRaw" numeric(36, 18) NOT NULL,
  "baseToken" text NOT NULL,
  "priceBasePerTokenRaw" numeric(36, 18) NOT NULL,
  "timestamp" timestamptz NOT NULL,
  "dex" text NOT NULL,
  "positionChangePercent" double precision,
  "balanceBefore" double precision,
  "balanceAfter" double precision,
  "status" text NOT NULL DEFAULT 'pending',
  "error" text,
  "meta" jsonb,
  "rawPayload" jsonb,
  "amountBaseUsd" numeric(36, 18),
  "priceUsdPerToken" numeric(36, 18),
  "valuationSource" text,
  "valuationTimestamp" timestamptz,
  "processedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "tradeId" text REFERENCES "Trade"(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS normalized_trade_unique_signature_wallet_side
  ON "NormalizedTrade" ("txSignature", "walletId", "side");

CREATE INDEX IF NOT EXISTS normalized_trade_status_idx
  ON "NormalizedTrade" ("status", "timestamp");

CREATE INDEX IF NOT EXISTS normalized_trade_wallet_idx
  ON "NormalizedTrade" ("walletId", "status");


