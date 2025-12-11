-- Migration: Add twitterUrl column to SmartWallet table
-- Run this SQL directly in Supabase SQL Editor or via psql

ALTER TABLE "SmartWallet" 
ADD COLUMN IF NOT EXISTS "twitterUrl" TEXT;

-- Add comment
COMMENT ON COLUMN "SmartWallet"."twitterUrl" IS 'Twitter/X profil URL (např. "https://x.com/username")';

