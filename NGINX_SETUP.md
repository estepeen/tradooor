# Nginx Reverse Proxy Setup - Tradooor

Guide for setting up nginx reverse proxy for Tradooor backend API.

## Why nginx?

- Backend listens on `localhost:3001` (more secure)
- Nginx listens on port 80 (HTTP) or 443 (HTTPS) and proxies to backend
- Port 80/443 is standardly open in firewall
- Nginx can provide SSL certificate (HTTPS) for more secure webhooks

## Step 1: Install nginx

```bash
# On VPS
sudo apt update
sudo apt install nginx -y

# Check if nginx is running
sudo systemctl status nginx
```

## Step 2: Configure nginx

```bash
# Create nginx configuration
sudo nano /etc/nginx/sites-available/tradooor
```

Insert the following configuration:

```nginx
server {
    listen 80;
    server_name 157.180.41.49;  # Or your domain, if you have one

    # Logging
    access_log /var/log/nginx/tradooor-access.log;
    error_log /var/log/nginx/tradooor-error.log;

    # Proxy to backend
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
        
        # Timeout for webhooks (Helius has timeout ~5-10 seconds)
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Special handling for webhook endpoint - faster timeout
    location /api/webhooks/helius {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Faster timeout for webhooks (Helius has timeout ~2-3 seconds)
        proxy_connect_timeout 2s;
        proxy_send_timeout 2s;
        proxy_read_timeout 2s;
        
        # Respond immediately - no buffering
        proxy_buffering off;
        proxy_request_buffering off;
        
        # Increase limit for large requests
        client_max_body_size 10M;
    }
}
```

## Step 3: Activate configuration

```bash
# Create symlink
sudo ln -s /etc/nginx/sites-available/tradooor /etc/nginx/sites-enabled/

# Remove default configuration (if exists)
sudo rm /etc/nginx/sites-enabled/default

# Test nginx configuration
sudo nginx -t

# Restart nginx
sudo systemctl restart nginx

# Check status
sudo systemctl status nginx
```

## Step 4: Open port 80 in firewall

```bash
# Open port 80 (HTTP)
sudo ufw allow 80/tcp
sudo ufw reload

# Check status
sudo ufw status
```

## Step 5: Testing

```bash
# Test from VPS
curl http://localhost/api/webhooks/helius/test

# From outside (from another computer or online tool)
curl http://157.180.41.49/api/webhooks/helius/test
```

## Step 6: Update Helius webhook URL

In Helius Dashboard, change webhook URL to:
```
http://157.180.41.49/api/webhooks/helius
```

## Optional: SSL certificate (HTTPS)

If you want to use HTTPS (recommended for production):

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx -y

# Get SSL certificate (you need a domain)
sudo certbot --nginx -d your-domain.com

# Or if you don't have a domain, use HTTP (port 80)
```

## Troubleshooting

### Nginx is not running
```bash
sudo systemctl status nginx
sudo journalctl -u nginx -n 50
```

### Port 80 is not available
```bash
# Check firewall
sudo ufw status

# Check if nginx is listening
sudo netstat -tuln | grep 80
```

### Backend is not available
```bash
# Check if backend is running
pm2 list

# Check logs
pm2 logs tradooor-backend
```
