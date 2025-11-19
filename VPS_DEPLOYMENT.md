# VPS Deployment Guide - Tradooor

Návod pro nasazení Tradooor bota na Hetzner VPS.

## Předpoklady

- Hetzner VPS s Ubuntu/Debian
- SSH přístup k VPS
- Git repo: https://github.com/estepeen/tradooor

## Krok 1: Prvotní nastavení na VPS

### Připojení k VPS

```bash
ssh root@157.180.41.49
# nebo pokud máš jiného uživatele:
ssh vps
```

### Instalace Node.js a závislostí

```bash
# Aktualizuj systém
apt update && apt upgrade -y

# Nainstaluj Node.js pomocí nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# Nainstaluj pnpm
npm install -g pnpm

# Nainstaluj PM2 (pro správu procesů)
npm install -g pm2
```

### Vytvoření složky a klonování repo

```bash
# Vytvoř složku
mkdir -p /opt/tradooor
cd /opt/tradooor

# Klonuj repo
git clone https://github.com/estepeen/tradooor.git .

# Nebo pokud už existuje:
cd /opt/tradooor
git pull origin master
```

## Krok 2: Nastavení Environment Variables

```bash
cd /opt/tradooor/apps/backend
nano .env
```

Přidej do `.env`:

```env
# Database (Supabase)
DATABASE_URL=tvoje_supabase_connection_string
DIRECT_URL=tvoje_supabase_direct_connection_string

# Helius
HELIUS_API_KEY=tvůj_helius_api_key

# Webhook URL - použij IP adresu VPS
HELIUS_WEBHOOK_URL=http://157.180.41.49:3001/api/webhooks/helius

# Port
PORT=3001
NODE_ENV=production

# Ostatní proměnné (pokud máš)
# BINANCE_API_KEY=...
# BINANCE_API_SECRET=...
```

**Důležité:** Získej IP adresu VPS:
```bash
curl ifconfig.me
```

## Krok 3: Instalace závislostí a build

```bash
cd /opt/tradooor

# Instalace závislostí
pnpm install

# Build backendu
pnpm --filter backend build
```

## Krok 4: Nastavení PM2

```bash
cd /opt/tradooor

# Spusť backend jako službu
pm2 start "pnpm --filter backend start" --name tradooor-backend

# Ulož PM2 konfiguraci
pm2 save

# Nastav automatický start po restartu VPS
pm2 startup
# Zkopíruj a spusť příkaz, který PM2 vypíše
```

## Krok 5: Nastavení Firewallu

```bash
# Otevři port 3001
ufw allow 3001/tcp
ufw enable
```

## Krok 6: Vytvoření Webhooku

```bash
# Zkontroluj, že backend běží
pm2 status
pm2 logs tradooor-backend

# Vytvoř webhook pro všechny walletky
curl -X POST http://localhost:3001/api/smart-wallets/setup-webhook
```

## Krok 7: Ověření

```bash
# Zkontroluj status
pm2 status

# Zkontroluj logy
pm2 logs tradooor-backend

# Zkontroluj, že API funguje
curl http://localhost:3001/health
```

## Workflow pro updaty

### Na lokálním počítači (MacBook):

```bash
cd ~/Desktop/Coding/Bots/tradooor

# Udělej změny v kódu...

# Commit a push
git add .
git commit -m "Popis změn"
git push origin master
```

### Na VPS:

```bash
ssh root@157.180.41.49
# nebo
ssh vps

cd /opt/tradooor

# Pull nejnovější změny
git pull origin master

# Instalace nových závislostí (pokud byly přidány)
pnpm install

# Build (pokud se změnil backend)
pnpm --filter backend build

# Restart backendu
pm2 restart tradooor-backend

# Zkontroluj logy
pm2 logs tradooor-backend --lines 50
```

## Užitečné PM2 příkazy

```bash
# Status všech procesů
pm2 status

# Logy
pm2 logs tradooor-backend

# Restart
pm2 restart tradooor-backend

# Stop
pm2 stop tradooor-backend

# Start
pm2 start tradooor-backend

# Smaž z PM2
pm2 delete tradooor-backend

# Monitor (real-time)
pm2 monit
```

## Troubleshooting

### Backend neběží

```bash
# Zkontroluj logy
pm2 logs tradooor-backend

# Zkontroluj, jestli port není obsazený
lsof -i :3001

# Zkontroluj environment variables
cd /opt/tradooor/apps/backend
cat .env
```

### Webhook nefunguje

1. Zkontroluj, že backend běží: `pm2 status`
2. Zkontroluj webhook URL v `.env`: `HELIUS_WEBHOOK_URL`
3. Zkontroluj, že port 3001 je otevřený: `ufw status`
4. Zkontroluj Helius dashboard: https://dashboard.helius.dev/

### Port je obsazený

```bash
# Najdi proces na portu 3001
lsof -i :3001

# Zastav proces
kill -9 PID
```

## Nastavení DNS (volitelné - pokud máš doménu)

Pokud máš doménu stepanpanek.cz a chceš použít subdoménu:

1. **DNS záznam:**
   - Subdoména: `api` (nebo `bot`, `tradooor`)
   - Typ: A
   - IP: `157.180.41.49`
   - TTL: 3600

2. **Nginx + HTTPS:**
   - Viz sekce "Nastavení Nginx + HTTPS" v hlavním návodu

3. **Aktualizuj `.env`:**
   ```env
   HELIUS_WEBHOOK_URL=https://api.stepanpanek.cz/api/webhooks/helius
   ```

4. **Restart backendu:**
   ```bash
   pm2 restart tradooor-backend
   ```

5. **Aktualizuj webhook:**
   ```bash
   curl -X POST http://localhost:3001/api/smart-wallets/setup-webhook
   ```

