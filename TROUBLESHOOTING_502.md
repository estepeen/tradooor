# Troubleshooting 502 Bad Gateway Errors

## Problém
502 Bad Gateway znamená, že Nginx nemůže připojit k backendu (port 3001).

## Krok 1: Zkontroluj, jestli backend běží

```bash
# Připoj se na VPS
ssh root@tradooor.stepanpanek.cz

# Zkontroluj PM2 procesy
pm2 list

# Měl bys vidět:
# - tradooor-backend (mělo by být "online")
# - tradooor-frontend (mělo by být "online")
```

## Krok 2: Pokud backend neběží, spusť ho

```bash
cd /opt/tradooor

# Zkontroluj, jestli existuje .env soubor
ls -la apps/backend/.env

# Pokud ne, vytvoř ho nebo zkontroluj proměnné prostředí

# Spusť backend přes PM2
pm2 start "pnpm --filter backend start" --name tradooor-backend

# Nebo restartuj, pokud už běží
pm2 restart tradooor-backend

# Ulož PM2 konfiguraci
pm2 save
```

## Krok 3: Zkontroluj backend logy

```bash
# Zobraz logy backendu
pm2 logs tradooor-backend --lines 50

# Hledej chyby jako:
# - "Error: Cannot find module"
# - "EADDRINUSE" (port už je používán)
# - "Missing environment variables"
# - Database connection errors
```

## Krok 4: Zkontroluj, jestli backend naslouchá na portu 3001

```bash
# Zkontroluj, jestli něco naslouchá na portu 3001
netstat -tuln | grep 3001
# Nebo
ss -tuln | grep 3001

# Mělo by být:
# tcp  0  0  127.0.0.1:3001  LISTEN
```

## Krok 5: Zkontroluj Nginx konfiguraci

```bash
# Zkontroluj Nginx config
sudo nginx -t

# Zkontroluj, jestli proxy_pass ukazuje na správný port
sudo cat /etc/nginx/sites-available/tradooor | grep proxy_pass

# Mělo by být:
# proxy_pass http://localhost:3001;
```

## Krok 6: Zkontroluj Nginx error logy

```bash
# Zobraz Nginx error logy
sudo tail -f /var/log/nginx/error.log

# Hledej chyby jako:
# "connect() failed (111: Connection refused)"
# "upstream timed out"
```

## Krok 7: Zkontroluj, jestli frontend běží

```bash
# Zkontroluj frontend
pm2 logs tradooor-frontend --lines 20

# Zkontroluj, jestli frontend naslouchá na portu 3000
netstat -tuln | grep 3000
```

## Krok 8: Restartuj vše

```bash
# Restartuj backend
pm2 restart tradooor-backend

# Restartuj frontend
pm2 restart tradooor-frontend

# Restartuj Nginx
sudo systemctl reload nginx

# Zkontroluj status
pm2 status
```

## Krok 9: Zkontroluj environment variables

```bash
cd /opt/tradooor/apps/backend

# Zkontroluj .env soubor
cat .env

# Měly by být nastavené:
# - SUPABASE_URL
# - SUPABASE_SERVICE_ROLE_KEY
# - SOLANA_RPC_URL
# - PORT=3001
# - NODE_ENV=production (nebo development)
```

## Krok 10: Zkontroluj, jestli jsou všechny závislosti nainstalované

```bash
cd /opt/tradooor

# Zkontroluj, jestli jsou node_modules
ls -la apps/backend/node_modules

# Pokud ne, nainstaluj závislosti
pnpm install
```

## Časté problémy a řešení

### Backend crashuje při startu
- Zkontroluj logy: `pm2 logs tradooor-backend`
- Zkontroluj, jestli jsou všechny environment variables nastavené
- Zkontroluj, jestli databáze běží a je dostupná

### Port 3001 je už používán
```bash
# Najdi proces, který používá port 3001
sudo lsof -i :3001

# Zastav ho
sudo kill -9 <PID>
```

### Backend běží, ale Nginx se nemůže připojit
- Zkontroluj firewall: `sudo ufw status`
- Zkontroluj, jestli backend naslouchá na `127.0.0.1:3001` (ne jen `localhost`)
- Zkontroluj SELinux (pokud je aktivní)

### Frontend se nenačítá
- Zkontroluj, jestli frontend běží: `pm2 logs tradooor-frontend`
- Zkontroluj, jestli je frontend buildnutý: `ls -la apps/frontend/.next`
- Pokud ne, buildni: `cd apps/frontend && pnpm build`

## Rychlý fix (pokud nic z výše nefunguje)

```bash
cd /opt/tradooor

# Pullni nejnovější změny
git pull origin master

# Nainstaluj závislosti
pnpm install

# Buildni frontend
cd apps/frontend
pnpm build

# Restartuj vše
pm2 restart all
pm2 save

# Restartuj Nginx
sudo systemctl reload nginx
```

