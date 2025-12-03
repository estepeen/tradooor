# VPS Deployment Guide - Tradooor

Guide for deploying Tradooor bot on Hetzner VPS.

## Prerequisites

- Hetzner VPS with Ubuntu/Debian
- SSH access to VPS
- Git repo: https://github.com/estepeen/tradooor

## Step 1: Initial Setup on VPS

### Connect to VPS

```bash
ssh root@157.180.41.49
# or if you have another user:
ssh vps
```

### Install Node.js and Dependencies

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js using nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# Install pnpm
npm install -g pnpm

# Install PM2 (for process management)
npm install -g pm2
```

### Create Folder and Clone Repo

```bash
# Create folder
mkdir -p /opt/tradooor
cd /opt/tradooor

# Clone repo
git clone https://github.com/estepeen/tradooor.git .

# Or if it already exists:
cd /opt/tradooor
git pull origin master
```

## Step 2: Environment Variables Setup

```bash
cd /opt/tradooor/apps/backend
nano .env
```

Add to `.env`:

```env
# Database (Supabase)
DATABASE_URL=your_supabase_connection_string
DIRECT_URL=your_supabase_direct_connection_string

# Helius
HELIUS_API_KEY=your_helius_api_key

# Webhook URL - use VPS IP address
HELIUS_WEBHOOK_URL=http://157.180.41.49:3001/api/webhooks/helius

# Port
PORT=3001
NODE_ENV=production

# Other variables (if you have)
# BINANCE_API_KEY=...
# BINANCE_API_SECRET=...
```

**Important:** Get VPS IP address:
```bash
curl ifconfig.me
```

## Step 3: Install Dependencies and Build

```bash
cd /opt/tradooor

# Install dependencies
pnpm install

# Build backend
pnpm --filter backend build
```

## Step 4: PM2 Setup

```bash
cd /opt/tradooor

# Start backend as service
pm2 start "pnpm --filter backend start" --name tradooor-backend

# Start normalized trade ingestion worker
pm2 start "pnpm --filter backend worker:normalized-trades" --name tradooor-trade-worker

# Save PM2 configuration
pm2 save

# Set automatic start after VPS restart
pm2 startup
# Copy and run the command that PM2 outputs
```

## Step 5: Firewall Setup

```bash
# Open port 3001
ufw allow 3001/tcp
ufw enable
```

## Step 6: Create Webhook

```bash
# Check that backend is running
pm2 status
pm2 logs tradooor-backend

# Create webhook for all wallets
curl -X POST http://localhost:3001/api/smart-wallets/setup-webhook
```

## Step 7: Verification

```bash
# Check status
pm2 status

# Check logs
pm2 logs tradooor-backend

# Check that API works
curl http://localhost:3001/health
```

## Workflow for Updates

### On Local Computer (MacBook):

```bash
cd ~/Desktop/Coding/Bots/tradooor

# Make code changes...

# Commit and push
git add .
git commit -m "Description of changes"
git push origin master
```

### On VPS:

```bash
ssh root@157.180.41.49
# or
ssh vps

cd /opt/tradooor

# Pull latest changes
git pull origin master

# Install new dependencies (if any were added)
pnpm install

# Build (if backend changed)
pnpm --filter backend build

# Restart backend
pm2 restart tradooor-backend
pm2 restart tradooor-trade-worker

# Check logs
pm2 logs tradooor-backend --lines 50
```

## Useful PM2 Commands

```bash
# Status of all processes
pm2 status

# Logs
pm2 logs tradooor-backend

# Restart
pm2 restart tradooor-backend

# Stop
pm2 stop tradooor-backend

# Start
pm2 start tradooor-backend

# Delete from PM2
pm2 delete tradooor-backend

# Monitor (real-time)
pm2 monit
```

## Troubleshooting

### Backend is not running

```bash
# Check logs
pm2 logs tradooor-backend

# Check if port is not occupied
lsof -i :3001

# Check environment variables
cd /opt/tradooor/apps/backend
cat .env
```

### Webhook is not working

1. Check that backend is running: `pm2 status`
2. Check webhook URL in `.env`: `HELIUS_WEBHOOK_URL`
3. Check that port 3001 is open: `ufw status`
4. Check Helius dashboard: https://dashboard.helius.dev/

### Port is occupied

```bash
# Find process on port 3001
lsof -i :3001

# Stop process
kill -9 PID
```

## DNS Setup (optional - if you have a domain)

If you have domain stepanpanek.cz and want to use subdomain:

1. **DNS record:**
   - Subdomain: `api` (or `bot`, `tradooor`)
   - Type: A
   - IP: `157.180.41.49`
   - TTL: 3600

2. **Nginx + HTTPS:**
   - See "Nginx + HTTPS Setup" section in main guide

3. **Update `.env`:**
   ```env
   HELIUS_WEBHOOK_URL=https://api.stepanpanek.cz/api/webhooks/helius
   ```

4. **Restart backend:**
   ```bash
   pm2 restart tradooor-backend
   ```

5. **Update webhook:**
   ```bash
   curl -X POST http://localhost:3001/api/smart-wallets/setup-webhook
   ```
