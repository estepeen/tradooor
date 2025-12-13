# VPS Deployment Instructions

## 1. Připojení k VPS

```bash
ssh user@your-vps-ip
```

## 2. Aktualizace kódu

```bash
cd /path/to/tradooor
git pull origin master
```

## 3. Instalace závislostí (pokud se změnily)

```bash
pnpm install
```

## 4. Build frontendu a backendu

```bash
# Build backend
cd apps/backend
pnpm build

# Build frontend
cd ../frontend
pnpm build
```

## 5. Databázové migrace

Spusť SQL migrace v Supabase (nebo přes psql):

```bash
# Připoj se k databázi
psql $DATABASE_URL

# Spusť migrace
\i ADD_PAPER_TRADING.sql
\i ADD_SIGNALS.sql
```

Nebo přes Supabase Dashboard:
1. Otevři Supabase Dashboard
2. Jdi na SQL Editor
3. Zkopíruj obsah `ADD_PAPER_TRADING.sql` a spusť
4. Zkopíruj obsah `ADD_SIGNALS.sql` a spusť

## 6. Environment Variables

Zkontroluj `.env` soubor v root adresáři:

```bash
# Backend
PORT=3001
NODE_ENV=production
DATABASE_URL=postgresql://...
SUPABASE_URL=https://...
SUPABASE_SERVICE_ROLE_KEY=...

# Paper Trading
PAPER_TRADING_ENABLED=true
PAPER_TRADING_COPY_ALL=true
PAPER_TRADING_POSITION_SIZE_PERCENT=5
PAPER_TRADING_MAX_OPEN_POSITIONS=10

# Frontend (pokud je potřeba)
NEXT_PUBLIC_API_URL=http://localhost:3001/api
```

## 7. Restart PM2 procesů

```bash
# Zastav všechny procesy
pm2 stop all

# Restart všechny procesy (načte novou konfiguraci)
pm2 restart ecosystem.config.js

# Nebo restart konkrétní procesy
pm2 restart tradooor-backend
pm2 restart tradooor-frontend
pm2 restart tradooor-paper-trading-monitor

# Zkontroluj status
pm2 status
pm2 logs
```

## 8. Zkontroluj, že vše běží

```bash
# Backend health check
curl http://localhost:3001/health

# Frontend (pokud běží na portu 4444)
curl http://localhost:4444

# Zkontroluj logy
pm2 logs tradooor-paper-trading-monitor --lines 50
```

## 9. Pokud je potřeba přidat nový worker

```bash
# Uprav ecosystem.config.js (už je tam paper-trading-monitor)
# Pak restart PM2
pm2 restart ecosystem.config.js

# Nebo přidej manuálně
pm2 start ecosystem.config.js --only tradooor-paper-trading-monitor
```

## 10. Troubleshooting

### Backend neběží
```bash
pm2 logs tradooor-backend --lines 100
# Zkontroluj chyby v logu
```

### Frontend neběží
```bash
pm2 logs tradooor-frontend --lines 100
# Zkontroluj, jestli je build úspěšný
cd apps/frontend
pnpm build
```

### Paper trading monitor neběží
```bash
pm2 logs tradooor-paper-trading-monitor --lines 100
# Zkontroluj env proměnné
# Zkontroluj, jestli jsou vytvořené databázové tabulky
```

### Databázové chyby
```bash
# Zkontroluj, jestli jsou vytvořené tabulky
psql $DATABASE_URL -c "\dt" | grep -E "(PaperTrade|PaperPortfolio|Signal)"
```

## Rychlý deploy script

Můžeš vytvořit `deploy.sh`:

```bash
#!/bin/bash
set -e

echo "🔄 Pulling latest changes..."
git pull origin master

echo "📦 Installing dependencies..."
pnpm install

echo "🏗️  Building..."
cd apps/backend && pnpm build && cd ../frontend && pnpm build && cd ../..

echo "🔄 Restarting PM2..."
pm2 restart ecosystem.config.js

echo "✅ Deployment complete!"
pm2 status
```

Pak spusť:
```bash
chmod +x deploy.sh
./deploy.sh
```

