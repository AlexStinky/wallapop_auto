import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import prisma from './db/prisma';
import productsRouter, { uploadMiddleware, handleUpload } from './routes/products';
import queueRouter from './routes/queue';
import settingsRouter from './routes/settings';
import { errorHandler, notFound } from './middleware/error';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');

// ─── Create uploads directory ─────────────────────────────────────────────────
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
console.log('[Server] Uploads directory:', UPLOAD_DIR);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server) or any local network / localhost origin
      callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Static file serving for uploaded images
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(UPLOAD_DIR));

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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Wallapop backend running on http://0.0.0.0:${PORT}`);
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
