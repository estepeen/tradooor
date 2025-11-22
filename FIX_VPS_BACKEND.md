# Oprava: Bílá obrazovka - VPS Backend neběží

## Problém
VPS API vrací `502 Bad Gateway`, což znamená, že backend na VPS neběží nebo nginx se k němu nemůže připojit.

## Rychlé řešení

### 1. Připoj se k VPS
```bash
ssh root@157.180.41.49
# nebo
ssh vps@157.180.41.49
```

### 2. Zkontroluj, jestli backend běží
```bash
# Zkontroluj PM2 procesy
pm2 status

# Pokud neběží, spusť:
cd /opt/tradooor
pm2 start "pnpm --filter backend start" --name tradooor-backend
pm2 save
```

### 3. Zkontroluj logy
```bash
# Zobraz logy backendu
pm2 logs tradooor-backend

# Nebo posledních 50 řádků
pm2 logs tradooor-backend --lines 50
```

### 4. Zkontroluj, jestli backend běží na portu 3001
```bash
# Zkontroluj, jestli port 3001 je otevřený
lsof -i :3001

# Nebo zkus curl lokálně na VPS
curl http://localhost:3001/health
curl http://localhost:3001/api/smart-wallets?page=1&pageSize=1
```

### 5. Zkontroluj nginx konfiguraci
```bash
# Zkontroluj nginx config
cat /etc/nginx/sites-available/tradooor.conf
# nebo
cat /etc/nginx/sites-available/default

# Zkontroluj, jestli nginx běží
systemctl status nginx

# Restartuj nginx (pokud je potřeba)
sudo systemctl restart nginx
```

### 6. Pokud backend neběží, spusť ho
```bash
cd /opt/tradooor

# Zkontroluj .env soubor
cat apps/backend/.env

# Spusť backend
cd apps/backend
pnpm start

# Nebo přes PM2
cd /opt/tradooor
pm2 start "pnpm --filter backend start" --name tradooor-backend
pm2 save
```

### 7. Zkontroluj, jestli jsou všechny závislosti nainstalované
```bash
cd /opt/tradooor
pnpm install
pnpm --filter backend build
```

## Časté problémy

### Backend spadl
```bash
# Restartuj backend
pm2 restart tradooor-backend

# Nebo pokud neběží vůbec
pm2 start "pnpm --filter backend start" --name tradooor-backend
```

### Port 3001 je obsazený jiným procesem
```bash
# Najdi proces na portu 3001
lsof -i :3001

# Zabij proces (nahraď PID)
kill -9 <PID>

# Restartuj backend
pm2 restart tradooor-backend
```

### Nginx není správně nakonfigurovaný
```bash
# Zkontroluj nginx error log
tail -f /var/log/nginx/error.log

# Zkontroluj nginx access log
tail -f /var/log/nginx/access.log
```

### Backend má chybu v kódu
```bash
# Zkontroluj logy
pm2 logs tradooor-backend --lines 100

# Zkontroluj, jestli se backend vůbec spustil
pm2 describe tradooor-backend
```

## Po opravě

1. **Zkontroluj, jestli API funguje:**
   ```bash
   curl http://157.180.41.49/api/smart-wallets?page=1&pageSize=1
   ```

2. **Zkontroluj v prohlížeči:**
   - Otevři `http://localhost:4444` (nebo tvůj frontend port)
   - Otevři Developer Tools (F12)
   - Podívej se na Network tab - měly by být úspěšné requesty na `http://157.180.41.49/api/...`

3. **Pokud stále nefunguje:**
   - Zkontroluj CORS nastavení v backendu
   - Zkontroluj, jestli frontend správně používá `NEXT_PUBLIC_API_URL`

