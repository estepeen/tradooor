# Fix Frontend - Final Solution

## Problém
Stále se objevují staré chyby z cache. PM2 logy nejsou aktuální.

## Kompletní řešení

### 1. Zastav a smaž frontend z PM2
```bash
pm2 stop tradooor-frontend
pm2 delete tradooor-frontend
```

### 2. Smaž PM2 logy
```bash
rm -f /opt/tradooor/logs/frontend-error.log
rm -f /opt/tradooor/logs/frontend-out.log
```

### 3. Smaž Next.js cache
```bash
cd /opt/tradooor/apps/frontend
rm -rf .next/cache
```

### 4. Zkontroluj, že build existuje a je správný
```bash
# Měla by existovat složka .next/server/app/ (ne pages/)
ls -la .next/server/app/

# Měly by tam být složky pro všechny routes
ls .next/server/app/
# Mělo by tam být: paper-trading, signals, stats, wallets, atd.
```

### 5. Zkontroluj timestamp buildu
```bash
stat .next/server/app/
# Měl by mít aktuální timestamp (nedávno)
```

### 6. Přidej frontend znovu do PM2
```bash
cd /opt/tradooor
pm2 start ecosystem.config.js --only tradooor-frontend
```

### 7. Zkontroluj status
```bash
pm2 status
pm2 info tradooor-frontend
```

### 8. Zkontroluj NOVÉ logy (měly by být prázdné nebo aktuální)
```bash
pm2 logs tradooor-frontend --lines 30
```

### 9. Test frontendu
```bash
curl http://localhost:3000
# Nebo
curl -I http://localhost:3000/signals
```

## Pokud stále vidíš staré chyby

### Zkontroluj, jestli PM2 skutečně restartoval
```bash
pm2 describe tradooor-frontend
# Zkontroluj "restart time" - měl by být aktuální
```

### Zkontroluj, jestli není více procesů
```bash
ps aux | grep next
# Mělo by tam být jen jeden proces
```

### Zkontroluj, jestli frontend skutečně běží
```bash
netstat -tulpn | grep 3000
# Nebo
lsof -i :3000
```

### Zkontroluj PM2 logy přímo
```bash
cat /opt/tradooor/logs/frontend-error.log | tail -5
cat /opt/tradooor/logs/frontend-out.log | tail -5
```

## Rychlý fix script

```bash
#!/bin/bash
set -e

echo "🛑 Stopping and deleting frontend..."
pm2 stop tradooor-frontend || true
pm2 delete tradooor-frontend || true

echo "🧹 Cleaning logs..."
rm -f /opt/tradooor/logs/frontend-error.log
rm -f /opt/tradooor/logs/frontend-out.log

echo "🧹 Cleaning Next.js cache..."
cd /opt/tradooor/apps/frontend
rm -rf .next/cache

echo "✅ Verifying build structure..."
if [ ! -d ".next/server/app" ]; then
    echo "❌ Build structure missing - need to rebuild"
    echo "Running build..."
    pnpm build
fi

echo "✅ Build structure exists"
ls .next/server/app/ | head -10

echo "🔄 Starting frontend..."
cd /opt/tradooor
pm2 start ecosystem.config.js --only tradooor-frontend

echo "⏳ Waiting 5 seconds..."
sleep 5

echo "📊 Status:"
pm2 status

echo ""
echo "📋 Recent logs (should be new/empty):"
pm2 logs tradooor-frontend --lines 20 --nostream

echo ""
echo "🌐 Testing frontend:"
curl -I http://localhost:3000 2>&1 | head -5
```

Ulož jako `fix-frontend-final.sh`, pak:
```bash
chmod +x fix-frontend-final.sh
./fix-frontend-final.sh
```
