# Deploy Logo and Favicon to VPS

## Krok 1: Nahrání souborů na VPS

### Metoda A: Přes git (doporučeno)

```bash
# Na lokálním počítači - commitni soubory do gitu
cd /Users/stepanpanek/Desktop/Coding/Bots/tradooor
git add apps/frontend/public/logo.svg apps/frontend/public/favicon.png
git commit -m "Add logo and favicon files"
git push origin master

# Na VPS - pullni změny
ssh root@tradooor.stepanpanek.cz
cd /opt/tradooor
git pull origin master
```

### Metoda B: Přes SCP (pokud soubory nejsou v gitu)

```bash
# Z lokálního počítače
scp apps/frontend/public/logo.svg root@tradooor.stepanpanek.cz:/opt/tradooor/apps/frontend/public/
scp apps/frontend/public/favicon.png root@tradooor.stepanpanek.cz:/opt/tradooor/apps/frontend/public/
```

## Krok 2: Rebuild frontendu na VPS

```bash
# Připoj se na VPS
ssh root@tradooor.stepanpanek.cz

# Přejdi do projektu
cd /opt/tradooor

# Rebuildni frontend
cd apps/frontend
pnpm build

# Restartuj frontend přes PM2
pm2 restart tradooor-frontend

# Zkontroluj logy
pm2 logs tradooor-frontend --lines 20
```

## Krok 3: Ověření

1. Otevři `https://tradooor.stepanpanek.cz` v prohlížeči
2. Logo by se mělo zobrazit v navigaci (místo textu "Tradooor")
3. Favicon by se měl zobrazit v browser tabu

## Pokud se soubory stále nezobrazují

### Zkontroluj, jestli soubory existují na VPS:

```bash
# Na VPS
ls -la /opt/tradooor/apps/frontend/public/

# Měly by být:
# - logo.svg
# - favicon.png
```

### Zkontroluj, jestli Next.js build obsahuje soubory:

```bash
# Na VPS
ls -la /opt/tradooor/apps/frontend/.next/static/

# Nebo zkontroluj, jestli jsou soubory v build outputu
find /opt/tradooor/apps/frontend/.next -name "logo.svg" -o -name "favicon.png"
```

### Zkontroluj Nginx konfiguraci (měla by servovat static files):

```bash
# Na VPS
sudo cat /etc/nginx/sites-available/tradooor | grep -A 5 "location /"

# Mělo by být něco jako:
# location / {
#     proxy_pass http://localhost:3000;
#     ...
# }
```

### Zkontroluj, jestli Next.js správně servuje static files:

```bash
# Na VPS - zkontroluj Next.js logy
pm2 logs tradooor-frontend | grep -i "static\|public"

# Nebo zkus přímo přistoupit k souboru
curl http://localhost:3000/logo.svg
curl http://localhost:3000/favicon.png
```

## Rychlý fix (pokud nic z výše nefunguje)

```bash
# Na VPS
cd /opt/tradooor

# Pullni nejnovější změny
git pull origin master

# Zkontroluj, jestli soubory existují
ls -la apps/frontend/public/

# Pokud ne, vytvoř složku a nahraj soubory ručně
mkdir -p apps/frontend/public

# Pak použij SCP z lokálního počítače (viz Metoda B výše)

# Rebuildni frontend
cd apps/frontend
rm -rf .next  # Smaž starý build
pnpm build

# Restartuj frontend
pm2 restart tradooor-frontend
pm2 save
```

