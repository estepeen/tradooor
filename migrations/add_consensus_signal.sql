-- Migration: Add ConsensusSignal table
-- Created: 2025-12-14
-- Description: Table for storing consensus trading signals (when 2+ wallets buy same token within 2 hours)

CREATE TABLE IF NOT EXISTS "ConsensusSignal" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tokenId" TEXT NOT NULL REFERENCES "Token"("id") ON DELETE CASCADE,
  "walletCount" INTEGER NOT NULL,
  "firstTradeTime" TIMESTAMP WITH TIME ZONE NOT NULL,
  "latestTradeTime" TIMESTAMP WITH TIME ZONE NOT NULL,
  "trades" JSONB NOT NULL,
  "tokenSecurity" JSONB,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS "ConsensusSignal_tokenId_idx" ON "ConsensusSignal"("tokenId");
CREATE INDEX IF NOT EXISTS "ConsensusSignal_latestTradeTime_idx" ON "ConsensusSignal"("latestTradeTime");
CREATE INDEX IF NOT EXISTS "ConsensusSignal_createdAt_idx" ON "ConsensusSignal"("createdAt");
CREATE INDEX IF NOT EXISTS "ConsensusSignal_tokenId_firstTradeTime_idx" ON "ConsensusSignal"("tokenId", "firstTradeTime");

-- Add updatedAt trigger (auto-update on row change)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW."updatedAt" = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_consensus_signal_updated_at BEFORE UPDATE ON "ConsensusSignal"
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
