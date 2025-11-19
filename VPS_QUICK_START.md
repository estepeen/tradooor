# VPS Quick Start - Tradooor

Rychlý návod pro nasazení na Hetzner VPS.

## Prvotní nastavení (jednou)

### 1. Připoj se na VPS

```bash
ssh root@157.180.41.49
# nebo
ssh vps
```

### 2. Spusť setup skript

```bash
# Nahraj setup skript na VPS
# (nebo ho vytvoř přímo na VPS pomocí nano/vim)

# Spusť setup
bash vps-setup.sh
```

Nebo manuálně podle `VPS_DEPLOYMENT.md`.

### 3. Vytvoř .env soubor

```bash
cd /opt/tradooor/apps/backend
nano .env
```

Přidej:
```env
DATABASE_URL=tvoje_supabase_url
DIRECT_URL=tvoje_supabase_direct_url
HELIUS_API_KEY=tvůj_helius_api_key
HELIUS_WEBHOOK_URL=http://157.180.41.49:3001/api/webhooks/helius
PORT=3001
NODE_ENV=production
```

**Získej IP adresu:**
```bash
curl ifconfig.me
```

### 4. Spusť backend

```bash
cd /opt/tradooor
pm2 start "pnpm --filter backend start" --name tradooor-backend
pm2 save
pm2 startup
# Zkopíruj a spusť příkaz, který PM2 vypíše
```

### 5. Vytvoř webhook

```bash
curl -X POST http://localhost:3001/api/smart-wallets/setup-webhook
```

## Workflow pro updaty

### Na MacBooku:

```bash
cd ~/Desktop/Coding/Bots/tradooor

# Udělej změny...

git add .
git commit -m "Popis změn"
git push origin master
```

### Na VPS:

```bash
ssh root@157.180.41.49
cd /opt/tradooor
git pull origin master
pnpm install
pnpm --filter backend build
pm2 restart tradooor-backend
```

Nebo použij deploy skript:
```bash
cd /opt/tradooor
bash deploy.sh
```

## Užitečné příkazy

```bash
# Status
pm2 status

# Logy
pm2 logs tradooor-backend

# Restart
pm2 restart tradooor-backend

# Stop
pm2 stop tradooor-backend
```

## Kontrola

```bash
# Zkontroluj, že backend běží
pm2 status

# Zkontroluj logy
pm2 logs tradooor-backend

# Zkontroluj API
curl http://localhost:3001/health
```

