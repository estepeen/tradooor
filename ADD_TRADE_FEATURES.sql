-- Trade feature logging table for AI/analytics
CREATE TABLE IF NOT EXISTS "TradeFeature" (
  "id" text PRIMARY KEY,
  "tradeId" text NOT NULL UNIQUE REFERENCES "Trade"(id) ON DELETE CASCADE,
  "walletId" text NOT NULL REFERENCES "SmartWallet"(id) ON DELETE CASCADE,
  "tokenId" text NOT NULL REFERENCES "Token"(id) ON DELETE CASCADE,

  "sizeToken" numeric,
  "sizeUsd" numeric,
  "priceUsd" numeric,
  "slippageBps" integer,
  "dex" text,
  "txTimestamp" timestamptz,

  "positionSizeBeforeToken" numeric,
  "positionSizeBeforeUsd" numeric,
  "positionSizeAfterToken" numeric,
  "positionSizeAfterUsd" numeric,
  "positionSizeChangeMultiplier" numeric,
  "avgEntryPriceBeforeUsd" numeric,
  "avgEntryPriceAfterUsd" numeric,

  "realizedPnlUsd" numeric,
  "realizedPnlPercent" numeric,
  "holdTimeSeconds" integer,

  "tokenAgeSeconds" integer,
  "liquidityUsd" numeric,
  "volume1hUsd" numeric,
  "volume24hUsd" numeric,
  "fdvUsd" numeric,
  "trend5mPercent" numeric,
  "trend30mPercent" numeric,
  "solPriceUsd" numeric,

  "hourOfDay" smallint,
  "dayOfWeek" smallint,
  "baseTokenSymbol" text,

  "meta" jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trade_feature_wallet_idx ON "TradeFeature" ("walletId");
CREATE INDEX IF NOT EXISTS trade_feature_token_idx ON "TradeFeature" ("tokenId");
CREATE INDEX IF NOT EXISTS trade_feature_timestamp_idx ON "TradeFeature" ("txTimestamp");

