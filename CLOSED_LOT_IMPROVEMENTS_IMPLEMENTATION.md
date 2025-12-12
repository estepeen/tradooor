# Implementace vylepšení ClosedLot pro Copytrading Data Collection

## Přehled

Implementováno vylepšení ClosedLot tabulky pro sběr dat potřebných pro budoucí copytrading bot. Všechna data se nyní ukládají při vytváření ClosedLot záznamů.

## Co bylo implementováno

### 1. SQL Migrace ✅
- **Soubor:** `./ADD_CLOSED_LOT_IMPROVEMENTS.sql`
- **Nové sloupce:**
  - Entry/Exit Timing: `entryHourOfDay`, `entryDayOfWeek`, `exitHourOfDay`, `exitDayOfWeek`
  - Market Conditions: `entryMarketCap`, `exitMarketCap`, `entryLiquidity`, `exitLiquidity`, `entryVolume24h`, `exitVolume24h`, `tokenAgeAtEntryMinutes`
  - Stop-Loss/Take-Profit: `exitReason`, `maxProfitPercent`, `maxDrawdownPercent`, `timeToMaxProfitMinutes`
  - DCA Tracking: `dcaEntryCount`, `dcaTimeSpanMinutes`
  - Re-entry Patterns: `reentryTimeMinutes`, `reentryPriceChangePercent`, `previousCyclePnl`

### 2. Nová služba pro Market Data ✅
- **Soubor:** `./apps/backend/src/services/token-market-data.service.ts`
- **Funkce:** Získává market data (market cap, liquidity, volume) z Birdeye API
- **Poznámka:** Prozatím vypnuto v lot-matching service (může být pomalé), lze zapnout později v background jobu

### 3. Rozšíření LotMatchingService ✅
- **Soubor:** `./apps/backend/src/services/lot-matching.service.ts`
- **Změny:**
  - Rozšířen `ClosedLot` interface o nová pole
  - Přidány helper funkce pro timing metriky (`getHourOfDay`, `getDayOfWeek`)
  - Upraveno vytváření ClosedLot, aby vyplňovalo nová pole:
    - Timing metriky (hour of day, day of week)
    - DCA tracking (počet BUY trades, časový rozsah)
    - Re-entry patterns (čas od předchozího exit, změna ceny)
    - Stop-loss/take-profit detekce (zjednodušená verze)
  - Market data fetching je připraveno, ale prozatím vypnuto (může být pomalé)

### 4. Aktualizace ClosedLotRepository ✅
- **Soubor:** `./apps/backend/src/repositories/closed-lot.repository.ts`
- **Změny:**
  - Rozšířen `ClosedLotRecord` interface o nová pole
  - Aktualizována `mapRow` metoda pro načítání nových polí z databáze

### 5. Aktualizace saveClosedLots ✅
- **Soubor:** `./apps/backend/src/services/lot-matching.service.ts`
- **Změny:**
  - Aktualizována metoda `saveClosedLots`, aby ukládala nová pole do databáze

## Jak použít

### 1. Spustit SQL migraci

```sql
-- V Supabase SQL Editor nebo přes psql
\i ADD_CLOSED_LOT_IMPROVEMENTS.sql
```

Nebo zkopírovat obsah `./ADD_CLOSED_LOT_IMPROVEMENTS.sql` a spustit v Supabase SQL Editor.

### 2. Přepočítat Closed Lots

Po spuštění migrace je potřeba přepočítat všechny Closed Lots, aby se vyplnila nová pole:

```bash
# Přepočítat closed lots pro všechny wallets
pnpm --filter backend recalculate-all-positions-and-metrics
```

### 3. (Volitelné) Zapnout Market Data Fetching

Market data fetching je prozatím vypnuto, protože může být pomalé. Pokud chcete zapnout:

1. Otevřít `./apps/backend/src/services/lot-matching.service.ts`
2. Najít komentovaný kód kolem řádku 404-413
3. Odkomentovat kód pro market data fetching

**Poznámka:** Market data fetching může výrazně zpomalit vytváření ClosedLot. Doporučujeme:
- Buď zapnout pouze pro nové ClosedLot (ne přepočítávat všechny)
- Nebo vytvořit background job, který doplní market data pro existující ClosedLot

## Co se ukládá

### Timing Metriky
- `entryHourOfDay`: Hodina dne při entry (0-23)
- `entryDayOfWeek`: Den v týdnu při entry (0=Sunday, 6=Saturday)
- `exitHourOfDay`: Hodina dne při exit (0-23)
- `exitDayOfWeek`: Den v týdnu při exit (0=Sunday, 6=Saturday)

### Market Conditions (prozatím null, připraveno pro budoucí použití)
- `entryMarketCap`: Market cap při entry (USD)
- `exitMarketCap`: Market cap při exit (USD)
- `entryLiquidity`: Liquidity při entry (USD)
- `exitLiquidity`: Liquidity při exit (USD)
- `entryVolume24h`: 24h volume při entry (USD)
- `exitVolume24h`: 24h volume při exit (USD)
- `tokenAgeAtEntryMinutes`: Stáří tokenu při entry (minuty)

### Stop-Loss/Take-Profit Detekce
- `exitReason`: Důvod exit (`take_profit`, `stop_loss`, `manual`, `unknown`)
  - `take_profit`: Pokud profit > 10%
  - `stop_loss`: Pokud loss > 10%
  - `manual`: Jinak
- `maxProfitPercent`: Maximální profit % během držení (zjednodušené - použije realizedPnlPercent)
- `maxDrawdownPercent`: Maximální drawdown % během držení (zjednodušené - použije abs(realizedPnlPercent))
- `timeToMaxProfitMinutes`: Čas k dosažení max profitu (prozatím null, potřebuje price history)

### DCA Tracking
- `dcaEntryCount`: Počet BUY trades, které tvoří tento closed lot
  - `null` pokud je pouze 1 BUY trade
  - `> 1` pokud je více BUY trades (DCA)
- `dcaTimeSpanMinutes`: Časový rozsah od prvního BUY do posledního BUY před SELL
  - `null` pokud je pouze 1 BUY trade

### Re-entry Patterns
- `reentryTimeMinutes`: Čas od předchozího exit do tohoto entry (minuty)
  - `null` pro první cyklus
- `reentryPriceChangePercent`: Změna ceny % od předchozího exit
  - `null` pro první cyklus
- `previousCyclePnl`: PnL předchozího cyklu (pro srovnání)
  - `null` pro první cyklus

## Příklady použití

### Analýza timing metrik

```sql
-- Nejlepší hodina dne pro entry (podle win rate)
SELECT 
  "entryHourOfDay",
  COUNT(*) as total_trades,
  SUM(CASE WHEN "realizedPnl" > 0 THEN 1 ELSE 0 END)::float / COUNT(*) as win_rate,
  AVG("realizedPnlPercent") as avg_pnl_percent
FROM "ClosedLot"
WHERE "entryHourOfDay" IS NOT NULL
GROUP BY "entryHourOfDay"
ORDER BY win_rate DESC;
```

### Analýza DCA strategií

```sql
-- Porovnání DCA vs. single entry
SELECT 
  CASE WHEN "dcaEntryCount" > 1 THEN 'DCA' ELSE 'Single Entry' END as strategy,
  COUNT(*) as total_trades,
  AVG("realizedPnlPercent") as avg_pnl_percent,
  SUM(CASE WHEN "realizedPnl" > 0 THEN 1 ELSE 0 END)::float / COUNT(*) as win_rate
FROM "ClosedLot"
WHERE "dcaEntryCount" IS NOT NULL
GROUP BY strategy;
```

### Analýza re-entry patterns

```sql
-- Úspěšnost re-entry podle času od předchozího exit
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
GROUP BY reentry_timeframe
ORDER BY reentry_timeframe;
```

## Další kroky

1. **Market Data Fetching**: Vytvořit background job pro doplnění market data pro existující ClosedLot
2. **Price History**: Implementovat sledování price history pro přesnější stop-loss/take-profit detekci
3. **Analytics**: Vytvořit API endpointy pro analýzu těchto dat
4. **Dashboard**: Přidat grafy a metriky do frontendu

## Poznámky

- Market data fetching je prozatím vypnuto kvůli výkonu
- Stop-loss/take-profit detekce je zjednodušená (používá pouze entry/exit price)
- Pro přesnější detekci by bylo potřeba sledovat price history během držení pozice
- Všechna nová pole jsou nullable, takže existující ClosedLot zůstanou funkční
