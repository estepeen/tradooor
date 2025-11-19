-- Ensure each transaction signature is stored only once in "Trade".
-- If duplicates exist, keep the earliest trade (by timestamp, then id) and remove the rest,
-- then create a UNIQUE index to prevent future duplicates.

-- 1) Remove duplicates (safe and idempotent)
WITH ranked AS (
  SELECT
    id,
    "txSignature",
    ROW_NUMBER() OVER (
      PARTITION BY "txSignature"
      ORDER BY "timestamp" ASC, id ASC
    ) AS rn
  FROM "Trade"
)
DELETE FROM "Trade" t
USING ranked r
WHERE t.id = r.id
  AND r.rn > 1;

-- 2) Create unique index (if not exists)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'Trade_txSignature_unique_idx'
  ) THEN
    CREATE UNIQUE INDEX "Trade_txSignature_unique_idx" ON "Trade"("txSignature");
  END IF;
END $$;


