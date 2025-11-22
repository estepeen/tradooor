# Oprava: Web stále nefunguje

## Problém
Backend má stále chyby `EADDRINUSE` - port 3001 je obsazený. PM2 se snaží restartovat proces, ale nemůže bindnout na port.

## Rychlé řešení

### Na VPS spusť tento script:

```bash
cd /opt/tradooor
bash fix-pm2-port-conflict.sh
```

### Nebo manuálně:

```bash
# 1. Zastav a smaž všechny PM2 procesy
pm2 stop all
pm2 delete all

# 2. Zkontroluj a zabij proces na portu 3001
lsof -i :3001
# Pokud najdeš proces, zabij ho:
kill -9 <PID>

# Nebo zabij všechny procesy na portu 3001:
lsof -ti :3001 | xargs kill -9

# 3. Zkontroluj, jestli je port volný
lsof -i :3001
# Mělo by být prázdné

# 4. Spusť backend znovu
cd /opt/tradooor
pm2 start "pnpm --filter backend start" --name tradooor-backend
pm2 save

# 5. Zkontroluj status
pm2 status
pm2 logs tradooor-backend --lines 20
```

## Ověření

Po restartu zkontroluj:

```bash
# 1. Jestli backend běží
pm2 status
# Měl by být jen JEDEN proces tradooor-backend se statusem "online"

# 2. Jestli API funguje
curl http://localhost:3001/health
# Mělo by vrátit: {"status":"ok","timestamp":"..."}

# 3. Jestli API funguje zvenku
curl http://157.180.41.49/api/smart-wallets?page=1&pageSize=1
# Mělo by vrátit JSON data, ne 502 Bad Gateway
```

## Pokud stále nefunguje

### Zkontroluj frontend:
```bash
# Lokálně
curl http://localhost:4444
# Nebo otevři v prohlížeči a zkontroluj Developer Tools (F12)
```

### Zkontroluj nginx:
```bash
# Na VPS
systemctl status nginx
tail -f /var/log/nginx/error.log
```

### Zkontroluj, jestli frontend běží:
```bash
# Lokálně
ps aux | grep "next dev"
# Pokud neběží, spusť:
cd apps/frontend
pnpm dev
```

