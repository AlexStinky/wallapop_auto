# Wallapop Auto-Publisher — Backend

Node.js/Express + Playwright backend for automated Wallapop product publishing.

---

## Requirements

- Node.js 18+
- npm 9+
- MongoDB 6+ (local service, Docker, or MongoDB Atlas cluster)
- (VPS) Debian/Ubuntu recommended for Playwright

---

## Local Setup

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright browsers (Chromium only)
npx playwright install chromium
npx playwright install-deps chromium   # Linux only

# 3. Generate Prisma client for MongoDB
npx prisma generate

# 4. Start dev server with hot-reload
npm run dev
```

---

## Environment Variables (`.env`)

| Variable       | Default                                | Description                          |
|----------------|----------------------------------------|--------------------------------------|
| `PORT`         | `3001`                                 | Express server port                  |
| `DATABASE_URL` | `mongodb://localhost:27017/wallapop`   | MongoDB connection string (or Atlas) |
| `FRONTEND_URL` | `http://localhost:3000`                | Allowed CORS origin                  |
| `UPLOAD_DIR`   | `./uploads`                            | Directory to store uploaded images   |

---

## Production (VPS) Setup

### 1. System dependencies

```bash
# Install Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Playwright system deps
sudo apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libasound2

# Or let Playwright install them automatically
npx playwright install-deps chromium
```

### 2. Install & Build

```bash
git clone <your-repo>
cd wallapop/backend

# Install production deps
npm install

# Install Playwright Chromium
npx playwright install chromium

# Build TypeScript
npm run build

# Create DB
npx prisma db push --skip-generate
```

### 3. PM2 (Process Manager)

```bash
# Install PM2 globally
npm install -g pm2

# Start the app
pm2 start ecosystem.config.js

# Auto-restart on reboot
pm2 startup
pm2 save

# Useful commands
pm2 logs wallapop-backend
pm2 restart wallapop-backend
pm2 stop wallapop-backend
```

### 4. Reverse Proxy (Nginx example)

```nginx
server {
    listen 80;
    server_name api.yourserver.com;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # SSE support — disable buffering for /api/queue/status
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

---

## API Overview

### Products

| Method | Path                       | Description                      |
|--------|----------------------------|----------------------------------|
| GET    | `/api/products`            | List all products (filterable)   |
| POST   | `/api/products`            | Create a product                 |
| GET    | `/api/products/:id`        | Get single product               |
| PUT    | `/api/products/:id`        | Update product                   |
| DELETE | `/api/products/:id`        | Delete product + images          |
| POST   | `/api/products/:id/publish`| Add product to publish queue     |
| POST   | `/api/products/upload`     | Upload images (multipart/form-data) |

### Queue

| Method | Path                 | Description                       |
|--------|----------------------|-----------------------------------|
| GET    | `/api/queue`         | Get queue state                   |
| POST   | `/api/queue/start`   | Start processing the queue        |
| POST   | `/api/queue/stop`    | Stop processing (after current)   |
| DELETE | `/api/queue/clear`   | Clear all pending items           |
| GET    | `/api/queue/status`  | SSE stream for real-time updates  |

### Settings

| Method | Path                        | Description                       |
|--------|-----------------------------|-----------------------------------|
| GET    | `/api/settings`             | Get settings (password masked)    |
| PUT    | `/api/settings`             | Update settings                   |
| POST   | `/api/settings/test-login`  | Test Wallapop login               |

---

## Debug Screenshots

When the browser automation encounters an error, a screenshot is automatically saved to `./debug-screenshots/` for inspection.

---

## Notes

- The queue processes items **sequentially** with a configurable delay (default 30s) between publications.
- A session cookie file (`.session-cookies.json`) is saved after each successful login to avoid repeated logins.
- Set `headless: false` in Settings to watch the browser during debugging.
