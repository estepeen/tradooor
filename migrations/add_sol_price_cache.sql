-- Add table for caching SOL price (updated every 10 minutes)
CREATE TABLE IF NOT EXISTS "SolPriceCache" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "priceUsd" DOUBLE PRECISION NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL DEFAULT 'binance'
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS "SolPriceCache_updatedAt_idx" ON "SolPriceCache"("updatedAt");

-- Insert initial record (will be updated by cron)
INSERT INTO "SolPriceCache" ("id", "priceUsd", "updatedAt", "source")
VALUES ('current', 150.0, NOW(), 'binance')
ON CONFLICT ("id") DO NOTHING;

