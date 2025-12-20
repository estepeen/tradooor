# Instrukce pro aktualizaci na VPS - Timeout Fix

## Co bylo opraveno
- Přidána timeout protection pro validaci trade IDs (prevence zasekávání)
- Přidána timeout protection pro načítání trades a closed lots
- Vylepšen error handling pro prevenci nekonečného čekání
- Přidáno lepší logování pro debugging

## Postup aktualizace na VPS

### 1. Připoj se na VPS
```bash
ssh root@your-vps-ip
```

### 2. Přejdi do adresáře projektu
```bash
cd /opt/tradooor
```

### 3. Stáhni nejnovější změny z Git
```bash
git pull origin master
```

### 4. Nainstaluj závislosti (pokud se změnily)
```bash
pnpm install
```

### 5. Restartuj backend pomocí PM2
```bash
pm2 restart tradooor-backend
```

### 6. Zkontroluj, že backend běží správně
```bash
pm2 status
pm2 logs tradooor-backend --lines 50
```

### 7. (Volitelné) Pokud používáš frontend na VPS, restartuj i ten
```bash
pm2 restart tradooor-frontend
```

## Ověření, že oprava funguje

### Test 1: Zkontroluj logy při výpočtu metrik
```bash
pm2 logs tradooor-backend --lines 100 | grep -i "timeout\|validated\|processing"
```

Měli byste vidět:
- `✅ Validated X/Y trade IDs exist in DB (processed N batches)` - validace proběhla
- `📊 Processing X trades for wallet...` - načítání trades proběhlo
- Žádné timeout chyby

### Test 2: Spusť manuální výpočet metrik pro jednu wallet
```bash
cd /opt/tradooor
pnpm --filter backend calculate-metrics WALLET_ID
```

Příkaz by se měl dokončit do 60 sekund (ne zaseknout).

### Test 3: Zkontroluj portfolio endpoint
```bash
curl http://localhost:3001/api/smart-wallets/WALLET_ID/portfolio
```

Měl by vrátit data do 60 sekund.

## Co dělat, pokud se stále zasekává

1. **Zkontroluj logy:**
   ```bash
   pm2 logs tradooor-backend --lines 200
   ```

2. **Zkontroluj, kolik trades má wallet:**
   ```bash
   # V databázi zkontroluj počet trades pro problematickou wallet
   ```

3. **Pokud má wallet příliš mnoho trades (>10,000), zvaž:**
   - Přidání indexů do databáze
   - Optimalizaci dotazů
   - Dávkové zpracování

## Poznámky

- Timeouty jsou nastaveny na:
  - 30 sekund pro celkovou validaci trade IDs
  - 5 sekund pro každý batch validace (500 trade IDs)
  - 60 sekund pro načítání trades a closed lots
  - 30 sekund pro cached closed lots

- Pokud se procesy stále zasekávají, může to znamenat:
  - Příliš mnoho trades pro wallet (potřebuje optimalizaci)
  - Problém s databázovým připojením
  - Problém s výkonem VPS

## Rollback (pokud by bylo potřeba)

Pokud by oprava způsobila problémy, můžete se vrátit k předchozí verzi:

```bash
cd /opt/tradooor
git log --oneline -10  # Najdi commit před opravou
git checkout <commit-hash>
pnpm install
pm2 restart tradooor-backend
```









