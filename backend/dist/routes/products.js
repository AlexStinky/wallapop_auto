"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleUpload = exports.uploadMiddleware = void 0;
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const uuid_1 = require("uuid");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../db/prisma"));
const queue_service_1 = require("../services/queue.service");
const vinted_queue_service_1 = require("../services/vinted-queue.service");
const uploads_1 = require("../uploads");
const error_1 = require("../middleware/error");
const router = (0, express_1.Router)();
router.param('id', (_req, _res, next, id) => {
    next(/^[a-f\d]{24}$/i.test(id) ? undefined : (0, error_1.createError)('Invalid product ID', 400));
});
// ─── Multer Setup ─────────────────────────────────────────────────────────────
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => {
        const dir = path.resolve(process.env.UPLOAD_DIR || './uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (_req, file, cb) => {
        const ext = (0, uploads_1.imageExtension)(file.mimetype);
        cb(null, `${(0, uuid_1.v4)()}${ext}`);
    },
});
const upload = (0, multer_1.default)({
    storage,
    limits: {
        fileSize: 25 * 1024 * 1024, // 25 MB per file
        fieldSize: 50 * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
        if ((0, uploads_1.imageExtension)(file.mimetype)) {
            cb(null, true);
        }
        else {
            cb((0, error_1.createError)('Unsupported photo format', 415));
        }
    },
});
// ─── Validation Schemas ───────────────────────────────────────────────────────
const emptyStringToNull = (schema) => zod_1.z.preprocess((val) => (val === '' || (typeof val === 'string' && val.trim() === '') ? null : val), schema);
const createProductSchema = zod_1.z.object({
    title: zod_1.z.string().min(1).max(60),
    description: zod_1.z.string().min(1).max(2000),
    price: zod_1.z.number().positive(),
    category: zod_1.z.preprocess((val) => (val === '' || val === null || val === undefined ? 'auto' : String(val).trim()), zod_1.z.string().default('auto')),
    subcategory: emptyStringToNull(zod_1.z.string().nullable().optional()),
    condition: zod_1.z.string().min(1),
    brand: emptyStringToNull(zod_1.z.string().nullable().optional()),
    model: emptyStringToNull(zod_1.z.string().nullable().optional()),
    year: emptyStringToNull(zod_1.z.number().int().nullable().optional()),
    style: emptyStringToNull(zod_1.z.string().nullable().optional()),
    material: emptyStringToNull(zod_1.z.string().nullable().optional()),
    location: emptyStringToNull(zod_1.z.string().nullable().optional()),
    color: emptyStringToNull(zod_1.z.string().nullable().optional()),
    weight: emptyStringToNull(zod_1.z.string().nullable().optional()),
    quantity: zod_1.z.number().int().positive().default(1),
    images: zod_1.z.array(zod_1.z.string()).default([]),
    publishToWallapop: zod_1.z.boolean().default(true),
    publishToVinted: zod_1.z.boolean().default(true),
    vintedCategory: emptyStringToNull(zod_1.z.string().nullable().optional()),
    vintedSize: emptyStringToNull(zod_1.z.string().nullable().optional()),
    vintedTitle: emptyStringToNull(zod_1.z.string().nullable().optional()),
    vintedDescription: emptyStringToNull(zod_1.z.string().nullable().optional()),
    vintedPrice: emptyStringToNull(zod_1.z.number().positive().nullable().optional()),
});
const updateProductSchema = createProductSchema.partial();
exports.uploadMiddleware = upload.array('images', 20);
const handleUpload = (req, res, next) => {
    try {
        const files = req.files;
        if (!files || files.length === 0) {
            throw (0, error_1.createError)('No image files provided', 400);
        }
        const filenames = files.map((f) => f.filename);
        const urls = filenames.map((f) => `uploads/${f}`);
        res.json({ urls, filenames, count: filenames.length });
    }
    catch (err) {
        next(err);
    }
};
exports.handleUpload = handleUpload;
// ─── Routes ───────────────────────────────────────────────────────────────────
// GET /api/products
router.get('/', async (req, res, next) => {
    try {
        const { status, search } = req.query;
        const where = {};
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
        const products = await prisma_1.default.product.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        });
        // Parse images JSON for each product
        const result = products.map((p) => ({
            ...p,
            images: safeParseJson(p.images, []),
        }));
        res.json(result);
    }
    catch (err) {
        next(err);
    }
});
// POST /api/products/upload  (must be before /:id routes)
router.post('/upload', exports.uploadMiddleware, exports.handleUpload);
// POST /api/products
router.post('/', async (req, res, next) => {
    try {
        const { publishNow, status: requestedStatus, ...bodyData } = req.body;
        const parsed = createProductSchema.safeParse(bodyData);
        if (!parsed.success) {
            throw (0, error_1.createError)(`Validation error: ${parsed.error.message}`, 400);
        }
        const data = parsed.data;
        if (!data.publishToWallapop && !data.publishToVinted && (publishNow === true || requestedStatus === 'in_queue')) {
            throw (0, error_1.createError)('Виберіть хоча б один сайт для публікації', 400);
        }
        const isPublishNow = publishNow === true;
        const initialStatus = isPublishNow ? 'pending' : (requestedStatus === 'in_queue' ? 'in_queue' : 'pending');
        const product = await prisma_1.default.product.create({
            data: {
                ...data,
                images: JSON.stringify(data.images),
                status: initialStatus,
            },
        });
        if (isPublishNow) {
            if (data.publishToVinted) {
                await vinted_queue_service_1.vintedQueueService.enqueue(product.id);
            }
            if (data.publishToWallapop) {
                await queue_service_1.queueService.publishNow(product.id);
            }
        }
        else if (initialStatus === 'in_queue') {
            if (data.publishToVinted) {
                await vinted_queue_service_1.vintedQueueService.enqueue(product.id);
            }
            if (data.publishToWallapop) {
                await queue_service_1.queueService.addToQueue(product.id);
            }
        }
        res.status(201).json({ ...product, images: safeParseJson(product.images, []) });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/products/:id
router.get('/:id', async (req, res, next) => {
    try {
        const product = await prisma_1.default.product.findUnique({ where: { id: req.params.id } });
        if (!product)
            throw (0, error_1.createError)('Product not found', 404);
        res.json({ ...product, images: safeParseJson(product.images, []) });
    }
    catch (err) {
        next(err);
    }
});
// PUT /api/products/:id
router.put('/:id', async (req, res, next) => {
    try {
        const existing = await prisma_1.default.product.findUnique({ where: { id: req.params.id } });
        if (!existing)
            throw (0, error_1.createError)('Product not found', 404);
        const parsed = updateProductSchema.safeParse(req.body);
        if (!parsed.success) {
            throw (0, error_1.createError)(`Validation error: ${parsed.error.message}`, 400);
        }
        const data = parsed.data;
        const updateData = { ...data };
        if (data.images !== undefined) {
            updateData.images = JSON.stringify(data.images);
        }
        const updated = await prisma_1.default.product.update({
            where: { id: req.params.id },
            data: updateData,
        });
        res.json({ ...updated, images: safeParseJson(updated.images, []) });
    }
    catch (err) {
        next(err);
    }
});
// DELETE /api/products/:id
router.delete('/:id', async (req, res, next) => {
    try {
        const product = await prisma_1.default.product.findUnique({ where: { id: req.params.id } });
        if (!product)
            throw (0, error_1.createError)('Product not found', 404);
        // Remove from queue if present
        await queue_service_1.queueService.removeFromQueue(req.params.id);
        await prisma_1.default.product.delete({ where: { id: req.params.id } });
        // Delete image files
        const images = safeParseJson(product.images, []);
        for (const img of images) {
            const filePath = (0, uploads_1.resolveUploadedPhoto)(img);
            if (filePath)
                fs.unlink(filePath, () => null); // Best-effort
        }
        res.json({ message: 'Product deleted successfully' });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/products/publish-all → add all pending/in_queue products to queue and start
router.post('/publish-all', async (_req, res, next) => {
    try {
        const pendingProducts = await prisma_1.default.product.findMany({
            where: {
                OR: [{ status: 'pending' }, { status: 'in_queue' }, { status: 'error' }],
                NOT: { status: 'published' },
            },
        });
        if (pendingProducts.length === 0) {
            throw (0, error_1.createError)('Немає очікуючих товарів для публікації', 400);
        }
        const vintedIds = [];
        for (const p of pendingProducts) {
            if (p.publishToVinted && p.vintedStatus !== 'published') {
                vintedIds.push(p.id);
            }
        }
        const vintedCount = await vinted_queue_service_1.vintedQueueService.enqueueMany(vintedIds);
        const wallapopProducts = pendingProducts.filter(p => p.publishToWallapop && !p.wallapopId && p.wallapopStatus !== 'published');
        for (const product of wallapopProducts)
            await queue_service_1.queueService.addToQueue(product.id);
        const wallapopCount = wallapopProducts.length;
        if (wallapopCount > 0) {
            queue_service_1.queueService.startProcessing().catch((err) => {
                console.error('[PublishAll] Failed to start Wallapop queue processing loop:', err);
            });
        }
        res.json({
            message: `Додано до черги: Wallapop (${wallapopCount}), Vinted (${vintedCount}, інтервал не частіше 1 хв)`,
            count: pendingProducts.length,
        });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/products/:id/queue → add product to Wallapop queue (starts when user clicks "Запустити")
router.post('/:id/queue', async (req, res, next) => {
    try {
        const product = await prisma_1.default.product.findUnique({ where: { id: req.params.id } });
        if (!product)
            throw (0, error_1.createError)('Product not found', 404);
        await queue_service_1.queueService.addToQueue(product.id);
        res.json({
            message: 'Товар додано до черги Wallapop. Для початку публікації натисніть "Запустити".',
            productId: product.id,
            queueState: queue_service_1.queueService.getState(),
        });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/products/:id/publish → publish (with Vinted queue rate-limiting)
router.post(['/:id/publish', '/:id/publish-now'], async (req, res, next) => {
    try {
        const product = await prisma_1.default.product.findUnique({ where: { id: req.params.id } });
        if (!product)
            throw (0, error_1.createError)('Product not found', 404);
        const platform = req.body?.platform ?? req.query.platform;
        if (platform !== undefined && !['wallapop', 'vinted', 'both'].includes(platform)) {
            throw (0, error_1.createError)('Unknown publication platform', 400);
        }
        if ((!platform || platform === 'both') && !product.publishToWallapop && !product.publishToVinted) {
            throw (0, error_1.createError)('Виберіть хоча б один сайт для публікації', 400);
        }
        if (platform === 'vinted') {
            const q = await vinted_queue_service_1.vintedQueueService.enqueue(product.id);
            return res.json({
                message: `Товар додано до черги Vinted (позиція ${q.position}, очікування ~${q.estimatedWaitSeconds}с)`,
                productId: product.id,
                queue: q,
            });
        }
        if (platform === 'wallapop') {
            await queue_service_1.queueService.publishNow(product.id);
            return res.json({ message: 'Публікацію на Wallapop запущено', productId: product.id });
        }
        // Both platforms
        if (product.publishToVinted) {
            await vinted_queue_service_1.vintedQueueService.enqueue(product.id);
        }
        if (product.publishToWallapop) {
            await queue_service_1.queueService.publishNow(product.id);
        }
        return res.json({
            message: 'Публікацію запущено (Vinted додано до черги з інтервалом не менше 1 хв)',
            productId: product.id,
        });
    }
    catch (err) {
        next(err);
    }
});
// ─── Helpers ──────────────────────────────────────────────────────────────────
function safeParseJson(value, fallback) {
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
exports.default = router;
