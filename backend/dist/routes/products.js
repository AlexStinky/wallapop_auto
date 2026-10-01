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
const error_1 = require("../middleware/error");
const router = (0, express_1.Router)();
// ─── Multer Setup ─────────────────────────────────────────────────────────────
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => {
        const dir = path.resolve(process.env.UPLOAD_DIR || './uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
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
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        }
        else {
            cb(new Error('Only image files are allowed'));
        }
    },
});
// ─── Validation Schemas ───────────────────────────────────────────────────────
const createProductSchema = zod_1.z.object({
    title: zod_1.z.string().min(1).max(60),
    description: zod_1.z.string().min(1).max(2000),
    price: zod_1.z.number().positive(),
    category: zod_1.z.string().optional().default('auto'),
    subcategory: zod_1.z.string().optional(),
    condition: zod_1.z.string().min(1),
    brand: zod_1.z.string().optional(),
    model: zod_1.z.string().optional(),
    year: zod_1.z.number().int().optional(),
    style: zod_1.z.string().optional(),
    material: zod_1.z.string().optional(),
    location: zod_1.z.string().optional(),
    color: zod_1.z.string().optional(),
    weight: zod_1.z.string().optional(),
    quantity: zod_1.z.number().int().positive().default(1),
    images: zod_1.z.array(zod_1.z.string()).default([]),
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
            // Публікація ТІЛЬКИ цього товару одразу, БЕЗ черги
            queue_service_1.queueService.publishDirectly(product.id).catch((err) => {
                console.error('[PublishDirectly] Failed to publish product %s directly:', product.id, err);
            });
        }
        else if (initialStatus === 'in_queue') {
            await queue_service_1.queueService.addToQueue(product.id);
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
        // Delete image files
        const images = safeParseJson(product.images, []);
        const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
        for (const img of images) {
            const filePath = path.join(uploadDir, path.basename(img));
            fs.unlink(filePath, () => null); // Best-effort
        }
        await prisma_1.default.product.delete({ where: { id: req.params.id } });
        res.json({ message: 'Product deleted successfully' });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/products/publish-all → add all pending/in_queue products to queue and start
router.post('/publish-all', async (_req, res, next) => {
    try {
        const count = await queue_service_1.queueService.loadPendingFromDb();
        if (count === 0) {
            throw (0, error_1.createError)('Немає очікуючих товарів для публікації', 400);
        }
        queue_service_1.queueService.startProcessing().catch((err) => {
            console.error('[PublishAll] Failed to start queue processing loop:', err);
        });
        res.json({ message: `Додано ${count} товарів до черги`, queueState: queue_service_1.queueService.getState() });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/products/:id/publish → publish directly right now without delay
router.post('/:id/publish', async (req, res, next) => {
    try {
        const product = await prisma_1.default.product.findUnique({ where: { id: req.params.id } });
        if (!product)
            throw (0, error_1.createError)('Product not found', 404);
        queue_service_1.queueService.publishDirectly(product.id).catch((err) => {
            console.error('[PublishDirectly] Error publishing directly:', err);
        });
        res.json({ message: 'Публікацію запущено відразу', productId: product.id });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/products/:id/publish-now → publish directly right now without touching the queue
router.post('/:id/publish-now', async (req, res, next) => {
    try {
        const product = await prisma_1.default.product.findUnique({ where: { id: req.params.id } });
        if (!product)
            throw (0, error_1.createError)('Product not found', 404);
        queue_service_1.queueService.publishDirectly(product.id).catch((err) => {
            console.error('[PublishNow] Error publishing directly:', err);
        });
        res.json({ message: 'Публікацію запущено відразу', productId: product.id });
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
