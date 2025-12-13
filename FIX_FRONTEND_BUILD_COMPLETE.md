# Fix Frontend Build - Complete Solution

## Problém
Next.js hledá soubory v `pages/` složce, ale používáme App Router (`app/`). To znamená, že build není kompletní nebo je poškozený.

## Kompletní řešení

### 1. Zastav frontend
```bash
pm2 stop tradooor-frontend
```

### 2. Smaž VŠECHNO včetně .next
```bash
cd /opt/tradooor/apps/frontend
rm -rf .next
rm -rf node_modules
rm -rf .pnpm-store
```

### 3. Smaž root node_modules
```bash
cd /opt/tradooor
rm -rf node_modules
rm -rf apps/*/node_modules
```

### 4. Reinstaluj všechny závislosti
```bash
cd /opt/tradooor
pnpm install --force
```

### 5. Zkontroluj, že nejsou žádné chyby
```bash
cd apps/frontend
pnpm build 2>&1 | tee /tmp/frontend-build.log
```

### 6. Zkontroluj, že build proběhl úspěšně
```bash
# Měly by tam být tyto složky:
ls -la .next/
# Mělo by tam být: server, static, cache

# Zkontroluj, že existuje app router struktura:
ls -la .next/server/app/
```

### 7. Pokud build selže, zkontroluj logy
```bash
cat /tmp/frontend-build.log | tail -50
```

### 8. Restart frontendu
```bash
pm2 restart tradooor-frontend
```

### 9. Zkontroluj logy
```bash
pm2 logs tradooor-frontend --lines 30
```

## Pokud build stále selže

### Zkontroluj Next.js konfiguraci
```bash
cd /opt/tradooor/apps/frontend
cat next.config.js
```

### Zkontroluj, jestli existuje app složka
```bash
ls -la src/app/
```

### Zkontroluj package.json
```bash
cat package.json | grep -A 5 scripts
```

### Zkontroluj Node.js verzi
```bash
node --version  # Mělo by být >= 18.0.0
```

### Zkontroluj pnpm verzi
```bash
pnpm --version
```

## Rychlý fix script

```bash
#!/bin/bash
set -e

echo "🛑 Stopping frontend..."
pm2 stop tradooor-frontend

echo "🧹 Cleaning everything..."
cd /opt/tradooor/apps/frontend
rm -rf .next node_modules .pnpm-store

cd /opt/tradooor
rm -rf node_modules apps/*/node_modules

echo "📦 Reinstalling dependencies..."
pnpm install --force

echo "🏗️  Building frontend..."
cd apps/frontend
pnpm build 2>&1 | tee /tmp/frontend-build.log

echo "✅ Checking build..."
if [ -d ".next/server/app" ]; then
    echo "✅ Build successful - app router structure exists"
    ls -la .next/server/app/ | head -10
else
    echo "❌ Build failed - app router structure missing"
    echo "Last 50 lines of build log:"
    tail -50 /tmp/frontend-build.log
    exit 1
fi

echo "✅ Starting frontend..."
pm2 restart tradooor-frontend

echo "📊 Status:"
pm2 status
echo ""
echo "📋 Logs:"
pm2 logs tradooor-frontend --lines 20 --nostream
```

Ulož jako `fix-frontend-complete.sh`, pak:
```bash
chmod +x fix-frontend-complete.sh
./fix-frontend-complete.sh
```
