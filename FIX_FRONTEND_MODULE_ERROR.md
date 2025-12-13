# Fix Frontend MODULE_NOT_FOUND Error

## Problém
Next.js nemůže najít modul - `MODULE_NOT_FOUND` error. To znamená, že:
- Build není kompletní nebo je poškozený
- Závislosti nejsou správně nainstalované
- `.next` složka obsahuje neplatné reference

## Řešení

### 1. Zastav frontend
```bash
pm2 stop tradooor-frontend
```

### 2. Smaž všechny build artefakty
```bash
cd /opt/tradooor/apps/frontend
rm -rf .next
rm -rf node_modules
rm -rf .pnpm-store  # Pokud existuje
```

### 3. Smaž root node_modules a reinstaluj vše
```bash
cd /opt/tradooor
rm -rf node_modules
rm -rf apps/frontend/node_modules
rm -rf apps/backend/node_modules
pnpm install
```

### 4. Znovu sestav frontend
```bash
cd /opt/tradooor/apps/frontend
pnpm build
```

### 5. Zkontroluj, že build proběhl úspěšně
```bash
ls -la apps/frontend/.next
# Měly by tam být složky: static, server, cache, atd.
```

### 6. Zkontroluj, jestli nejsou chyby v buildu
```bash
cd apps/frontend
pnpm build 2>&1 | tail -50
```

### 7. Restart frontendu
```bash
pm2 restart tradooor-frontend
```

### 8. Zkontroluj logy
```bash
pm2 logs tradooor-frontend --lines 30
```

## Pokud problém přetrvá

### Zkontroluj Next.js verzi
```bash
cd apps/frontend
cat package.json | grep next
```

### Zkontroluj Node.js verzi
```bash
node --version  # Mělo by být >= 18.0.0
```

### Zkontroluj pnpm verzi
```bash
pnpm --version
```

### Zkontroluj, jestli jsou všechny workspace závislosti správně
```bash
cd /opt/tradooor
pnpm install --frozen-lockfile
```

## Rychlý fix script

```bash
#!/bin/bash
set -e

echo "🛑 Stopping frontend..."
pm2 stop tradooor-frontend

echo "🧹 Cleaning everything..."
cd /opt/tradooor/apps/frontend
rm -rf .next node_modules

cd /opt/tradooor
rm -rf node_modules apps/*/node_modules

echo "📦 Reinstalling dependencies..."
pnpm install

echo "🏗️  Building frontend..."
cd apps/frontend
pnpm build

echo "✅ Starting frontend..."
pm2 restart tradooor-frontend

echo "📊 Status:"
pm2 status
pm2 logs tradooor-frontend --lines 20
```

Ulož jako `fix-frontend-module.sh`, pak:
```bash
chmod +x fix-frontend-module.sh
./fix-frontend-module.sh
```
