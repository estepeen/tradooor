# Fix Frontend 500 Errors on VPS

## Problém
Frontend vrací 500 error na všechny statické soubory. To znamená, že buď:
- Frontend build selhal nebo neproběhl
- `.next` složka chybí nebo je poškozená
- Next.js server neběží správně

## Řešení

### 1. Zkontroluj logy frontendu
```bash
pm2 logs tradooor-frontend --lines 50
```

### 2. Zastav frontend
```bash
pm2 stop tradooor-frontend
```

### 3. Smaž starý build
```bash
cd /opt/tradooor/apps/frontend
rm -rf .next
```

### 4. Znovu sestav frontend
```bash
cd /opt/tradooor
pnpm install  # Pokud se změnily závislosti
cd apps/frontend
pnpm build
```

### 5. Zkontroluj, že build proběhl úspěšně
```bash
ls -la apps/frontend/.next
# Měly by tam být složky: static, server, cache, atd.
```

### 6. Restart frontendu
```bash
pm2 restart tradooor-frontend
```

### 7. Zkontroluj status
```bash
pm2 status
pm2 logs tradooor-frontend --lines 20
```

## Pokud build selže

### Zkontroluj chyby v buildu
```bash
cd apps/frontend
pnpm build 2>&1 | tee build.log
```

### Zkontroluj, jestli jsou všechny závislosti nainstalované
```bash
cd /opt/tradooor
pnpm install
```

### Zkontroluj Node.js verzi
```bash
node --version  # Mělo by být >= 18.0.0
```

## Rychlý fix script

```bash
#!/bin/bash
set -e

echo "🛑 Stopping frontend..."
pm2 stop tradooor-frontend

echo "🧹 Cleaning old build..."
cd /opt/tradooor/apps/frontend
rm -rf .next

echo "📦 Installing dependencies..."
cd /opt/tradooor
pnpm install

echo "🏗️  Building frontend..."
cd apps/frontend
pnpm build

echo "✅ Starting frontend..."
pm2 restart tradooor-frontend

echo "📊 Status:"
pm2 status
```

Ulož jako `fix-frontend.sh`, pak:
```bash
chmod +x fix-frontend.sh
./fix-frontend.sh
```
