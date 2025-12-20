# Deployment na VPS - Kompletní návod

## Rychlý deploy s přepočtem walletu

```bash
# Na VPS spusť:
cd /opt/tradooor
./deploy-and-recalculate.sh 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f
```

## Manuální kroky (pokud potřebuješ více kontroly)

### 1. Připoj se na VPS
```bash
ssh root@your-vps-ip
# nebo
ssh user@your-vps-ip
```

### 2. Přejdi do projektu
```bash
cd /opt/tradooor
```

### 3. Git pull
```bash
git fetch origin
git checkout main
git pull origin main
```

### 4. Instalace závislostí
```bash
pnpm install --frozen-lockfile
```

### 5. Build backendu
```bash
pnpm --filter backend build
```

### 6. Restart PM2 procesů
```bash
pm2 restart tradooor-backend
pm2 restart tradooor-normalized-trade-processor
pm2 restart tradooor-metrics-cron
pm2 save
```

### 7. Přepočet walletu
```bash
pnpm --filter backend recalculate:wallet-closed-positions 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f
```

## Kontrola výsledků

### Zkontroluj PM2 status
```bash
pm2 status
```

### Zkontroluj logy
```bash
pm2 logs tradooor-backend --lines 50
pm2 logs tradooor-normalized-trade-processor --lines 50
```

### Zkontroluj PnL v databázi
```bash
# Připoj se k PostgreSQL
psql $DATABASE_URL

# Zkontroluj PnL pro wallet
SELECT id, address, label, "recentPnl30dUsd", "recentPnl30dPercent" 
FROM "SmartWallet" 
WHERE address = '2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f';
```

## Oprava PnL hodnot (pokud jsou stále špatné)

```bash
# Spusť skript na opravu všech PnL hodnot
pnpm --filter backend fix:pnl-values

# Pak přepočítej metriky
pnpm --filter backend metrics:cron
```

## Troubleshooting

### Pokud PM2 procesy neběží
```bash
# Zkontroluj, které procesy jsou spuštěné
pm2 list

# Pokud nejsou, spusť je
cd /opt/tradooor
pm2 start ecosystem.config.js
pm2 save
```

### Pokud build selže
```bash
# Zkontroluj TypeScript chyby
pnpm --filter backend build

# Pokud jsou chyby, oprav je lokálně a pushni
```

### Pokud databáze není dostupná
```bash
# Zkontroluj DATABASE_URL v .env
cat .env | grep DATABASE_URL

# Zkontroluj, jestli PostgreSQL běží
sudo systemctl status postgresql
```

