import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import prisma from '../db/prisma';
import { queueService } from '../services/queue.service';
import { createError } from '../middleware/error';

const router = Router();

// ─── Multer Setup ─────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.resolve(process.env.UPLOAD_DIR || './uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// ─── Validation Schemas ───────────────────────────────────────────────────────

const createProductSchema = z.object({
  title: z.string().min(1).max(60),
  description: z.string().min(1).max(2000),
  price: z.number().positive(),
  category: z.string().optional().default('auto'),
  subcategory: z.string().optional(),
  condition: z.string().min(1),
  brand: z.string().optional(),
  model: z.string().optional(),
  year: z.number().int().optional(),
  style: z.string().optional(),
  material: z.string().optional(),
  location: z.string().optional(),
  color: z.string().optional(),
  weight: z.string().optional(),
  quantity: z.number().int().positive().default(1),
  images: z.array(z.string()).default([]),
});

const updateProductSchema = createProductSchema.partial();

export const uploadMiddleware = upload.array('images', 10);

export const handleUpload = (req: Request, res: Response, next: NextFunction) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      throw createError('No image files provided', 400);
    }
    const filenames = files.map((f) => f.filename);
    const urls = filenames.map((f) => `uploads/${f}`);
    res.json({ urls, filenames, count: filenames.length });
  } catch (err) {
    next(err);
  }
};

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/products
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, search } = req.query as Record<string, string>;

    const where: Record<string, unknown> = {};
    if (status) {
      where.status = status;
    }
    if (search) {
      where.OR = [
        { title: { contains: search } },
        { description: { contains: search } },
        { brand: { contains: search } },
      ];
    }

    const products = await prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    // Parse images JSON for each product
    const result = products.map((p) => ({
      ...p,
      images: safeParseJson(p.images, []),
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/products/upload  (must be before /:id routes)
router.post('/upload', uploadMiddleware, handleUpload);

// POST /api/products
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { publishNow, status: requestedStatus, ...bodyData } = req.body;
    const parsed = createProductSchema.safeParse(bodyData);
    if (!parsed.success) {
      throw createError(`Validation error: ${parsed.error.message}`, 400);
    }

    const data = parsed.data;
    const isPublishNow = publishNow === true;
    const initialStatus = isPublishNow ? 'pending' : (requestedStatus === 'in_queue' ? 'in_queue' : 'pending');

    const product = await prisma.product.create({
      data: {
        ...data,
        images: JSON.stringify(data.images),
        status: initialStatus,
      },
    });

    if (isPublishNow) {
      // Публікація ТІЛЬКИ цього товару одразу, БЕЗ черги
      queueService.publishDirectly(product.id).catch((err) => {
        console.error('[PublishDirectly] Failed to publish product %s directly:', product.id, err);
      });
    } else if (initialStatus === 'in_queue') {
      await queueService.addToQueue(product.id);
    }

    res.status(201).json({ ...product, images: safeParseJson(product.images, []) });
  } catch (err) {
    next(err);
  }
});

// GET /api/products/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) throw createError('Product not found', 404);
    res.json({ ...product, images: safeParseJson(product.images, []) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/products/:id
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!existing) throw createError('Product not found', 404);

    const parsed = updateProductSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(`Validation error: ${parsed.error.message}`, 400);
    }

    const data = parsed.data;
    const updateData: Record<string, unknown> = { ...data };
    if (data.images !== undefined) {
      updateData.images = JSON.stringify(data.images);
    }

    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: updateData,
    });

    res.json({ ...updated, images: safeParseJson(updated.images, []) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/products/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) throw createError('Product not found', 404);

    // Remove from queue if present
    await queueService.removeFromQueue(req.params.id);

    // Delete image files
    const images = safeParseJson<string[]>(product.images, []);
    const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
    for (const img of images) {
      const filePath = path.join(uploadDir, path.basename(img));
      fs.unlink(filePath, () => null); // Best-effort
    }

    await prisma.product.delete({ where: { id: req.params.id } });
    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /api/products/publish-all → add all pending/in_queue products to queue and start
router.post('/publish-all', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const count = await queueService.loadPendingFromDb();
    if (count === 0) {
      throw createError('Немає очікуючих товарів для публікації', 400);
    }
    queueService.startProcessing().catch((err) => {
      console.error('[PublishAll] Failed to start queue processing loop:', err);
    });
    res.json({ message: `Додано ${count} товарів до черги`, queueState: queueService.getState() });
  } catch (err) {
    next(err);
  }
});

// POST /api/products/:id/publish → publish directly right now without delay
router.post('/:id/publish', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) throw createError('Product not found', 404);

    queueService.publishDirectly(product.id).catch((err) => {
      console.error('[PublishDirectly] Error publishing directly:', err);
    });

    res.json({ message: 'Публікацію запущено відразу', productId: product.id });
  } catch (err) {
    next(err);
  }
});

// POST /api/products/:id/publish-now → publish directly right now without touching the queue
router.post('/:id/publish-now', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) throw createError('Product not found', 404);

    queueService.publishDirectly(product.id).catch((err) => {
      console.error('[PublishNow] Error publishing directly:', err);
    });

    res.json({ message: 'Публікацію запущено відразу', productId: product.id });
  } catch (err) {
    next(err);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeParseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export default router;
