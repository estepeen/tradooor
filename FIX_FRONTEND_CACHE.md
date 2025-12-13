# Fix Frontend - Clear Cache and Restart

## Problém
Build proběhl úspěšně, ale stále se objevuje stará chyba. To znamená, že PM2 nebo Next.js používá cache.

## Řešení

### 1. Zastav frontend úplně
```bash
pm2 stop tradooor-frontend
pm2 delete tradooor-frontend
```

### 2. Smaž Next.js cache
```bash
cd /opt/tradooor/apps/frontend
rm -rf .next/cache
```

### 3. Zkontroluj, že build existuje a je správný
```bash
# Měla by existovat složka .next/server/app/
ls -la .next/server/app/

# Měly by tam být složky pro všechny routes:
ls .next/server/app/
# Mělo by tam být: paper-trading, signals, stats, wallets, atd.
```

### 4. Restart PM2 s čistým stavem
```bash
cd /opt/tradooor
pm2 restart ecosystem.config.js
```

### 5. Nebo přidej frontend znovu
```bash
cd /opt/tradooor
pm2 start ecosystem.config.js --only tradooor-frontend
```

### 6. Zkontroluj logy (měly by být nové, ne staré)
```bash
pm2 logs tradooor-frontend --lines 30
```

### 7. Zkontroluj, jestli frontend skutečně běží
```bash
curl http://localhost:3000
# Nebo
curl http://localhost:3000/signals
```

## Pokud problém přetrvá

### Zkontroluj, jestli není problém s portem
```bash
netstat -tulpn | grep 3000
# Nebo
lsof -i :3000
```

### Zkontroluj PM2 status
```bash
pm2 status
pm2 info tradooor-frontend
```

### Zkontroluj, jestli Next.js skutečně používá nový build
```bash
cd /opt/tradooor/apps/frontend
ls -la .next/server/app/ | head -20
```

### Zkontroluj timestamp buildu
```bash
stat .next/server/app/
# Měl by mít aktuální timestamp (nedávno)
```

## Rychlý fix script

```bash
#!/bin/bash
set -e

echo "🛑 Stopping and deleting frontend..."
pm2 stop tradooor-frontend || true
pm2 delete tradooor-frontend || true

echo "🧹 Cleaning Next.js cache..."
cd /opt/tradooor/apps/frontend
rm -rf .next/cache

echo "✅ Verifying build structure..."
if [ -d ".next/server/app" ]; then
    echo "✅ Build structure exists"
    ls .next/server/app/ | head -10
else
    echo "❌ Build structure missing - need to rebuild"
    exit 1
fi

echo "🔄 Restarting frontend..."
cd /opt/tradooor
pm2 start ecosystem.config.js --only tradooor-frontend

echo "⏳ Waiting 3 seconds..."
sleep 3

echo "📊 Status:"
pm2 status

echo ""
echo "📋 Recent logs:"
pm2 logs tradooor-frontend --lines 20 --nostream
```

Ulož jako `fix-frontend-cache.sh`, pak:
```bash
chmod +x fix-frontend-cache.sh
./fix-frontend-cache.sh
```
