#!/bin/bash

# VPS Quick Start Script
# Tento script provede kompletní reset a restart aplikace

set -e  # Zastav při chybě

echo "🚀 Tradooor VPS Quick Start"
echo "=========================="
echo ""

# Barvy pro výstup
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Funkce pro výpis
info() {
    echo -e "${GREEN}ℹ️  $1${NC}"
}

warn() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

error() {
    echo -e "${RED}❌ $1${NC}"
}

# 1. Zkontroluj, že jsme v root projektu
if [ ! -f "package.json" ]; then
    error "Nejsi v root adresáři projektu!"
    exit 1
fi

info "Krok 1/6: Zastavování běžících procesů..."

# Zastav PM2 procesy (pokud běží)
if command -v pm2 &> /dev/null; then
    if pm2 list | grep -q "tradooor"; then
        info "Zastavuji PM2 procesy..."
        pm2 stop all || true
        pm2 delete all || true
    fi
fi

# Zastav systemd služby (pokud běží)
if systemctl is-active --quiet tradooor-backend 2>/dev/null; then
    info "Zastavuji systemd služby..."
    sudo systemctl stop tradooor-backend tradooor-frontend || true
    sudo systemctl stop tradooor-metrics-cron.timer tradooor-missing-trades-cron.timer || true
fi

# Zastav node procesy (fallback)
if pgrep -f "tradooor" > /dev/null; then
    warn "Nalezeny běžící node procesy, zastavuji..."
    pkill -f "tradooor" || true
    sleep 2
fi

info "✅ Všechny procesy zastaveny"
echo ""

# 2. Reset dat
info "Krok 2/6: Resetování databáze..."

cd apps/backend

if [ ! -f ".env" ]; then
    error ".env soubor neexistuje v apps/backend!"
    exit 1
fi

info "Spouštím trades:delete-all..."
pnpm trades:delete-all

info "✅ Data resetována"
echo ""

# 3. Zpět do root
cd ../..

# 4. Vytvoř logy adresář
info "Krok 3/6: Vytváření logů adresáře..."
mkdir -p logs
info "✅ Logs adresář připraven"
echo ""

# 5. Zkontroluj konfiguraci
info "Krok 4/6: Kontrola konfigurace..."

if [ ! -f "apps/backend/.env" ]; then
    error "apps/backend/.env neexistuje!"
    exit 1
fi

# Zkontroluj QUICKNODE_RPC_URL nebo SOLANA_RPC_URL
if ! grep -q "QUICKNODE_RPC_URL\|SOLANA_RPC_URL" apps/backend/.env; then
    warn "QUICKNODE_RPC_URL nebo SOLANA_RPC_URL není nastaveno v .env!"
    warn "Cron job pro missing trades nemusí fungovat."
fi

info "✅ Konfigurace zkontrolována"
echo ""

# 6. Spusť služby
info "Krok 5/6: Spouštění služeb..."

# Zkontroluj, jestli je PM2 nainstalováno
if command -v pm2 &> /dev/null; then
    info "Používám PM2 pro správu procesů..."
    
    if [ ! -f "ecosystem.config.js" ]; then
        warn "ecosystem.config.js neexistuje, vytvářím..."
        # Můžeš vytvořit ručně nebo použít existující
    fi
    
    info "Spouštím PM2 procesy..."
    pm2 start ecosystem.config.js || {
        error "PM2 start selhal!"
        exit 1
    }
    
    info "Ukládám PM2 konfiguraci..."
    pm2 save || true
    
    info "✅ PM2 procesy spuštěny"
    echo ""
    info "Zobrazit status: pm2 status"
    info "Zobrazit logy: pm2 logs"
    
elif systemctl list-unit-files | grep -q "tradooor"; then
    info "Používám systemd pro správu procesů..."
    
    sudo systemctl daemon-reload
    sudo systemctl start tradooor-backend tradooor-frontend
    sudo systemctl start tradooor-metrics-cron.timer tradooor-missing-trades-cron.timer
    
    info "✅ Systemd služby spuštěny"
    echo ""
    info "Zobrazit status: sudo systemctl status tradooor-backend"
    
else
    warn "PM2 ani systemd služby nejsou nastaveny!"
    warn "Spouštím procesy přímo (nedoporučeno pro produkci)..."
    
    info "Spouštím backend..."
    cd apps/backend
    pnpm start &
    BACKEND_PID=$!
    cd ../..
    
    info "Spouštím frontend..."
    cd apps/frontend
    pnpm start &
    FRONTEND_PID=$!
    cd ../..
    
    info "✅ Procesy spuštěny (PID: backend=$BACKEND_PID, frontend=$FRONTEND_PID)"
    warn "⚠️  Procesy běží na pozadí. Pro produkci použij PM2 nebo systemd!"
fi

echo ""

# 7. Verifikace
info "Krok 6/6: Verifikace..."

sleep 5  # Počkej, až se služby spustí

# Zkontroluj backend
if curl -s http://localhost:3001/api/smart-wallets > /dev/null; then
    info "✅ Backend běží na http://localhost:3001"
else
    warn "⚠️  Backend neodpovídá na http://localhost:3001"
fi

# Zkontroluj frontend
if curl -s http://localhost:3000 > /dev/null; then
    info "✅ Frontend běží na http://localhost:3000"
else
    warn "⚠️  Frontend neodpovídá na http://localhost:3000"
fi

echo ""
info "🎉 Hotovo!"
echo ""
info "Užitečné příkazy:"
echo "  - PM2 status: pm2 status"
echo "  - PM2 logy: pm2 logs"
echo "  - Restart: pm2 restart all"
echo "  - Systemd status: sudo systemctl status tradooor-backend"
echo "  - Systemd logy: sudo journalctl -u tradooor-backend -f"
echo ""
info "Cron joby běží každou hodinu:"
echo "  - Metrics cron: přepočet metrik"
echo "  - Missing trades cron: kontrola chybějících trades přes RPC"
echo ""
