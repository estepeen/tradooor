#!/bin/bash

# Prvotní setup skript pro VPS
# Použití: ./vps-setup.sh
# POZOR: Tento skript musíš spustit na VPS, ne lokálně!

set -e

# Barvy pro výstup
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Tradooor VPS Setup${NC}"
echo ""

# Zkontroluj, že běžíme jako root nebo s sudo
if [ "$EUID" -ne 0 ]; then 
    echo -e "${YELLOW}⚠️  Running as non-root user. Some commands may require sudo.${NC}"
fi

# 1. Aktualizace systému
echo -e "${YELLOW}📦 Updating system packages...${NC}"
apt update && apt upgrade -y

# 2. Instalace Node.js pomocí nvm
echo -e "${YELLOW}📦 Installing Node.js via nvm...${NC}"
if ! command -v nvm &> /dev/null; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
else
    echo -e "${GREEN}✅ nvm already installed${NC}"
fi

# Načti nvm do aktuálního shellu
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Instalace Node.js 20
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
    nvm install 20
    nvm use 20
    nvm alias default 20
else
    echo -e "${GREEN}✅ Node.js already installed${NC}"
fi

# 3. Instalace pnpm
echo -e "${YELLOW}📦 Installing pnpm...${NC}"
if ! command -v pnpm &> /dev/null; then
    npm install -g pnpm
else
    echo -e "${GREEN}✅ pnpm already installed${NC}"
fi

# 4. Instalace PM2
echo -e "${YELLOW}📦 Installing PM2...${NC}"
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2
else
    echo -e "${GREEN}✅ PM2 already installed${NC}"
fi

# 5. Vytvoření složky
echo -e "${YELLOW}📁 Creating /opt/tradooor directory...${NC}"
mkdir -p /opt/tradooor
cd /opt/tradooor

# 6. Klonování repo (pokud ještě neexistuje)
if [ ! -d ".git" ]; then
    echo -e "${YELLOW}📥 Cloning repository...${NC}"
    git clone https://github.com/estepeen/tradooor.git .
else
    echo -e "${GREEN}✅ Repository already exists, pulling latest changes...${NC}"
    git pull origin master
fi

# 7. Instalace závislostí
echo -e "${YELLOW}📦 Installing dependencies...${NC}"
pnpm install

# 8. Build backendu
echo -e "${YELLOW}🔨 Building backend...${NC}"
pnpm --filter backend build

# 9. Nastavení firewallu
echo -e "${YELLOW}🔥 Configuring firewall...${NC}"
if command -v ufw &> /dev/null; then
    ufw allow 3001/tcp
    ufw --force enable
    echo -e "${GREEN}✅ Firewall configured${NC}"
else
    echo -e "${YELLOW}⚠️  ufw not installed, skipping firewall setup${NC}"
fi

# 10. Získání IP adresy
IP=$(curl -s ifconfig.me || curl -s ipinfo.io/ip)
echo ""
echo -e "${GREEN}✅ Setup completed!${NC}"
echo ""
echo -e "${BLUE}📋 Next steps:${NC}"
echo ""
echo "1. Create .env file:"
echo "   cd /opt/tradooor/apps/backend"
echo "   nano .env"
echo ""
echo "2. Add these variables to .env:"
echo "   DATABASE_URL=your_supabase_url"
echo "   DIRECT_URL=your_supabase_direct_url"
echo "   HELIUS_API_KEY=your_helius_api_key"
echo "   HELIUS_WEBHOOK_URL=http://${IP}:3001/api/webhooks/helius"
echo "   PORT=3001"
echo "   NODE_ENV=production"
echo ""
echo "3. Start backend with PM2:"
echo "   cd /opt/tradooor"
echo "   pm2 start \"pnpm --filter backend start\" --name tradooor-backend"
echo "   pm2 save"
echo "   pm2 startup"
echo ""
echo "4. Setup webhook:"
echo "   curl -X POST http://localhost:3001/api/smart-wallets/setup-webhook"
echo ""
echo -e "${BLUE}Your VPS IP: ${IP}${NC}"
echo ""

