#!/bin/bash

# Deployment script pro VPS
# Použití: ./deploy.sh

set -e

echo "🚀 Starting deployment..."

# Barvy pro výstup
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Zkontroluj, že jsme na VPS
if [ ! -d "/opt/tradooor" ]; then
    echo -e "${RED}❌ Error: /opt/tradooor directory not found${NC}"
    echo "Please run initial setup first (see VPS_DEPLOYMENT.md)"
    exit 1
fi

cd /opt/tradooor

echo -e "${YELLOW}📥 Pulling latest changes from Git...${NC}"
git pull origin master

echo -e "${YELLOW}📦 Installing dependencies...${NC}"
pnpm install

echo -e "${YELLOW}🔨 Building backend...${NC}"
pnpm --filter backend build

echo -e "${YELLOW}🔄 Restarting backend...${NC}"
pm2 restart tradooor-backend || pm2 start "pnpm --filter backend start" --name tradooor-backend

echo -e "${GREEN}✅ Deployment completed!${NC}"
echo ""
echo "Check status:"
echo "  pm2 status"
echo ""
echo "Check logs:"
echo "  pm2 logs tradooor-backend"
echo ""

