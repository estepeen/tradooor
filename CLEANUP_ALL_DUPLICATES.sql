-- CLEANUP_ALL_DUPLICATES.sql
-- Komplexní čištění duplicit z obou signálových tabulek

-- ============================================
-- 1. Zobraz duplicity v ConsensusSignal
-- ============================================
SELECT 
  "tokenId",
  COUNT(*) as count,
  MIN("latestTradeTime") as oldest,
  MAX("latestTradeTime") as newest
FROM "ConsensusSignal"
GROUP BY "tokenId"
HAVING COUNT(*) > 1
ORDER BY count DESC;

-- ============================================
-- 2. Smaž duplicity z ConsensusSignal - ponech nejnovější
-- ============================================
DELETE FROM "ConsensusSignal"
WHERE id NOT IN (
  SELECT DISTINCT ON ("tokenId") id
  FROM "ConsensusSignal"
  ORDER BY "tokenId", "latestTradeTime" DESC
);

-- ============================================
-- 3. Zobraz duplicity v Signal tabulce
-- ============================================
SELECT 
  "tokenId",
  model,
  COUNT(*) as count
FROM "Signal"
WHERE model = 'consensus'
GROUP BY "tokenId", model
HAVING COUNT(*) > 1
ORDER BY count DESC;

-- ============================================
-- 4. Smaž duplicity z Signal - ponech nejnovější
-- ============================================
DELETE FROM "Signal"
WHERE id NOT IN (
  SELECT DISTINCT ON ("tokenId") id
  FROM "Signal"
  WHERE model = 'consensus'
  ORDER BY "tokenId", "createdAt" DESC
)
AND model = 'consensus';

-- ============================================
-- 5. Verifikuj výsledek
-- ============================================
SELECT 'ConsensusSignal' as table_name, COUNT(*) as count FROM "ConsensusSignal"
UNION ALL
SELECT 'Signal (consensus)' as table_name, COUNT(*) as count FROM "Signal" WHERE model = 'consensus'
UNION ALL
SELECT 'Signal (all)' as table_name, COUNT(*) as count FROM "Signal";

-- ============================================
-- 6. Zobraz signály bez AI evaluace
-- ============================================
SELECT 
  s.id,
  t.symbol,
  s."qualityScore",
  s."aiDecision",
  s."aiConfidence",
  s."createdAt"
FROM "Signal" s
LEFT JOIN "Token" t ON s."tokenId" = t.id
WHERE s.model = 'consensus'
  AND s."aiDecision" IS NULL
ORDER BY s."createdAt" DESC;

