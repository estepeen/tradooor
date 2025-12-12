# VPS Troubleshooting Guide

## Backend neodpovídá

### 1. Zkontroluj PM2 logy

```bash
pm2 logs tradooor-backend --lines 50
```

### 2. Zkontroluj PM2 status

```bash
pm2 status
```

Pokud je backend `errored` nebo `stopped`:
```bash
pm2 restart tradooor-backend
pm2 logs tradooor-backend
```

### 3. Zkontroluj, že port není obsazený

```bash
lsof -i :3001
# nebo
netstat -tulpn | grep 3001
```

Pokud je port obsazený jiným procesem, zastav ho:
```bash
kill -9 <PID>
```

### 4. Zkontroluj .env soubor

```bash
cd apps/backend
cat .env | grep -E "PORT|DATABASE|SUPABASE"
```

Ujisti se, že:
- `PORT=3001` (nebo jiný port, pokud je změněn)
- `SUPABASE_URL` je správně nastaveno
- `SUPABASE_SERVICE_ROLE_KEY` je správně nastaveno

### 5. Zkontroluj, že backend může připojit k databázi

```bash
cd apps/backend
pnpm start
```

Pokud vidíš chyby, zkontroluj:
- Databázové připojení
- Network connectivity
- Firewall rules

### 6. Restart všech služeb

```bash
pm2 restart all
pm2 logs
```

## Frontend neběží

### 1. Zkontroluj logy

```bash
pm2 logs tradooor-frontend --lines 50
```

### 2. Zkontroluj, že backend běží

Frontend potřebuje backend API. Pokud backend neběží, frontend nebude fungovat správně.

### 3. Zkontroluj .env.local

```bash
cd apps/frontend
cat .env.local
```

Měl by obsahovat:
```env
NEXT_PUBLIC_API_URL=http://localhost:3001/api
```

## Cron joby neběží

### 1. Zkontroluj logy

```bash
pm2 logs tradooor-metrics-cron
pm2 logs tradooor-missing-trades-cron
```

### 2. Zkontroluj, že mají správné env proměnné

```bash
pm2 env 2  # pro metrics-cron
pm2 env 3  # pro missing-trades-cron
```

### 3. Zkontroluj, že RPC URL je nastaveno

```bash
cd apps/backend
cat .env | grep RPC
```

Měl by být nastaven `QUICKNODE_RPC_URL` nebo `SOLANA_RPC_URL`.

### 4. Manuálně spusť cron job pro test

```bash
cd apps/backend
CRON_SCHEDULE="0 * * * *" RUN_ON_START=true pnpm check-missing-trades:cron
```

## Časté problémy

### Port už je obsazený

```bash
# Najdi proces
lsof -i :3001
# Zastav ho
kill -9 <PID>
# Restart PM2
pm2 restart tradooor-backend
```

### Databázové připojení selhává

1. Zkontroluj Supabase credentials
2. Zkontroluj, že Supabase projekt je aktivní
3. Zkontroluj network connectivity

### PM2 procesy se nespouštějí

```bash
# Zkontroluj PM2 daemon
pm2 ping

# Pokud nefunguje, restartuj PM2
pm2 kill
pm2 resurrect
```

### Script selhává při mazání dat

Script nyní maže data po dávkách. Pokud stále selhává:
1. Zkontroluj, že máš dostatek databázových kredítů
2. Zkontroluj Supabase limits
3. Zkus mazat menší dávky (změň limit v scriptu z 1000 na 500)

## Monitoring

### Zobrazit všechny logy najednou

```bash
pm2 logs
```

### Zobrazit logy konkrétního procesu

```bash
pm2 logs tradooor-backend
pm2 logs tradooor-frontend
pm2 logs tradooor-metrics-cron
pm2 logs tradooor-missing-trades-cron
```

### Monitorovat v reálném čase

```bash
pm2 monit
```

### Zobrazit statistiky

```bash
pm2 status
pm2 info tradooor-backend
```

## Restart celého systému

```bash
# Zastav vše
pm2 stop all

# Restart
pm2 restart all

# Nebo úplný restart
pm2 delete all
pm2 start ecosystem.config.js
pm2 save
```

## Kontakt a další pomoc

Pokud problém přetrvává:
1. Zkontroluj všechny logy: `pm2 logs --lines 100`
2. Zkontroluj systémové logy: `journalctl -xe`
3. Zkontroluj disk space: `df -h`
4. Zkontroluj memory: `free -h`
