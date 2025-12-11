# Přepočet všech Closed Positions a Metrik

## Účel
Tento skript přepočítá všechny closed positions (closed lots) a metriky pro všechny walletky, aby:
- Closed positions byly správně vypočítány z databáze
- PnL na homepage (recentPnl30d) ladilo s closed positions
- Všechny metriky byly synchronizované

## Co skript dělá

1. **Projde všechny walletky** v databázi
2. **Pro každou walletku:**
   - Přepočítá closed lots (z trades pomocí FIFO matching)
   - Přepočítá open positions
   - Uloží closed lots a open positions do databáze
   - Přepočítá metriky (win rate, PnL, score, atd.)
   - Metriky používají closed lots pro výpočet PnL (jednotný princip)

## Spuštění na VPS

### 1. Připoj se na VPS
```bash
ssh root@your-vps-ip
```

### 2. Přejdi do adresáře projektu
```bash
cd /opt/tradooor
```

### 3. Spusť přepočet

**Pro přepočet closed lots, metrik a portfolio cache (open + closed positions):**
```bash
pnpm --filter backend recalculate-all-positions-metrics-and-portfolio
```

**Nebo jen closed lots a metriky (bez portfolio cache):**
```bash
pnpm --filter backend recalculate-all-positions-and-metrics
```

**Poznámka:** Skript `recalculate-all-positions-metrics-and-portfolio` vyžaduje běžící backend server pro aktualizaci portfolio cache. Pokud server neběží, portfolio cache se přeskočí (ale closed lots a metriky se přepočítají).

### 4. Sleduj průběh
Skript vypíše:
- Počet zpracovaných walletek
- Počet closed lots pro každou walletku
- Chyby (pokud nějaké nastanou)

### 5. Očekávaný výstup
```
🔄 Recalculating positions and metrics for all wallets...

📋 Found X wallets

[1/X] 🔍 Processing wallet: Wallet Name (address...)
   Trades: 1234
   ✅ Positions: 567 closed lots, 12 open positions
   ✅ Metrics recalculated

[2/X] 🔍 Processing wallet: ...
...

✅ Recalculation complete!
   Processed wallets: X
   Total closed lots: Y
   Errors: Z
```

## Důležité poznámky

### Timeout Protection
- Každá walletka má timeout 120 sekund (2 minuty)
- Pokud se walletka zpracovává déle, přeskočí se a pokračuje se s další
- Timeout protection je také v lot-matching service (60s pro načítání trades)

### Doba běhu
- Záleží na počtu walletek a trades
- Pro ~100 walletek s průměrně 1000 trades: cca 10-30 minut
- Pro více walletek/trades: může trvat déle

### Co dělat během běhu
- **NEPŘERUŠUJ** skript (Ctrl+C) - počkej až dokončí
- Můžeš sledovat logy v jiném terminálu:
  ```bash
  pm2 logs tradooor-backend --lines 0
  ```

### Pokud se skript zasekne
1. Zkontroluj, která walletka způsobuje problém:
   ```bash
   # V terminálu uvidíš poslední zpracovávanou walletku
   ```
2. Pokud je to jedna konkrétní walletka, můžeš ji přeskočit nebo zpracovat zvlášť
3. Restartuj skript - přeskočí už zpracované walletky (ale přepočítá je znovu)

## Ověření výsledků

### 1. Zkontroluj closed lots v databázi
```sql
SELECT wallet_id, COUNT(*) as closed_lots_count 
FROM "ClosedLot" 
GROUP BY wallet_id 
ORDER BY closed_lots_count DESC;
```

### 2. Zkontroluj metriky na homepage
- Otevři homepage
- Zkontroluj, že `recentPnl30d` ladí s closed positions na detailu walletky

### 3. Zkontroluj portfolio endpoint
```bash
curl http://localhost:3001/api/smart-wallets/WALLET_ID/portfolio | jq '.closedPositions | length'
```

Měl by vrátit počet closed positions pro walletku.

## Alternativní způsoby

### Přepočet jen jedné walletky
```bash
# Přes API endpoint
curl -X POST http://localhost:3001/api/smart-wallets/WALLET_ID/recalculate-positions

# Nebo přes skript (uprav skript pro jednu walletku)
```

### Přepočet jen metrik (bez closed lots)
```bash
pnpm --filter backend calculate-metrics
```

### Použití metrics cron (automatický přepočet)
```bash
# Metrics cron už přepočítává closed lots + metriky
# Spusť jednou manuálně:
CRON_SCHEDULE="* * * * *" RUN_ON_START=true pnpm --filter backend metrics:cron
# (nastaví se na každou minutu, ale spustí se jen jednou při startu)
```

## Troubleshooting

### Skript běží příliš dlouho
- To je normální pro velký počet walletek/trades
- Můžeš zkontrolovat průběh v logu
- Pokud běží >1 hodinu, zkontroluj, jestli se nezasekl

### Chyby při zpracování
- Skript pokračuje i při chybách
- Zkontroluj logy pro detaily chyb
- Můžeš znovu spustit skript - přepočítá i walletky s chybami

### PnL stále neladí
1. Zkontroluj, že closed lots existují v databázi
2. Zkontroluj, že metriky byly přepočítány
3. Zkontroluj časové rozmezí (30d = posledních 30 dní)
4. Zkontroluj, že closed lots mají správné `exitTime`

## Po dokončení

1. **Zkontroluj logy:**
   ```bash
   pm2 logs tradooor-backend --lines 100
   ```

2. **Ověř na homepage:**
   - PnL by mělo ladit s closed positions

3. **Ověř na detailu walletky:**
   - Closed positions by měly být zobrazeny
   - PnL by mělo být správné

4. **Restart backend (volitelné):**
   ```bash
   pm2 restart tradooor-backend
   ```
