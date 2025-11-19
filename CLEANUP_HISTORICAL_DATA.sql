-- Cleanup: Odstranění všech historických dat
-- ⚠️  POZOR: Tento script smaže VŠECHNY trades a resetuje metriky!
-- Spusť pouze pokud chceš začít od nuly.

-- 1. Smaž všechny trades
DELETE FROM "Trade";

-- 2. Smaž všechny tokeny (volitelné - pokud chceš i ty)
-- DELETE FROM "Token";

-- 3. Smaž metriky historii
DELETE FROM "SmartWalletMetricsHistory";

-- 4. Resetuj metriky všech walletů na 0
UPDATE "SmartWallet" SET
  "score" = 0,
  "totalTrades" = 0,
  "winRate" = 0,
  "avgRr" = 0,
  "avgPnlPercent" = 0,
  "pnlTotalBase" = 0,
  "avgHoldingTimeMin" = 0,
  "maxDrawdownPercent" = 0,
  "recentPnl30dPercent" = 0,
  "updatedAt" = NOW();

-- 4b. Resetuj lastPumpfunTradeTimestamp pokud sloupec existuje (volitelné)
-- Pokud jsi ještě nespustil ADD_PUMPFUN_TIMESTAMP.sql, tento příkaz selže - to je OK
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'SmartWallet' 
    AND column_name = 'lastPumpfunTradeTimestamp'
  ) THEN
    UPDATE "SmartWallet" SET "lastPumpfunTradeTimestamp" = NULL;
  END IF;
END $$;

-- 5. Zkontroluj výsledek
SELECT 
  COUNT(*) as total_wallets,
  SUM("totalTrades") as total_trades,
  SUM("score") as sum_score,
  AVG("winRate") as avg_winrate
FROM "SmartWallet";

-- 6. Zkontroluj, jestli jsou všechny metriky skutečně 0
SELECT 
  "address",
  "label",
  "score",
  "totalTrades",
  "winRate",
  "recentPnl30dPercent"
FROM "SmartWallet"
WHERE "score" != 0 
   OR "totalTrades" != 0 
   OR "winRate" != 0
   OR "recentPnl30dPercent" != 0
LIMIT 20;

