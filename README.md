# 🛒 Wallapop Auto-Publisher

Повноцінна система автоматичної публікації товарів на **Wallapop** через емуляцію браузера (Playwright) без прямого API.

Розроблено спеціально під мобільні пристрої українською мовою.

---

## 📐 Архітектура

```
wallapop/
├── frontend/             # Next.js (App Router, Tailwind CSS) → Деплой на Vercel
│   ├── src/app/          # Сторінки: Dashboard, Товари, Додати товар, Налаштування
│   ├── src/components/   # UI компоненти під мобільний дизайн Wallapop
│   └── src/lib/          # API клієнт, утиліти, типи
│
└── backend/              # Node.js + Express + Playwright + Prisma → Деплой на VPS
    ├── prisma/           # Prisma схема з провайдером MongoDB
    ├── src/routes/       # REST API (товари, черга публікацій, налаштування)
    ├── src/services/     # Playwright автоматизація та черга з контролем затримок
    └── uploads/          # Збереження завантажених фотографій
```

---

## 🗄️ База даних: MongoDB

Система використовує **MongoDB** (через Prisma ORM).

### Моделі (`schema.prisma`):
- `Product`:
  - `id`: ObjectId
  - `title`: назва товару (до 50 символів)
  - `description`: опис (до 640 символів)
  - `price`: ціна в €
  - `category`, `subcategory`, `condition`, `brand`, `color`, `weight`, `quantity`
  - `images`: JSON масив завантажених файлів
  - `status`: `pending` | `in_queue` | `publishing` | `published` | `error`
  - `wallapopId`, `wallapopUrl`, `errorMessage`, `queueOrder`
- `Settings`:
  - `wallapopEmail`, `wallapopPassword` (зашифровано/приховано на клієнті)
  - `publishDelay`: затримка між публікаціями в секундах (за замовчуванням 30с)
  - `headless`: режим браузера (true/false)

---

## 🚀 Швидкий запуск локально

### 1. Бекенд (Node.js + MongoDB)
```bash
cd backend

# Встановіть залежності
npm install

# Встановіть браузер Chromium для Playwright
npx playwright install chromium

# Створіть .env файл або перевірте існуючий:
# PORT=3001
# DATABASE_URL="mongodb://localhost:27017/wallapop"
# FRONTEND_URL=http://localhost:3000

# Згенеруйте Prisma клієнт для MongoDB
npx prisma generate

# Запустіть сервер
npm run dev
```

### 2. Фронтенд (Next.js)
```bash
cd frontend

# Встановіть залежності
npm install

# Перевірте .env.local:
# NEXT_PUBLIC_API_URL=http://localhost:3001

# Запустіть dev-сервер
npm run dev
```
Відкрийте `http://localhost:3000` у мобільному режимі браузера (або зі смартфона).

---

## 🌐 Деплой

### 1. Деплой Фронтенду на Vercel
1. Завантажте папку `frontend` у ваш GitHub-репозиторій.
2. Підключіть репозиторій до [Vercel](https://vercel.com).
3. У налаштуваннях проєкту додайте змінну середовища:
   - `NEXT_PUBLIC_API_URL`: адреса вашого бекенду на VPS (наприклад: `https://api.yourdomain.com`).
4. Натисніть **Deploy**.

### 2. Деплой Бекенду на VPS (Ubuntu / Debian)
1. Встановіть Node.js 20 та MongoDB на VPS:
   ```bash
   # MongoDB
   sudo apt-get install -y gnupg curl
   curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
   echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
   sudo apt-get update
   sudo apt-get install -y mongodb-org
   sudo systemctl start mongod
   sudo systemctl enable mongod
   ```
2. Встановіть залежності Playwright:
   ```bash
   npx playwright install-deps chromium
   ```
3. Скопіюйте папку `backend` на сервер:
   ```bash
   cd backend
   npm install
   npx playwright install chromium
   npx prisma generate
   npm run build
   ```
4. Налаштуйте `.env`:
   ```env
   PORT=3001
   DATABASE_URL="mongodb://127.0.0.1:27017/wallapop"
   FRONTEND_URL="https://your-vercel-domain.vercel.app"
   UPLOAD_DIR="./uploads"
   ```
5. Запустіть через PM2:
   ```bash
   npm install -g pm2
   pm2 start ecosystem.config.js
   pm2 startup
   pm2 save
   ```

---

## 🛡️ Захист від блокування Wallapop
- Емуляція мобільного браузера Safari iPhone (User-Agent, Viewport 390x844, touch-події).
- Маскування `navigator.webdriver` прапорця.
- Збереження cookies сесії (`.session-cookies.json`), щоб не авторизуватись повторно перед кожним постом.
- Рандомізовані «людські» затримки (800ms–2500ms) між кліками та введенням тексту.
- Налаштовувана пауза між різними товарами (за замовчуванням 30-60 секунд).
- Автоматичний скріншот при виникненні помилок (`./debug-screenshots/`).
