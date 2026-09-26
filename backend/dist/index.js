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
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const prisma_1 = __importDefault(require("./db/prisma"));
const products_1 = __importStar(require("./routes/products"));
const queue_1 = __importDefault(require("./routes/queue"));
const settings_1 = __importDefault(require("./routes/settings"));
const error_1 = require("./middleware/error");
const app = (0, express_1.default)();
const PORT = parseInt(process.env.PORT || '3001', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
// ─── Create uploads directory ─────────────────────────────────────────────────
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
console.log('[Server] Uploads directory:', UPLOAD_DIR);
// ─── Middleware ───────────────────────────────────────────────────────────────
app.use((0, cors_1.default)({
    origin: [FRONTEND_URL, 'http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '10mb' }));
// Static file serving for uploaded images
app.use('/uploads', express_1.default.static(UPLOAD_DIR));
app.use(express_1.default.static(UPLOAD_DIR));
// ─── Routes ───────────────────────────────────────────────────────────────────
// Direct upload endpoints
app.post('/upload', products_1.uploadMiddleware, products_1.handleUpload);
app.post('/api/upload', products_1.uploadMiddleware, products_1.handleUpload);
// Support both /api/* and root /* endpoints
app.use('/api/products', products_1.default);
app.use('/products', products_1.default);
app.use('/api/queue', queue_1.default);
app.use('/queue', queue_1.default);
app.use('/api/settings', settings_1.default);
app.use('/settings', settings_1.default);
// Health check
app.get(['/health', '/api/health'], (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// 404 handler
app.use(error_1.notFound);
// Global error handler (must be last)
app.use(error_1.errorHandler);
// ─── DB Initialisation ────────────────────────────────────────────────────────
async function initDb() {
    try {
        // Verify DB connection
        await prisma_1.default.$connect();
        console.log('[Server] MongoDB connection OK');
        // Ensure default Settings document exists
        const settings = await prisma_1.default.settings.findFirst();
        if (!settings) {
            await prisma_1.default.settings.create({
                data: {
                    wallapopEmail: '',
                    wallapopPassword: '',
                    publishDelay: 30,
                    headless: true,
                },
            });
            console.log('[Server] Default settings created');
        }
    }
    catch (err) {
        console.error('[Server] Database initialisation failed:', err);
        console.error('[Server] Make sure MongoDB is running and DATABASE_URL is valid');
        process.exit(1);
    }
}
// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
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
    await prisma_1.default.$disconnect();
    process.exit(0);
});
process.on('SIGINT', async () => {
    console.log('[Server] SIGINT received, shutting down gracefully');
    await prisma_1.default.$disconnect();
    process.exit(0);
});
