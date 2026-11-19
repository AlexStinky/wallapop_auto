import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import prisma from '../db/prisma';
import { queueService } from '../services/queue.service';
import { vintedQueueService } from '../services/vinted-queue.service';
import { resolveUploadedPhoto, imageExtension } from '../uploads';
import { createError } from '../middleware/error';

const router = Router();
router.param('id', (_req, _res, next, id: string) => {
  next(/^[a-f\d]{24}$/i.test(id) ? undefined : createError('Invalid product ID', 400));
});

// ─── Multer Setup ─────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.resolve(process.env.UPLOAD_DIR || './uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = imageExtension(file.mimetype);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB per file
    fieldSize: 50 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (imageExtension(file.mimetype)) {
      cb(null, true);
    } else {
      cb(createError('Unsupported photo format', 415));
    }
  },
});

// ─── Validation Schemas ───────────────────────────────────────────────────────

const emptyStringToNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((val) => (val === '' || (typeof val === 'string' && val.trim() === '') ? null : val), schema);

const createProductSchema = z.object({
  title: z.string().min(1).max(60),
  description: z.string().min(1).max(2000),
  price: z.number().positive(),
  category: z.preprocess((val) => (val === '' || val === null || val === undefined ? 'auto' : String(val).trim()), z.string().default('auto')),
  subcategory: emptyStringToNull(z.string().nullable().optional()),
  condition: z.string().min(1),
  brand: emptyStringToNull(z.string().nullable().optional()),
  model: emptyStringToNull(z.string().nullable().optional()),
  year: emptyStringToNull(z.number().int().nullable().optional()),
  style: emptyStringToNull(z.string().nullable().optional()),
  material: emptyStringToNull(z.string().nullable().optional()),
  location: emptyStringToNull(z.string().nullable().optional()),
  color: emptyStringToNull(z.string().nullable().optional()),
  weight: emptyStringToNull(z.string().nullable().optional()),
  quantity: z.number().int().positive().default(1),
  images: z.array(z.string()).default([]),
  publishToWallapop: z.boolean().default(true),
  publishToVinted: z.boolean().default(true),
  vintedCategory: emptyStringToNull(z.string().nullable().optional()),
  vintedSize: emptyStringToNull(z.string().nullable().optional()),
  vintedTitle: emptyStringToNull(z.string().nullable().optional()),
  vintedDescription: emptyStringToNull(z.string().nullable().optional()),
  vintedPrice: emptyStringToNull(z.number().positive().nullable().optional()),
});

const updateProductSchema = createProductSchema.partial();

export const uploadMiddleware = upload.array('images', 20);

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
    if (!data.publishToWallapop && !data.publishToVinted && (publishNow === true || requestedStatus === 'in_queue')) {
      throw createError('Виберіть хоча б один сайт для публікації', 400);
    }
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
      if (data.publishToVinted) {
        await vintedQueueService.enqueue(product.id);
      }
      if (data.publishToWallapop) {
        await queueService.publishNow(product.id);
      }
    } else if (initialStatus === 'in_queue') {
      if (data.publishToVinted) {
        await vintedQueueService.enqueue(product.id);
      }
      if (data.publishToWallapop) {
        await queueService.addToQueue(product.id);
      }
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

    await prisma.product.delete({ where: { id: req.params.id } });

    // Delete image files
    const images = safeParseJson<string[]>(product.images, []);
    for (const img of images) {
      const filePath = resolveUploadedPhoto(img);
      if (filePath) fs.unlink(filePath, () => null); // Best-effort
    }

    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /api/products/publish-all → add all pending/in_queue products to queue and start
router.post('/publish-all', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const pendingProducts = await prisma.product.findMany({
      where: {
        OR: [{ status: 'pending' }, { status: 'in_queue' }, { status: 'error' }],
        NOT: { status: 'published' },
      },
    });

    if (pendingProducts.length === 0) {
      throw createError('Немає очікуючих товарів для публікації', 400);
    }

    const vintedIds: string[] = [];
    for (const p of pendingProducts) {
      if (p.publishToVinted && p.vintedStatus !== 'published') {
        vintedIds.push(p.id);
      }
    }

    const vintedCount = await vintedQueueService.enqueueMany(vintedIds);

    const wallapopProducts = pendingProducts.filter(p => p.publishToWallapop && !p.wallapopId && p.wallapopStatus !== 'published');
    for (const product of wallapopProducts) await queueService.addToQueue(product.id);
    const wallapopCount = wallapopProducts.length;
    if (wallapopCount > 0) {
      queueService.startProcessing().catch((err) => {
        console.error('[PublishAll] Failed to start Wallapop queue processing loop:', err);
      });
    }

    res.json({
      message: `Додано до черги: Wallapop (${wallapopCount}), Vinted (${vintedCount}, інтервал не частіше 1 хв)`,
      count: pendingProducts.length,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/products/:id/queue → add product to Wallapop queue (starts when user clicks "Запустити")
router.post('/:id/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) throw createError('Product not found', 404);

    await queueService.addToQueue(product.id);
    res.json({
      message: 'Товар додано до черги Wallapop. Для початку публікації натисніть "Запустити".',
      productId: product.id,
      queueState: queueService.getState(),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/products/:id/publish → publish (with Vinted queue rate-limiting)
router.post(['/:id/publish', '/:id/publish-now'], async (req: Request, res: Response, next: NextFunction) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) throw createError('Product not found', 404);

    const platform = req.body?.platform ?? req.query.platform;
    if (platform !== undefined && !['wallapop', 'vinted', 'both'].includes(platform)) {
      throw createError('Unknown publication platform', 400);
    }
    if ((!platform || platform === 'both') && !product.publishToWallapop && !product.publishToVinted) {
      throw createError('Виберіть хоча б один сайт для публікації', 400);
    }

    if (platform === 'vinted') {
      const q = await vintedQueueService.enqueue(product.id);
      return res.json({
        message: `Товар додано до черги Vinted (позиція ${q.position}, очікування ~${q.estimatedWaitSeconds}с)`,
        productId: product.id,
        queue: q,
      });
    }

    if (platform === 'wallapop') {
      await queueService.publishNow(product.id);
      return res.json({ message: 'Публікацію на Wallapop запущено', productId: product.id });
    }

    // Both platforms
    if (product.publishToVinted) {
      await vintedQueueService.enqueue(product.id);
    }
    if (product.publishToWallapop) {
      await queueService.publishNow(product.id);
    }

    return res.json({
      message: 'Публікацію запущено (Vinted додано до черги з інтервалом не менше 1 хв)',
      productId: product.id,
    });
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
