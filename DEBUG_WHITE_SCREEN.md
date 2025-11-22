# Debug: Bílá obrazovka

## ✅ ŘEŠENÍ PROBLÉMU

**Problém:** Frontend se snaží připojit k VPS API (`http://157.180.41.49/api`), ale pokud běžíš lokálně, měl by se připojit k `http://localhost:3001/api`.

**Rychlé řešení:**

### Varianta 1: Použij lokální backend
```bash
# 1. Spusť backend lokálně
cd apps/backend
pnpm dev

# 2. Změň .env.local na lokální API
cd ../frontend
echo "NEXT_PUBLIC_API_URL=http://localhost:3001/api" > .env.local

# 3. Restartuj frontend (Ctrl+C a znovu pnpm dev)
```

### Varianta 2: Použij VPS backend (pokud běží)
```bash
# Zkontroluj, jestli VPS API funguje
curl http://157.180.41.49/api/smart-wallets?page=1&pageSize=1

# Pokud funguje, .env.local je správně nastavený
# Problém může být v CORS nebo v samotném frontendu
```

## Možné příčiny a řešení

### 1. Frontend neběží
```bash
# Zkontroluj, jestli frontend běží
ps aux | grep "next dev"

# Pokud neběží, spusť:
cd apps/frontend
pnpm dev
```

### 2. Backend neběží (frontend potřebuje API)
```bash
# Zkontroluj, jestli backend běží na portu 3001
lsof -i :3001

# Pokud neběží, spusť:
cd apps/backend
pnpm dev
```

### 3. Chyba v JavaScriptu (zkontroluj konzoli v prohlížeči)
- Otevři Developer Tools (F12)
- Podívej se na Console tab
- Hledej červené chyby

### 4. Chybějící environment variables
```bash
# Vytvoř .env.local v apps/frontend/
cd apps/frontend
echo "NEXT_PUBLIC_API_URL=http://localhost:3001/api" > .env.local
```

### 5. Chyba v build
```bash
# Vymaž cache a znovu buildni
pnpm clear-cache
cd apps/frontend
rm -rf .next
pnpm dev
```

### 6. Chyba v CSS/Tailwind
```bash
# Zkontroluj, jestli jsou CSS soubory správně
cd apps/frontend
ls -la src/app/globals.css
```

### 7. Port konflikt
```bash
# Zkontroluj, jestli port 4444 není obsazený
lsof -i :4444

# Pokud ano, zabij proces nebo změň port v package.json
```

## Rychlé řešení

```bash
# 1. Zastav všechny procesy
pkill -f "next dev"
pkill -f "node.*3001"

# 2. Vymaž cache
pnpm clear-cache

# 3. Zkontroluj environment variables
cd apps/frontend
cat .env.local || echo "NEXT_PUBLIC_API_URL=http://localhost:3001/api" > .env.local

# 4. Spusť backend
cd ../backend
pnpm dev &

# 5. Spusť frontend
cd ../frontend
pnpm dev
```

## Kontrola v prohlížeči

1. Otevři Developer Tools (F12)
2. Podívej se na:
   - **Console** - JavaScript chyby
   - **Network** - Failed requests (404, 500, atd.)
   - **Elements** - Jestli se HTML renderuje

## Časté chyby

### "Failed to fetch"
- Backend neběží nebo není dostupný na `http://localhost:3001`

### "Module not found"
- Chybějící dependencies: `pnpm install`

### "Hydration error"
- Chyba v React komponentě, zkontroluj console

### Bílá obrazovka bez chyb
- Zkontroluj, jestli se renderuje `<body>` element
- Zkontroluj, jestli jsou CSS soubory načtené

