# Security Setup - Password Protection & Search Engine Blocking

## 1. Frontend Protection (Already Done)

✅ **robots.txt** - Created at `apps/frontend/src/app/robots.ts`
✅ **Meta tags** - Added `noindex, nofollow` to layout.tsx
✅ **X-Robots-Tag header** - Added to next.config.js

## 2. Nginx Basic Auth (Run on VPS)

### Step 1: Install apache2-utils (if not already installed)

```bash
sudo apt-get update
sudo apt-get install apache2-utils
```

### Step 2: Create password file

```bash
# Create .htpasswd file (replace 'username' with your desired username)
sudo htpasswd -c /etc/nginx/.htpasswd username
```

You'll be prompted to enter a password. **Remember this password!**

**Note:** If you want to add more users later, use `-c` flag only for the first user. For additional users, omit `-c`:
```bash
sudo htpasswd /etc/nginx/.htpasswd another_username
```

### Step 3: Update Nginx configuration

Edit your Nginx config file:
```bash
sudo nano /etc/nginx/sites-available/tradooor
```

Add the following **inside** the `server` block (before the `location /` block):

```nginx
# Basic Auth for all routes
auth_basic "Restricted Access";
auth_basic_user_file /etc/nginx/.htpasswd;
```

**Full example** (your config should look like this):

```nginx
server {
    server_name tradooor.stepanpanek.cz;

    listen 80;
    listen [::]:80;

    # Basic Auth for all routes
    auth_basic "Restricted Access";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_cache_bypass $http_upgrade;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location /api/webhooks/helius {
        proxy_pass http://localhost:3001;
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
}
```

**Important:** If you want to exclude the webhook endpoint from Basic Auth (so Helius can access it), add this **before** the `location /api/webhooks/helius` block:

```nginx
location /api/webhooks/helius {
    # No auth for webhooks (Helius needs access)
    proxy_pass http://localhost:3001;
    # ... rest of webhook config
}
```

And add auth only to specific locations:

```nginx
location / {
    auth_basic "Restricted Access";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://localhost:3000;
    # ... rest of config
}

location /api/ {
    auth_basic "Restricted Access";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://localhost:3001;
    # ... rest of config
}
```

### Step 4: Test Nginx configuration

```bash
sudo nginx -t
```

If the test passes, reload Nginx:

```bash
sudo systemctl reload nginx
```

### Step 5: Verify

1. Open your browser in incognito/private mode
2. Visit `https://tradooor.stepanpanek.cz`
3. You should see a login prompt
4. Enter your username and password
5. You should now have access to the site

## 3. Additional Security (Optional)

### Restrict access by IP (only allow your IP)

Add this to your Nginx config (replace `YOUR_IP_ADDRESS` with your actual IP):

```nginx
location / {
    allow YOUR_IP_ADDRESS;
    deny all;
    
    auth_basic "Restricted Access";
    auth_basic_user_file /etc/nginx/.htpasswd;
    
    proxy_pass http://localhost:3000;
    # ... rest of config
}
```

**Note:** This will block all access except from your IP. If your IP changes, you'll need to update the config.

### Check your current IP:

```bash
curl ifconfig.me
```

## Troubleshooting

### Password prompt not showing

1. Check that `.htpasswd` file exists: `ls -la /etc/nginx/.htpasswd`
2. Check file permissions: `sudo chmod 644 /etc/nginx/.htpasswd`
3. Check Nginx error logs: `sudo tail -f /var/log/nginx/error.log`
4. Verify Nginx config: `sudo nginx -t`

### Can't access after setting up auth

1. Make sure you're using the correct username/password
2. Check Nginx error logs: `sudo tail -f /var/log/nginx/error.log`
3. Try accessing from incognito mode to avoid cached credentials

### Webhook not working

If Helius webhooks stop working after adding Basic Auth, you need to exclude the webhook endpoint from authentication (see Step 3 above).

