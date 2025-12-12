# Copytrading Data Collection - Setup Guide

## Rychlý Start

### 1. Spustit SQL migraci

```sql
-- V Supabase SQL Editor
\i ADD_CLOSED_LOT_IMPROVEMENTS.sql
```

### 2. Přepočítat Closed Lots (vyplní základní metriky)

```bash
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

### 5. Získat Analytics

```bash
# API endpoint
curl http://localhost:3001/api/smart-wallets/WALLET_ID/copytrading-analytics
```

## Co se ukládá automaticky

Při vytváření ClosedLot se automaticky ukládá:

✅ **Timing Metriky** - hodina dne a den v týdnu při entry/exit
✅ **DCA Tracking** - počet BUY trades a časový rozsah
✅ **Re-entry Patterns** - čas od předchozího exit, změna ceny
✅ **Stop-Loss/Take-Profit** - zjednodušená detekce (profit > 10% = take-profit, loss > 10% = stop-loss)

## Co se doplní v background jobu

⚠️ **Market Data** - market cap, liquidity, volume (volitelné, může být pomalé)
⚠️ **Price History Metriky** - přesný maxProfitPercent, maxDrawdownPercent, exitReason (volitelné, může být pomalé)

## Cron Jobs

Pro automatické doplňování dat nastav cron jobs:

```bash
# Market data enrichment (každý den v 2:00)
CRON_SCHEDULE="0 2 * * *" pnpm --filter backend enrich:closed-lots-market-data

# Price history enrichment (každý den v 3:00)
CRON_SCHEDULE="0 3 * * *" pnpm --filter backend enrich:closed-lots-price-history
```

## API Endpoints

### GET /api/smart-wallets/:id/copytrading-analytics

Vrací kompletní analytics pro copytrading bot včetně:
- Entry timing statistics (nejlepší hodina/den)
- Market condition preferences (preferované token age, liquidity)
- Pattern success rates (DCA, re-entry, scalping, swing)
- Exit reason statistics

## Příklady použití

Viz `./COPYYTRADING_DATA_COLLECTION.md` pro kompletní příklady a SQL dotazy.
