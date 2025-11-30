#!/bin/bash
# Setup HTTPS with Let's Encrypt for tradooor.stepanpanek.cz

set -e

echo "🔒 Setting up HTTPS with Let's Encrypt..."

# 1. Check if certbot is installed
if ! command -v certbot &> /dev/null; then
    echo "📦 Installing certbot..."
    sudo apt update
    sudo apt install certbot python3-certbot-nginx -y
fi

# 2. Update Nginx config to include HTTPS
echo "📝 Updating Nginx config for HTTPS..."
cd /opt/tradooor

# Create HTTPS-enabled config
cat > /tmp/nginx-tradooor-https.conf << 'EOF'
server {
    listen 80;
    server_name 157.180.41.49 tradooor.stepanpanek.cz;
    
    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name tradooor.stepanpanek.cz;

    # SSL certificates (will be set by certbot)
    ssl_certificate /etc/letsencrypt/live/tradooor.stepanpanek.cz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tradooor.stepanpanek.cz/privkey.pem;
    
    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Logging
    access_log /var/log/nginx/tradooor-access.log;
    error_log /var/log/nginx/tradooor-error.log;

    # API endpointy -> backend (port 3001)
    location /api {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Speciální handling pro webhook endpoint
    location /api/webhooks/helius {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        proxy_connect_timeout 2s;
        proxy_send_timeout 2s;
        proxy_read_timeout 2s;
        
        proxy_buffering off;
        proxy_request_buffering off;
        
        client_max_body_size 10M;
    }

    # Statické soubory Next.js -> frontend (port 3000)
    location /_next {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        proxy_cache_valid 200 1y;
        add_header Cache-Control "public, immutable";
    }

    # Ostatní požadavky -> frontend (port 3000)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

# 3. First, set up temporary HTTP config for certbot
echo "📝 Setting up temporary HTTP config for certbot..."
sudo cp /opt/tradooor/nginx-tradooor.conf /etc/nginx/sites-available/tradooor
sudo ln -sf /etc/nginx/sites-available/tradooor /etc/nginx/sites-enabled/tradooor
sudo nginx -t
sudo systemctl reload nginx

# 4. Get SSL certificate
echo "🔒 Getting SSL certificate from Let's Encrypt..."
echo "   This will ask for your email and agree to terms of service"
sudo certbot --nginx -d tradooor.stepanpanek.cz --non-interactive --agree-tos --email stepanpanek@example.com --redirect

# 5. If certbot failed, try manual setup
if [ ! -f /etc/letsencrypt/live/tradooor.stepanpanek.cz/fullchain.pem ]; then
    echo "⚠️  Certbot auto-config failed, trying manual setup..."
    echo "   You may need to run manually:"
    echo "   sudo certbot certonly --nginx -d tradooor.stepanpanek.cz"
    exit 1
fi

# 6. Update Nginx config with HTTPS
echo "📝 Updating Nginx config with HTTPS settings..."
sudo cp /tmp/nginx-tradooor-https.conf /etc/nginx/sites-available/tradooor
sudo ln -sf /etc/nginx/sites-available/tradooor /etc/nginx/sites-enabled/tradooor

# 7. Test Nginx config
echo "🧪 Testing Nginx configuration..."
sudo nginx -t

# 8. Reload Nginx
echo "🔄 Reloading Nginx..."
sudo systemctl reload nginx

# 9. Check status
echo ""
echo "✅ HTTPS setup complete!"
echo ""
echo "📋 Summary:"
echo "   - HTTP (port 80) redirects to HTTPS"
echo "   - HTTPS (port 443) is configured"
echo "   - SSL certificate from Let's Encrypt"
echo ""
echo "🔍 Test:"
echo "   - https://tradooor.stepanpanek.cz"
echo "   - curl https://tradooor.stepanpanek.cz"
echo ""
echo "🔄 Auto-renewal:"
echo "   Certbot should auto-renew certificates"
echo "   Check: sudo certbot renew --dry-run"

