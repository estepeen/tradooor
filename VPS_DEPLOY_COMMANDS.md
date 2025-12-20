# Příkazy pro nasazení na VPS

## 🔄 Standardní nasazení (git pull + rebuild + restart)

```bash
cd /opt/tradooor && \
git pull origin master && \
pnpm install --frozen-lockfile && \
pnpm --filter backend build && \
pnpm --filter frontend build && \
pm2 restart tradooor-backend && \
pm2 restart tradooor-normalized-trade-processor && \
pm2 restart tradooor-metrics-cron && \
pm2 restart tradooor-frontend && \
pm2 save
```

## 🚀 Kompletní restart s rebuildem (doporučeno)

```bash
cd /opt/tradooor && \
git pull origin master && \
pnpm install --frozen-lockfile && \
pnpm --filter backend build && \
pnpm --filter frontend build && \
pm2 restart all && \
pm2 save && \
sleep 10 && \
pm2 status
```

## 🔍 Debug a kontrola

### Zkontrolovat status služeb
```bash
pm2 status
```

### Zobrazit logy backendu
```bash
pm2 logs tradooor-backend --lines 50
```

### Zobrazit logy frontendu
```bash
pm2 logs tradooor-frontend --lines 50
```

### Debug PnL pro konkrétní wallet
```bash
cd /opt/tradooor && \
pnpm --filter backend debug:pnl-display 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f
```

### Přepočítat metriky pro wallet
```bash
cd /opt/tradooor && \
pnpm --filter backend recalculate:wallet-closed-positions 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f
```

## 🛠️ Rychlé příkazy (jednotlivě)

### Pouze git pull
```bash
cd /opt/tradooor && git pull origin master
```

### Pouze rebuild backendu
```bash
cd /opt/tradooor && pnpm --filter backend build
```

### Pouze rebuild frontendu
```bash
cd /opt/tradooor && pnpm --filter frontend build
```

### Pouze restart backendu
```bash
pm2 restart tradooor-backend
```

### Pouze restart frontendu
```bash
pm2 restart tradooor-frontend
```

### Restart všech služeb
```bash
pm2 restart all
```

## 📋 Seznam všech PM2 procesů

```bash
pm2 list
```

## 🔄 Restart konkrétního procesu

```bash
pm2 restart tradooor-backend
pm2 restart tradooor-normalized-trade-processor
pm2 restart tradooor-metrics-cron
pm2 restart tradooor-frontend
```

## 🗑️ Vymazat logy

```bash
pm2 flush
```

## 📊 Monitorování v reálném čase

```bash
pm2 monit
```

## ⚠️ V případě problémů

### Zastavit všechny procesy
```bash
pm2 stop all
```

### Spustit všechny procesy
```bash
pm2 start all
```

### Restartovat PM2 daemon
```bash
pm2 kill && pm2 resurrect
```

### Zkontrolovat, jestli běží databáze
```bash
sudo systemctl status postgresql
```

### Zkontrolovat, jestli běží všechny služby
```bash
pm2 status && sudo systemctl status postgresql
```

