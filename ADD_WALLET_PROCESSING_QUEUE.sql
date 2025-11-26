-- Queue table for wallet processing jobs (metrics recomputation, closed lots, etc.)
CREATE TABLE IF NOT EXISTS "WalletProcessingQueue" (
  "id" text PRIMARY KEY,
  "walletId" text NOT NULL REFERENCES "SmartWallet"(id) ON DELETE CASCADE,
  "jobType" text NOT NULL DEFAULT 'metrics',
  "status" text NOT NULL DEFAULT 'pending',
  "priority" integer NOT NULL DEFAULT 0,
  "attempts" integer NOT NULL DEFAULT 0,
  "lastAttemptAt" timestamptz,
  "nextRunAt" timestamptz NOT NULL DEFAULT now(),
  "error" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_processing_queue_unique_wallet_job
  ON "WalletProcessingQueue" ("walletId", "jobType");

CREATE INDEX IF NOT EXISTS wallet_processing_queue_status_idx
  ON "WalletProcessingQueue" ("status", "nextRunAt");

CREATE INDEX IF NOT EXISTS wallet_processing_queue_priority_idx
  ON "WalletProcessingQueue" ("priority", "createdAt");

-- Extend SmartWallet with cached fields for queued processing
ALTER TABLE "SmartWallet"
  ADD COLUMN IF NOT EXISTS "recentPnl30dUsd" double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "advancedStats" jsonb;



