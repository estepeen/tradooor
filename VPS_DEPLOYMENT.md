# VPS Deployment - Kompletní postup

Tento dokument popisuje, jak nastavit a spustit aplikaci na VPS od nuly.

## Předpoklady

- VPS s Ubuntu/Debian (nebo jiný Linux)
- Node.js >= 18.0.0 nainstalovaný
- pnpm >= 8.0.0 nainstalovaný
- Git nainstalovaný
- PM2 nebo systemd pro správu procesů

## Krok 1: Reset všech dat

### 1.1 Připoj se na VPS

```bash
ssh user@your-vps-ip
```

### 1.2 Přejdi do projektu

```bash
cd /path/to/tradooor
```

### 1.3 Vymaž všechna trades data

```bash
cd apps/backend
pnpm trades:delete-all
```

Tento script smaže:
- Všechny trades
- Všechny closed lots
- Všechny trade features
- Portfolio baseline cache
- Metrics history
- Resetuje všechny wallet metriky na 0

## Krok 2: Zkontroluj konfiguraci

### 2.1 Zkontroluj `.env` soubor

```bash
cd apps/backend
cat .env
```

Ujisti se, že máš nastaveno:
```env
# Database
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# RPC
QUICKNODE_RPC_URL=https://your-quicknode-url
# Nebo fallback:
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Port
PORT=3001
NODE_ENV=production
```

### 2.2 Zkontroluj frontend `.env.local`

```bash
cd apps/frontend
cat .env.local
```

Měl by obsahovat:
```env
NEXT_PUBLIC_API_URL=http://localhost:3001/api
# Nebo pro produkci:
# NEXT_PUBLIC_API_URL=https://your-domain.com/api
```

## Krok 3: Restart služeb

### 3.1 Zastav všechny běžící procesy

Pokud používáš **PM2**:
```bash
pm2 stop all
pm2 delete all
```

Pokud používáš **systemd**:
```bash
sudo systemctl stop tradooor-backend
sudo systemctl stop tradooor-frontend
```

Pokud běží přímo:
```bash
# Najdi procesy
ps aux | grep node
# Zastav je
killall node
```

### 3.2 Zkontroluj, že nic neběží

```bash
ps aux | grep node
# Mělo by být prázdné (kromě případného PM2 daemonu)
```

## Krok 4: Spuštění aplikace

### Varianta A: PM2 (doporučeno)

#### 4.1 Instalace PM2 (pokud není nainstalováno)

```bash
npm install -g pm2
```

#### 4.2 Vytvoř PM2 ecosystem file

Vytvoř soubor `ecosystem.config.js` v root projektu:

```javascript
module.exports = {
  apps: [
    {
      name: 'tradooor-backend',
      script: 'pnpm',
      args: '--filter backend start',
      cwd: '/path/to/tradooor',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/backend-error.log',
      out_file: './logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'tradooor-frontend',
      script: 'pnpm',
      args: '--filter frontend start',
      cwd: '/path/to/tradooor',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/frontend-error.log',
      out_file: './logs/frontend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'tradooor-metrics-cron',
      script: 'pnpm',
      args: '--filter backend metrics:cron',
      cwd: '/path/to/tradooor',
      env: {
        NODE_ENV: 'production',
        CRON_SCHEDULE: '0 * * * *', // Každou hodinu
      },
      error_file: './logs/metrics-cron-error.log',
      out_file: './logs/metrics-cron-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'tradooor-missing-trades-cron',
      script: 'pnpm',
      args: '--filter backend check-missing-trades:cron',
      cwd: '/path/to/tradooor',
      env: {
        NODE_ENV: 'production',
        CRON_SCHEDULE: '0 * * * *', // Každou hodinu
      },
      error_file: './logs/missing-trades-cron-error.log',
      out_file: './logs/missing-trades-cron-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
```

**Důležité:** Nahraď `/path/to/tradooor` skutečnou cestou k projektu.

#### 4.3 Vytvoř logy adresář

```bash
mkdir -p logs
```

#### 4.4 Spusť všechny služby

```bash
pm2 start ecosystem.config.js
```

#### 4.5 Ulož PM2 konfiguraci

```bash
pm2 save
pm2 startup
# Spusť příkaz, který PM2 vypíše (pro automatický start po rebootu)
```

#### 4.6 Zkontroluj status

```bash
pm2 status
pm2 logs
```

### Varianta B: systemd

#### 4.1 Vytvoř systemd service pro backend

```bash
sudo nano /etc/systemd/system/tradooor-backend.service
```

Vlož:
```ini
[Unit]
Description=Tradooor Backend
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/tradooor
Environment="NODE_ENV=production"
ExecStart=/usr/bin/pnpm --filter backend start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

#### 4.2 Vytvoř systemd service pro frontend

```bash
sudo nano /etc/systemd/system/tradooor-frontend.service
```

Vlož:
```ini
[Unit]
Description=Tradooor Frontend
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/tradooor
Environment="NODE_ENV=production"
ExecStart=/usr/bin/pnpm --filter frontend start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

#### 4.3 Vytvoř systemd timer pro metrics cron

```bash
sudo nano /etc/systemd/system/tradooor-metrics-cron.service
```

Vlož:
```ini
[Unit]
Description=Tradooor Metrics Cron

[Service]
Type=oneshot
User=your-user
WorkingDirectory=/path/to/tradooor
Environment="NODE_ENV=production"
ExecStart=/usr/bin/pnpm --filter backend metrics:cron
```

```bash
sudo nano /etc/systemd/system/tradooor-metrics-cron.timer
```

Vlož:
```ini
[Unit]
Description=Run Tradooor Metrics Cron every hour

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

#### 4.4 Vytvoř systemd timer pro missing trades cron

```bash
sudo nano /etc/systemd/system/tradooor-missing-trades-cron.service
```

Vlož:
```ini
[Unit]
Description=Tradooor Missing Trades Cron

[Service]
Type=oneshot
User=your-user
WorkingDirectory=/path/to/tradooor
Environment="NODE_ENV=production"
ExecStart=/usr/bin/pnpm --filter backend check-missing-trades:cron
```

```bash
sudo nano /etc/systemd/system/tradooor-missing-trades-cron.timer
```

Vlož:
```ini
[Unit]
Description=Run Tradooor Missing Trades Cron every hour

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

#### 4.5 Aktivuj a spusť služby

```bash
sudo systemctl daemon-reload
sudo systemctl enable tradooor-backend
sudo systemctl enable tradooor-frontend
sudo systemctl enable tradooor-metrics-cron.timer
sudo systemctl enable tradooor-missing-trades-cron.timer

sudo systemctl start tradooor-backend
sudo systemctl start tradooor-frontend
sudo systemctl start tradooor-metrics-cron.timer
sudo systemctl start tradooor-missing-trades-cron.timer
```

#### 4.6 Zkontroluj status

```bash
sudo systemctl status tradooor-backend
sudo systemctl status tradooor-frontend
sudo systemctl list-timers
```

## Krok 5: Verifikace

### 5.1 Zkontroluj, že backend běží

```bash
curl http://localhost:3001/api/smart-wallets
# Mělo by vrátit JSON s wallets
```

### 5.2 Zkontroluj, že frontend běží

```bash
curl http://localhost:3000
# Mělo by vrátit HTML
```

### 5.3 Zkontroluj logy

**PM2:**
```bash
pm2 logs tradooor-backend
pm2 logs tradooor-metrics-cron
pm2 logs tradooor-missing-trades-cron
```

**systemd:**
```bash
sudo journalctl -u tradooor-backend -f
sudo journalctl -u tradooor-metrics-cron -f
sudo journalctl -u tradooor-missing-trades-cron -f
```

### 5.4 Zkontroluj, že cron joby běží

**PM2:**
```bash
pm2 status
# Měly by být všechny procesy "online"
```

**systemd:**
```bash
sudo systemctl list-timers | grep tradooor
# Měly by být aktivní timery
```

## Krok 6: Monitoring

### 6.1 Zkontroluj, že se trades sbírají

```bash
# Připoj se na databázi a zkontroluj trades
# Nebo použij API
curl http://localhost:3001/api/trades?walletId=WALLET_ID
```

### 6.2 Zkontroluj logy cron jobů

Po první hodině bys měl vidět v logách:
- Metrics cron: přepočet metrik pro všechny wallets
- Missing trades cron: kontrola chybějících trades přes RPC

### 6.3 Nastav alerting (volitelné)

Můžeš použít:
- PM2 monitoring: `pm2 monit`
- Systemd monitoring: `sudo systemctl status`
- Log monitoring: `tail -f logs/*.log`

## Troubleshooting

### Backend neběží

1. Zkontroluj logy: `pm2 logs tradooor-backend` nebo `sudo journalctl -u tradooor-backend`
2. Zkontroluj `.env` soubor
3. Zkontroluj, že port 3001 není obsazený: `lsof -i :3001`

### Cron joby neběží

1. Zkontroluj logy: `pm2 logs tradooor-metrics-cron`
2. Zkontroluj, že `CRON_SCHEDULE` je správně nastaveno
3. Pro systemd: `sudo systemctl status tradooor-metrics-cron.timer`

### Trades se nesbírají

1. Zkontroluj, že RPC URL je správně nastaveno
2. Zkontroluj logy missing trades cron: `pm2 logs tradooor-missing-trades-cron`
3. Zkontroluj, že wallets jsou v databázi

### Frontend neběží

1. Zkontroluj logy: `pm2 logs tradooor-frontend`
2. Zkontroluj, že backend běží a je dostupný
3. Zkontroluj `.env.local` soubor

## Rychlý restart (po změnách)

```bash
# PM2
pm2 restart all

# systemd
sudo systemctl restart tradooor-backend
sudo systemctl restart tradooor-frontend
```

## Úplný reset (vše od nuly)

```bash
# 1. Zastav vše
pm2 stop all  # nebo sudo systemctl stop tradooor-*

# 2. Vymaž data
cd apps/backend
pnpm trades:delete-all

# 3. Restart
pm2 restart all  # nebo sudo systemctl start tradooor-*
```

## Poznámky

- **PM2** je jednodušší pro začátek a má lepší monitoring
- **systemd** je lepší pro produkci a integraci s OS
- Cron joby běží každou hodinu (můžeš změnit přes `CRON_SCHEDULE` env var)
- Všechny logy jsou v `./logs/` adresáři (PM2) nebo v systemd journal
