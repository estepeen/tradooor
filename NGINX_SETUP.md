# Nginx Reverse Proxy Setup - Tradooor

Návod pro nastavení nginx reverse proxy pro Tradooor backend API.

## Proč nginx?

- Backend naslouchá na `localhost:3001` (bezpečnější)
- Nginx naslouchá na portu 80 (HTTP) nebo 443 (HTTPS) a proxyuje na backend
- Port 80/443 je standardně otevřený ve firewallu
- Nginx může poskytovat SSL certifikát (HTTPS) pro bezpečnější webhooky

## Krok 1: Instalace nginx

```bash
# Na VPS
sudo apt update
sudo apt install nginx -y

# Zkontroluj, jestli nginx běží
sudo systemctl status nginx
```

## Krok 2: Nastavení nginx konfigurace

```bash
# Vytvoř nginx konfiguraci
sudo nano /etc/nginx/sites-available/tradooor
```

Vlož následující konfiguraci:

```nginx
server {
    listen 80;
    server_name 157.180.41.49;  # Nebo tvoje doména, pokud máš

    # Logging
    access_log /var/log/nginx/tradooor-access.log;
    error_log /var/log/nginx/tradooor-error.log;

    # Proxy na backend
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeout pro webhooky (Helius má timeout ~5-10 sekund)
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Speciální handling pro webhook endpoint - rychlejší timeout
    location /api/webhooks/helius {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Rychlejší timeout pro webhooky
        proxy_connect_timeout 5s;
        proxy_send_timeout 5s;
        proxy_read_timeout 5s;
        
        # Odpověz okamžitě
        proxy_buffering off;
    }
}
```

## Krok 3: Aktivace konfigurace

```bash
# Vytvoř symlink
sudo ln -s /etc/nginx/sites-available/tradooor /etc/nginx/sites-enabled/

# Odeber default konfiguraci (pokud existuje)
sudo rm /etc/nginx/sites-enabled/default

# Test nginx konfigurace
sudo nginx -t

# Restart nginx
sudo systemctl restart nginx

# Zkontroluj status
sudo systemctl status nginx
```

## Krok 4: Otevření portu 80 ve firewallu

```bash
# Otevři port 80 (HTTP)
sudo ufw allow 80/tcp
sudo ufw reload

# Zkontroluj status
sudo ufw status
```

## Krok 5: Testování

```bash
# Z VPS zkus testovat
curl http://localhost/api/webhooks/helius/test

# Zvenčí (z jiného počítače nebo online nástroje)
curl http://157.180.41.49/api/webhooks/helius/test
```

## Krok 6: Aktualizace Helius webhook URL

V Helius Dashboard změň webhook URL na:
```
http://157.180.41.49/api/webhooks/helius
```

## Volitelné: SSL certifikát (HTTPS)

Pokud chceš použít HTTPS (doporučeno pro produkci):

```bash
# Nainstaluj certbot
sudo apt install certbot python3-certbot-nginx -y

# Získej SSL certifikát (potřebuješ doménu)
sudo certbot --nginx -d tvoje-domena.com

# Nebo pokud nemáš doménu, použij HTTP (port 80)
```

## Troubleshooting

### Nginx neběží
```bash
sudo systemctl status nginx
sudo journalctl -u nginx -n 50
```

### Port 80 není dostupný
```bash
# Zkontroluj firewall
sudo ufw status

# Zkontroluj, jestli nginx naslouchá
sudo netstat -tuln | grep 80
```

### Backend není dostupný
```bash
# Zkontroluj, jestli backend běží
pm2 list

# Zkontroluj logy
pm2 logs tradooor-backend
```

