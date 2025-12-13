# Setup Signals System

## Kdo tvoří signály?

Signály se automaticky generují v **`paper-trading-monitor` workeru**, který:
- Běží každých 30 sekund
- Kontroluje nové BUY a SELL trades
- Vyhodnocuje kvalitu trades pomocí Smart Copy modelu
- Generuje signály pro trades s quality score >= 40

## Co je potřeba udělat:

### 1. Spustit databázovou migraci

**DŮLEŽITÉ:** Musíš spustit SQL migraci v Supabase:

```sql
-- Spusť ADD_SIGNALS.sql v Supabase Dashboard → SQL Editor
```

Nebo přes psql:
```bash
psql $DATABASE_URL -f ADD_SIGNALS.sql
```

### 2. Zkontrolovat, jestli worker běží

```bash
pm2 status
# Měl by tam být: tradooor-paper-trading-monitor
```

### 3. Pokud worker neběží, spusť ho

```bash
cd /opt/tradooor
pm2 start ecosystem.config.js --only tradooor-paper-trading-monitor
```

### 4. Zkontrolovat logy workeru

```bash
pm2 logs tradooor-paper-trading-monitor --lines 50
```

Měly by tam být zprávy jako:
- `📊 Found X new BUY trades`
- `📊 Generated X SELL signals`

### 5. Zkontrolovat, jestli API funguje

```bash
curl http://localhost:3001/api/signals
```

Mělo by vrátit JSON s `signals` array.

### 6. Zkontrolovat, jestli jsou signály v databázi

```sql
SELECT COUNT(*) FROM "Signal" WHERE status = 'active';
```

## Troubleshooting

### Chyba: "Failed to fetch signals"

**Možné příčiny:**
1. Databázová tabulka `Signal` neexistuje → Spusť `ADD_SIGNALS.sql`
2. Worker neběží → Spusť `pm2 start ecosystem.config.js --only tradooor-paper-trading-monitor`
3. Backend neběží → Zkontroluj `pm2 status`
4. API endpoint má chybu → Zkontroluj backend logy

### Zkontroluj backend logy

```bash
pm2 logs tradooor-backend --lines 50 | grep -i signal
```

### Zkontroluj, jestli jsou nějaké signály

```bash
# Přes API
curl http://localhost:3001/api/signals | jq

# Nebo přímo v databázi
psql $DATABASE_URL -c "SELECT id, type, status, timestamp FROM \"Signal\" ORDER BY timestamp DESC LIMIT 10;"
```

## Jak to funguje:

1. **Worker běží** (`paper-trading-monitor.ts`)
   - Každých 30 sekund kontroluje nové trades
   - Pro každý nový BUY trade:
     - Vyhodnotí kvalitu (Smart Copy model)
     - Pokud score >= 40, vytvoří BUY signál
   - Pro každý nový SELL trade:
     - Vytvoří SELL signál
     - Uzavře odpovídající paper trade

2. **Signály se ukládají** do databázové tabulky `Signal`

3. **Frontend načítá signály** přes API endpoint `/api/signals`

4. **Signály expirují** po 24 hodinách automaticky

## Rychlý test:

```bash
# 1. Zkontroluj, jestli worker běží
pm2 status | grep paper-trading

# 2. Zkontroluj logy
pm2 logs tradooor-paper-trading-monitor --lines 20

# 3. Zkontroluj API
curl http://localhost:3001/api/signals

# 4. Pokud API vrací chybu, zkontroluj backend logy
pm2 logs tradooor-backend --lines 30 | tail
```
