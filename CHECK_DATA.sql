-- Zkontroluj, jestli jsou data skutečně smazaná

-- 1. Počet trades
SELECT COUNT(*) as total_trades FROM "Trade";

-- 2. Počet tokenů
SELECT COUNT(*) as total_tokens FROM "Token";

-- 3. Metriky walletů (měly by být všechny 0)
SELECT 
  COUNT(*) as total_wallets,
  SUM("totalTrades") as sum_trades,
  SUM("score") as sum_score,
  AVG("winRate") as avg_winrate
FROM "SmartWallet";

-- 4. Ukázka několika walletů s jejich metrikami
SELECT 
  "address",
  "label",
  "score",
  "totalTrades",
  "winRate",
  "recentPnl30dPercent"
FROM "SmartWallet"
ORDER BY "score" DESC
LIMIT 10;

