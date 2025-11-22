# Oprava: PM2 duplicitní procesy a port konflikt

## Problém
PM2 má dva procesy (id 11 a 12), oba se snaží použít port 3001, což způsobuje `EADDRINUSE` chybu.

## Řešení

### 1. Zastav všechny PM2 procesy pro tradooor-backend
```bash
pm2 stop tradooor-backend
pm2 delete tradooor-backend
```

### 2. Zkontroluj, jestli port 3001 není obsazený jiným procesem
```bash
lsof -i :3001
# Pokud najdeš proces, zabij ho:
kill -9 <PID>
```

### 3. Spusť backend znovu (jeden proces)
```bash
cd /opt/tradooor
pm2 start "pnpm --filter backend start" --name tradooor-backend
pm2 save
```

### 4. Zkontroluj status
```bash
pm2 status
# Měl by být jen jeden proces tradooor-backend
```

## Pokud se problém opakuje

### Automatický restart při chybě
PM2 může automaticky restartovat proces při chybě, což může způsobit duplicity. Zkontroluj:

```bash
pm2 describe tradooor-backend
```

Pokud vidíš `restart: 383` nebo vysoké číslo, proces se neustále restartuje.

### Řešení: Zkontroluj logy a oprav chyby
```bash
pm2 logs tradooor-backend --lines 100
```

Hlavní chyba byla: `this.tokenRepo.create is not a function` - to jsem opravil v kódu.

### Po opravě kódu
```bash
# 1. Pullni nejnovější změny
cd /opt/tradooor
git pull origin master

# 2. Zastav všechny procesy
pm2 stop tradooor-backend
pm2 delete tradooor-backend

# 3. Spusť znovu
pm2 start "pnpm --filter backend start" --name tradooor-backend
pm2 save

# 4. Zkontroluj logy
pm2 logs tradooor-backend --lines 50
```

