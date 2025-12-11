# Jak restartovat Backend a Frontend

## Restart obou současně

```bash
# Zastavit běžící procesy (Ctrl+C v terminálu kde běží)
# Pak spustit znovu:
pnpm dev
```

## Restart pouze Backendu

```bash
# Zastavit backend proces (Ctrl+C)
# Pak spustit znovu:
pnpm dev:backend
```

## Restart pouze Frontendu

```bash
# Zastavit frontend proces (Ctrl+C)
# Pak spustit znovu:
pnpm dev:frontend
```

## Pokud procesy neběží správně

### Najít a zabít procesy na portu:

**Backend (obvykle port 3001 nebo 5000):**
```bash
# macOS/Linux:
lsof -ti:3001 | xargs kill -9
# nebo
lsof -ti:5000 | xargs kill -9

# Windows:
netstat -ano | findstr :3001
taskkill /PID <PID> /F
```

**Frontend (obvykle port 3000):**
```bash
# macOS/Linux:
lsof -ti:3000 | xargs kill -9

# Windows:
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

## Kompletní restart (včetně databáze)

```bash
# 1. Zastavit všechny procesy
# 2. Restartovat databázi (pokud používáte lokální Supabase)
# 3. Spustit znovu:
pnpm dev
```

## Kontrola, jestli procesy běží

```bash
# Zkontrolovat běžící Node procesy:
ps aux | grep node

# Zkontrolovat porty:
lsof -i :3000  # Frontend
lsof -i :3001  # Backend (nebo jiný port)
```
