# Clear Cache Guide

Tento guide vysvětluje, jak vymazat všechny cache soubory lokálně i na VPS.

## Lokální vymazání cache

### Automaticky (doporučeno)

```bash
# Spusť script
./clear-cache.sh

# Nebo přes pnpm
pnpm clear-cache
```

### Manuálně

```bash
# Frontend cache
rm -rf apps/frontend/.next
rm -rf apps/frontend/out

# Backend cache
rm -rf apps/backend/dist
rm -rf apps/backend/build

# Packages cache
rm -rf packages/db/dist
rm -rf packages/shared/dist

# TypeScript cache
find . -name "*.tsbuildinfo" -type f -delete
```

## Vymazání cache na VPS

### Připojení k VPS

```bash
ssh root@157.180.41.49
# nebo
ssh vps@157.180.41.49
```

### Vymazání cache na VPS

```bash
cd /opt/tradooor

# Zkopíruj script na VPS (pokud ještě není)
# Nebo spusť přímo:

# Frontend cache
rm -rf apps/frontend/.next
rm -rf apps/frontend/out

# Backend cache
rm -rf apps/frontend/.next
rm -rf apps/backend/dist
rm -rf apps/backend/build

# Packages cache
rm -rf packages/db/dist
rm -rf packages/shared/dist

# TypeScript cache
find . -name "*.tsbuildinfo" -type f -delete

# Restart PM2 (pokud běží)
pm2 restart tradooor-backend
```

### Nebo použij script (pokud je na VPS)

```bash
cd /opt/tradooor
bash clear-cache.sh
pm2 restart tradooor-backend
```

## Vymazání browser cache

### Chrome/Edge
- `Ctrl+Shift+Delete` (Windows) nebo `Cmd+Shift+Delete` (Mac)
- Vyber "Cached images and files"
- Nebo hard refresh: `Ctrl+F5` (Windows) nebo `Cmd+Shift+R` (Mac)

### Firefox
- `Ctrl+Shift+Delete` (Windows) nebo `Cmd+Shift+R` (Mac)
- Vyber "Cache"
- Nebo hard refresh: `Ctrl+F5` (Windows) nebo `Cmd+Shift+R` (Mac)

## Co se vymaže

- ✅ Next.js build cache (`.next` folder)
- ✅ Backend build artifacts (`dist`, `build`)
- ✅ TypeScript build info (`*.tsbuildinfo`)
- ✅ Packages build outputs

## Co se NEvymaže

- ❌ `node_modules` (závislosti)
- ❌ `.env` soubory
- ❌ Databáze (Supabase)
- ❌ Git historie

## Po vymazání cache

Po vymazání cache můžeš potřebovat:

1. **Znovu buildnout projekt:**
   ```bash
   pnpm install
   pnpm --filter backend build
   pnpm --filter frontend build
   ```

2. **Restartovat služby:**
   ```bash
   # Lokálně
   pnpm dev
   
   # Na VPS
   pm2 restart tradooor-backend
   ```

