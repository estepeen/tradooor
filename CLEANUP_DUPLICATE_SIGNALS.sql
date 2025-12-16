-- CLEANUP_DUPLICATE_SIGNALS.sql
-- Smaže duplicitní signály a ponechá pouze jeden per token

-- 1. Zobraz duplicitní tokeny v Signal tabulce
SELECT 
  "tokenId",
  COUNT(*) as signal_count,
  MIN("createdAt") as first_created,
  MAX("createdAt") as last_created
FROM "Signal"
WHERE model = 'consensus'
GROUP BY "tokenId"
HAVING COUNT(*) > 1
ORDER BY signal_count DESC;

-- 2. Smaž duplicity - ponech pouze nejnovější signal pro každý token
DELETE FROM "Signal"
WHERE id NOT IN (
  SELECT DISTINCT ON ("tokenId") id
  FROM "Signal"
  WHERE model = 'consensus'
  ORDER BY "tokenId", "createdAt" DESC
)
AND model = 'consensus';

-- 3. Verifikuj že duplicity jsou pryč
SELECT 
  "tokenId",
  COUNT(*) as signal_count
FROM "Signal"
WHERE model = 'consensus'
GROUP BY "tokenId"
HAVING COUNT(*) > 1;

-- 4. Zobraz počty signálů po cleanup
SELECT model, COUNT(*) as count
FROM "Signal"
GROUP BY model
ORDER BY count DESC;

