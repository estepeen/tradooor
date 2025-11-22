# Oprava: Backend Error na VPS

## Problém
Backend na VPS neběží kvůli chybě:
```
SyntaxError: The requested module '../services/solana-collector.service.js' does not provide an export named 'SolanaCollectorService'
```

## Řešení

Soubor `solana-collector.service.ts` byl prázdný. Opravil jsem ho - nyní obsahuje minimální `SolanaCollectorService` třídu s metodou `processWebhookTransaction`.

### Krok 1: Pushni změny na Git
```bash
# Lokálně
git add apps/backend/src/services/solana-collector.service.ts
git commit -m "Fix: Restore SolanaCollectorService class"
git push origin master
```

### Krok 2: Na VPS - Pullni změny
```bash
ssh root@157.180.41.49
cd /opt/tradooor
git pull origin master
```

### Krok 3: Rebuildni backend
```bash
cd /opt/tradooor
pnpm install
pnpm --filter backend build
```

### Krok 4: Restartuj backend
```bash
pm2 restart tradooor-backend
```

### Krok 5: Zkontroluj logy
```bash
pm2 logs tradooor-backend --lines 50
```

Mělo by se zobrazit:
```
🚀 Backend server running on http://0.0.0.0:3001
```

## Ověření

Po restartu zkontroluj:
```bash
# Na VPS
curl http://localhost:3001/health

# Z lokálního počítače
curl http://157.180.41.49/api/smart-wallets?page=1&pageSize=1
```

Mělo by vrátit JSON data, ne 502 Bad Gateway.

## Pokud stále nefunguje

1. **Zkontroluj logy:**
   ```bash
   pm2 logs tradooor-backend --lines 100
   ```

2. **Zkontroluj, jestli jsou všechny závislosti nainstalované:**
   ```bash
   cd /opt/tradooor
   pnpm install
   ```

3. **Zkontroluj TypeScript build:**
   ```bash
   cd /opt/tradooor/apps/backend
   pnpm build
   ```

4. **Zkontroluj PM2 status:**
   ```bash
   pm2 status
   pm2 describe tradooor-backend
   ```

