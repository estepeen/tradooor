-- PART 5: View for active positions
-- Spusť tuto část PÁTOU (poslední)

CREATE OR REPLACE VIEW "ActivePositionsView" AS
SELECT 
  vp."id",
  vp."status",
  vp."entryPriceUsd",
  vp."currentPriceUsd",
  vp."unrealizedPnlPercent",
  vp."unrealizedPnlUsd",
  vp."maxDrawdownPercent",
  vp."activeWalletCount",
  vp."exitedWalletCount",
  vp."entryTime",
  vp."lastAiDecision",
  vp."lastAiConfidence",
  vp."suggestedStopLoss",
  vp."suggestedTakeProfit",
  t."symbol" as "tokenSymbol",
  t."mintAddress" as "tokenMint",
  EXTRACT(EPOCH FROM (NOW() - vp."entryTime")) / 60 as "holdTimeMinutes"
FROM "VirtualPosition" vp
LEFT JOIN "Token" t ON vp."tokenId" = t."id"
WHERE vp."status" = 'open'
ORDER BY vp."unrealizedPnlPercent" DESC;

