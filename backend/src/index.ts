import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import prisma from './db/prisma';
import productsRouter, { uploadMiddleware, handleUpload } from './routes/products';
import queueRouter from './routes/queue';
import { vintedQueueService } from './services/vinted-queue.service';
import settingsRouter from './routes/settings';
import { createError, errorHandler, notFound } from './middleware/error';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');

// ─── Create uploads directory ─────────────────────────────────────────────────
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
console.log('[Server] Uploads directory:', UPLOAD_DIR);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  cors<express.Request>((req, callback) => {
    const origin = req.get('origin');
    const host = origin && URL.canParse(origin) ? new URL(origin).host : undefined;
    const sameHost = host && (host === req.get('host') || host === req.get('x-forwarded-host'));
    if (origin && origin !== FRONTEND_URL && !sameHost) {
      return callback(createError('Origin is not allowed', 403));
    }
    callback(null, {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });
  })
);

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Static file serving for uploaded images
const photos = express.static(UPLOAD_DIR, {
  index: false,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  },
});
app.use('/uploads', photos);
app.use(photos);

// ─── Routes ───────────────────────────────────────────────────────────────────

// Direct upload endpoints
app.post('/upload', uploadMiddleware, handleUpload);
app.post('/api/upload', uploadMiddleware, handleUpload);

// Support both /api/* and root /* endpoints
app.use('/api/products', productsRouter);
app.use('/products', productsRouter);

app.use('/api/queue', queueRouter);
app.use('/queue', queueRouter);

app.use('/api/settings', settingsRouter);
app.use('/settings', settingsRouter);

// Health check
app.get(['/health', '/api/health'], (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use(notFound);

// Global error handler (must be last)
app.use(errorHandler);

// ─── DB Initialisation ────────────────────────────────────────────────────────

async function initDb(): Promise<void> {
  try {
    // Verify DB connection
    await prisma.$connect();
    console.log('[Server] MongoDB connection OK');

    // Ensure default Settings document exists
    const settings = await prisma.settings.findFirst();
    if (!settings) {
      await prisma.settings.create({
        data: {
          wallapopEmail: '',
          wallapopPassword: '',
          vintedEmail: '',
          vintedPassword: '',
          publishDelay: 30,
          headless: true,
        },
      });
      console.log('[Server] Default settings created');
    }
  } catch (err) {
    console.error('[Server] Database initialisation failed:', err);
    console.error('[Server] Make sure MongoDB is running and DATABASE_URL is valid');
    process.exit(1);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await initDb();
  await vintedQueueService.loadPendingFromDb();

  const host = process.env.HOST || '0.0.0.0';
  app.listen(PORT, host, () => {
    console.log(`[Server] Wallapop backend running on http://${host}:${PORT}`);
    console.log(`[Server] CORS allowed origin: ${FRONTEND_URL}`);
    console.log(`[Server] Upload directory: ${UPLOAD_DIR}`);
  });
}

start().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM received, shutting down gracefully');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Server] SIGINT received, shutting down gracefully');
  await prisma.$disconnect();
  process.exit(0);
});
