# Copytrading Data Collection - Kompletní Implementace

## Přehled

Implementováno kompletní řešení pro sběr dat potřebných pro budoucí copytrading bot. Všechna data se ukládají do ClosedLot tabulky a jsou dostupná přes API pro analýzu.

## Co bylo implementováno

### 1. Rozšíření ClosedLot Tabulky ✅

**SQL Migrace:** `./ADD_CLOSED_LOT_IMPROVEMENTS.sql`

**Nové sloupce:**
- **Entry/Exit Timing:** `entryHourOfDay`, `entryDayOfWeek`, `exitHourOfDay`, `exitDayOfWeek`
- **Market Conditions:** `entryMarketCap`, `exitMarketCap`, `entryLiquidity`, `exitLiquidity`, `entryVolume24h`, `exitVolume24h`, `tokenAgeAtEntryMinutes`
- **Stop-Loss/Take-Profit:** `exitReason`, `maxProfitPercent`, `maxDrawdownPercent`, `timeToMaxProfitMinutes`
- **DCA Tracking:** `dcaEntryCount`, `dcaTimeSpanMinutes`
- **Re-entry Patterns:** `reentryTimeMinutes`, `reentryPriceChangePercent`, `previousCyclePnl`

### 2. Nové Služby ✅

#### TokenMarketDataService
- **Soubor:** `./apps/backend/src/services/token-market-data.service.ts`
- **Funkce:** Získává market data (market cap, liquidity, volume) z Birdeye API
- **Použití:** Background job pro doplnění market data do existujících ClosedLot

#### PriceHistoryService
- **Soubor:** `./apps/backend/src/services/price-history.service.ts`
- **Funkce:** 
  - Sledování price history během držení pozice
  - Výpočet přesného maxProfitPercent a maxDrawdownPercent
  - Vylepšená detekce stop-loss/take-profit
- **Použití:** Background job pro doplnění price history metrik

#### CopytradingAnalyticsService
- **Soubor:** `./apps/backend/src/services/copytrading-analytics.service.ts`
- **Funkce:** 
  - Analýza ClosedLot dat pro copytrading insights
  - Výpočet timing statistik (nejlepší hodina/den)
  - Analýza market conditions (preferované token age, liquidity)
  - Pattern analysis (DCA, re-entry, scalping, swing trading)
  - Exit reason statistics
- **API Endpoint:** `GET /api/smart-wallets/:id/copytrading-analytics`

### 3. Background Jobs ✅

#### enrich-closed-lots-market-data.ts
- **Funkce:** Doplnění market data do existujících ClosedLot
- **Použití:** 
  ```bash
  pnpm --filter backend enrich:closed-lots-market-data
  ```
- **Cron:** `CRON_SCHEDULE="0 2 * * *"` (každý den v 2:00)

#### enrich-closed-lots-price-history.ts
- **Funkce:** Doplnění price history metrik (maxProfitPercent, maxDrawdownPercent, exitReason)
- **Použití:**
  ```bash
  pnpm --filter backend enrich:closed-lots-price-history
  ```
- **Cron:** `CRON_SCHEDULE="0 3 * * *"` (každý den v 3:00)

### 4. Rozšíření LotMatchingService ✅

- **Automatické vyplňování:**
  - Timing metriky (hour of day, day of week) - ✅ automaticky
  - DCA tracking (počet BUY trades, časový rozsah) - ✅ automaticky
  - Re-entry patterns (čas od předchozího exit, změna ceny) - ✅ automaticky
  - Stop-loss/take-profit detekce (zjednodušená) - ✅ automaticky
- **Market data:** Připraveno, ale vypnuto (lze zapnout v background jobu)
- **Price history:** Připraveno, ale vypnuto (lze zapnout v background jobu)

## Jak použít

### 1. Spustit SQL migraci

```sql
-- V Supabase SQL Editor
\i ADD_CLOSED_LOT_IMPROVEMENTS.sql
```

### 2. Přepočítat Closed Lots

```bash
# Přepočítat closed lots pro všechny wallets (vyplní základní metriky)
pnpm --filter backend recalculate-all-positions-and-metrics
```

### 3. (Volitelné) Doplnit Market Data

```bash
# Doplnit market data do existujících ClosedLot
pnpm --filter backend enrich:closed-lots-market-data
```

### 4. (Volitelné) Doplnit Price History Metriky

```bash
# Doplnit price history metriky (maxProfitPercent, maxDrawdownPercent, exitReason)
pnpm --filter backend enrich:closed-lots-price-history
```

### 5. Získat Analytics pro Wallet

```bash
# API endpoint
GET /api/smart-wallets/:id/copytrading-analytics
```

## Co se ukládá automaticky

Při vytváření ClosedLot se automaticky ukládá:

### ✅ Timing Metriky
- `entryHourOfDay`: Hodina dne při entry (0-23)
- `entryDayOfWeek`: Den v týdnu při entry (0=Sunday, 6=Saturday)
- `exitHourOfDay`: Hodina dne při exit (0-23)
- `exitDayOfWeek`: Den v týdnu při exit (0=Sunday, 6=Saturday)

### ✅ DCA Tracking
- `dcaEntryCount`: Počet BUY trades (null pokud je pouze 1)
- `dcaTimeSpanMinutes`: Časový rozsah od prvního BUY do posledního BUY

### ✅ Re-entry Patterns
- `reentryTimeMinutes`: Čas od předchozího exit (null pro první cyklus)
- `reentryPriceChangePercent`: Změna ceny % od předchozího exit
- `previousCyclePnl`: PnL předchozího cyklu

### ✅ Stop-Loss/Take-Profit (Zjednodušená verze)
- `exitReason`: `take_profit` (profit > 10%), `stop_loss` (loss > 10%), `manual`, `unknown`
- `maxProfitPercent`: Použije realizedPnlPercent (zjednodušené)
- `maxDrawdownPercent`: Použije abs(realizedPnlPercent) (zjednodušené)

## Co se doplní v background jobu

### Market Data (volitelné)
- `entryMarketCap`, `exitMarketCap`
- `entryLiquidity`, `exitLiquidity`
- `entryVolume24h`, `exitVolume24h`
- `tokenAgeAtEntryMinutes`

### Price History Metriky (volitelné)
- `maxProfitPercent`: Přesný z price history
- `maxDrawdownPercent`: Přesný z price history
- `timeToMaxProfitMinutes`: Přesný čas k dosažení max profitu
- `exitReason`: Vylepšená detekce založená na price history

## API Endpoint pro Analytics

### GET /api/smart-wallets/:id/copytrading-analytics

Vrací kompletní analytics pro copytrading bot:

```json
{
  "walletId": "...",
  "walletAddress": "...",
  "analytics": {
    "entryTiming": [
      {
        "hourOfDay": 14,
        "dayOfWeek": -1,
        "totalTrades": 25,
        "winRate": 0.68,
        "avgPnlPercent": 12.5,
        "avgHoldTimeMinutes": 45
      }
    ],
    "marketConditions": [
      {
        "tokenAgeRange": "< 1 hour",
        "liquidityRange": "unknown",
        "marketCapRange": "unknown",
        "totalTrades": 15,
        "winRate": 0.73,
        "avgPnlPercent": 18.2
      }
    ],
    "patterns": [
      {
        "patternType": "dca",
        "totalTrades": 30,
        "winRate": 0.70,
        "avgPnlPercent": 15.3,
        "avgHoldTimeMinutes": 120
      }
    ],
    "exitReasons": [
      {
        "exitReason": "take_profit",
        "totalTrades": 40,
        "winRate": 0.85,
        "avgPnlPercent": 20.1,
        "avgHoldTimeMinutes": 30
      }
    ],
    "bestEntryHour": 14,
    "bestEntryDay": 2,
    "preferredTokenAge": "< 1 hour",
    "preferredLiquidity": "50k-200k",
    "dcaSuccessRate": 0.70,
    "reentrySuccessRate": 0.65,
    "scalpSuccessRate": 0.72,
    "swingSuccessRate": 0.58
  }
}
```

## Příklady použití pro Copytrading Bot

### 1. Jednoduché podmínky (pouze základní metriky)

```typescript
const analytics = await fetchCopytradingAnalytics(walletId);

const conditions = {
  minScore: 70,
  minWinRate: 0.55,
  minRecentPnl30dPercent: 10,
  
  // Použít nejlepší timing
  preferredEntryHour: analytics.bestEntryHour,
  preferredEntryDay: analytics.bestEntryDay,
};
```

### 2. Pokročilé podmínky (s pattern matching)

```typescript
const analytics = await fetchCopytradingAnalytics(walletId);

const conditions = {
  minScore: 70,
  minWinRate: 0.55,
  
  // Použít pouze úspěšné patterny
  copyOnlyDca: analytics.dcaSuccessRate && analytics.dcaSuccessRate > 0.60,
  copyOnlyScalping: analytics.scalpSuccessRate && analytics.scalpSuccessRate > 0.65,
  
  // Použít preferované market conditions
  preferredTokenAge: analytics.preferredTokenAge,
  preferredLiquidity: analytics.preferredLiquidity,
  
  // Použít nejlepší timing
  preferredEntryHour: analytics.bestEntryHour,
  preferredEntryDay: analytics.bestEntryDay,
};
```

### 3. Dynamické podmínky (podle exit reasons)

```typescript
const analytics = await fetchCopytradingAnalytics(walletId);

// Najít nejúspěšnější exit reason
const bestExitReason = analytics.exitReasons
  .sort((a, b) => b.winRate - a.winRate)[0];

const conditions = {
  minScore: 70,
  minWinRate: 0.55,
  
  // Kopírovat pouze trades s nejúspěšnějším exit reason
  copyOnlyExitReason: bestExitReason.exitReason,
  minExitReasonWinRate: bestExitReason.winRate,
};
```

## SQL Dotazy pro Analýzu

### Nejlepší hodina dne pro entry

```sql
SELECT 
  "entryHourOfDay",
  COUNT(*) as total_trades,
  SUM(CASE WHEN "realizedPnl" > 0 THEN 1 ELSE 0 END)::float / COUNT(*) as win_rate,
  AVG("realizedPnlPercent") as avg_pnl_percent
FROM "ClosedLot"
WHERE "entryHourOfDay" IS NOT NULL
  AND "walletId" = 'WALLET_ID'
GROUP BY "entryHourOfDay"
ORDER BY win_rate DESC;
```

### DCA vs. Single Entry

```sql
SELECT 
  CASE WHEN "dcaEntryCount" > 1 THEN 'DCA' ELSE 'Single Entry' END as strategy,
  COUNT(*) as total_trades,
  AVG("realizedPnlPercent") as avg_pnl_percent,
  SUM(CASE WHEN "realizedPnl" > 0 THEN 1 ELSE 0 END)::float / COUNT(*) as win_rate
FROM "ClosedLot"
WHERE "walletId" = 'WALLET_ID'
GROUP BY strategy;
```

### Re-entry Patterns

```sql
SELECT 
  CASE 
    WHEN "reentryTimeMinutes" < 60 THEN '< 1 hour'
    WHEN "reentryTimeMinutes" < 1440 THEN '1-24 hours'
    WHEN "reentryTimeMinutes" < 10080 THEN '1-7 days'
    ELSE '> 7 days'
  END as reentry_timeframe,
  COUNT(*) as total_trades,
  AVG("realizedPnlPercent") as avg_pnl_percent,
  SUM(CASE WHEN "realizedPnl" > 0 THEN 1 ELSE 0 END)::float / COUNT(*) as win_rate
FROM "ClosedLot"
WHERE "reentryTimeMinutes" IS NOT NULL
  AND "walletId" = 'WALLET_ID'
GROUP BY reentry_timeframe
ORDER BY win_rate DESC;
```

### Exit Reasons Analysis

```sql
SELECT 
  "exitReason",
  COUNT(*) as total_trades,
  AVG("realizedPnlPercent") as avg_pnl_percent,
  SUM(CASE WHEN "realizedPnl" > 0 THEN 1 ELSE 0 END)::float / COUNT(*) as win_rate,
  AVG("holdTimeMinutes") as avg_hold_time_minutes
FROM "ClosedLot"
WHERE "exitReason" IS NOT NULL
  AND "walletId" = 'WALLET_ID'
GROUP BY "exitReason"
ORDER BY win_rate DESC;
```

## Cron Jobs Setup

Pro automatické doplňování dat:

```bash
# Market data enrichment (každý den v 2:00)
CRON_SCHEDULE="0 2 * * *" pnpm --filter backend enrich:closed-lots-market-data

# Price history enrichment (každý den v 3:00)
CRON_SCHEDULE="0 3 * * *" pnpm --filter backend enrich:closed-lots-price-history
```

## Poznámky

1. **Market Data Fetching:** Prozatím vypnuto v lot-matching service kvůli výkonu. Použij background job pro doplnění.
2. **Price History:** Pro přesnější stop-loss/take-profit detekci použij background job `enrich:closed-lots-price-history`.
3. **Rate Limits:** Background jobs respektují rate limits Birdeye API (delay mezi requesty).
4. **Performance:** Background jobs zpracovávají data v batchích, aby nezatížily systém.

## Další kroky

1. ✅ **Základní metriky** - implementováno
2. ✅ **Background jobs** - implementováno
3. ✅ **Analytics service** - implementováno
4. ⚠️ **Market data fetching** - připraveno, ale vypnuto (lze zapnout)
5. ⚠️ **Price history** - připraveno, ale vypnuto (lze zapnout v background jobu)
6. 🔄 **Frontend dashboard** - pro zobrazení analytics (budoucí)
7. 🔄 **Copytrading bot** - implementace samotného bota (budoucí)
