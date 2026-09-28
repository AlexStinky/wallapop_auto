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
exports.queueService = exports.queueEvents = void 0;
const events_1 = require("events");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const prisma_1 = __importDefault(require("../db/prisma"));
const browser_service_1 = require("./browser.service");
// ─── SSE Broadcaster ─────────────────────────────────────────────────────────
exports.queueEvents = new events_1.EventEmitter();
exports.queueEvents.setMaxListeners(50);
// ─── Queue Service ────────────────────────────────────────────────────────────
class QueueService {
    constructor() {
        this.state = {
            isRunning: false,
            items: [],
            currentItem: null,
            completedCount: 0,
            failedCount: 0,
        };
        this.isProcessing = false;
        this.shouldStop = false;
    }
    // ── Public API ──────────────────────────────────────────────────────────────
    getState() {
        return { ...this.state, items: [...this.state.items] };
    }
    async loadPendingFromDb() {
        const products = await prisma_1.default.product.findMany({
            where: {
                OR: [
                    { status: 'in_queue' },
                    { status: 'pending' },
                ],
                NOT: {
                    status: 'published',
                },
            },
            orderBy: { createdAt: 'asc' }, // Спочатку старі, потім нові (FIFO)
        });
        let added = 0;
        for (const p of products) {
            // Пропускати ті, які вже опубліковані
            if (p.status === 'published' || p.wallapopId)
                continue;
            if (!this.state.items.some((i) => i.productId === p.id)) {
                this.state.items.push({ productId: p.id, addedAt: p.createdAt });
                added++;
            }
            if (p.status !== 'in_queue') {
                await prisma_1.default.product.update({
                    where: { id: p.id },
                    data: { status: 'in_queue', queueOrder: this.state.items.length, errorMessage: null },
                }).catch(() => null);
            }
        }
        // Гарантуємо сортування в черзі строго за часом створення: старі попереду (FIFO)
        const allIds = this.state.items.map((i) => i.productId);
        const allDbProducts = await prisma_1.default.product.findMany({
            where: { id: { in: allIds } },
            select: { id: true, createdAt: true },
        });
        const dateMap = new Map(allDbProducts.map((p) => [p.id, new Date(p.createdAt).getTime()]));
        this.state.items.sort((a, b) => (dateMap.get(a.productId) ?? 0) - (dateMap.get(b.productId) ?? 0));
        if (added > 0) {
            this.broadcast();
            console.log('[Queue] Loaded %d pending products from DB into queue (FIFO order, total items: %d)', added, this.state.items.length);
        }
        return this.state.items.length;
    }
    async addToQueue(productId) {
        const product = await prisma_1.default.product.findUnique({ where: { id: productId } });
        if (!product)
            return;
        // Prevent duplicates in queue array
        this.state.items = this.state.items.filter((i) => i.productId !== productId);
        this.state.items.push({ productId, addedAt: product.createdAt });
        // Update DB status (reset wallapopId if it was previously published and user wants to republish)
        await prisma_1.default.product.update({
            where: { id: productId },
            data: {
                status: 'in_queue',
                queueOrder: this.state.items.length,
                errorMessage: null,
                wallapopId: null,
                wallapopUrl: null,
            },
        });
        // Ensure queue is strictly sorted FIFO by createdAt ascending
        const allIds = this.state.items.map((i) => i.productId);
        const allDbProducts = await prisma_1.default.product.findMany({
            where: { id: { in: allIds } },
            select: { id: true, createdAt: true },
        });
        const dateMap = new Map(allDbProducts.map((p) => [p.id, new Date(p.createdAt).getTime()]));
        this.state.items.sort((a, b) => (dateMap.get(a.productId) ?? 0) - (dateMap.get(b.productId) ?? 0));
        this.broadcast();
        console.log('[Queue] Added product %s (queue size: %d, sorted FIFO by createdAt)', productId, this.state.items.length);
    }
    async removeFromQueue(productId) {
        this.state.items = this.state.items.filter((i) => i.productId !== productId);
        await prisma_1.default.product.update({
            where: { id: productId },
            data: { status: 'pending', queueOrder: null },
        }).catch(() => null);
        this.broadcast();
        console.log('[Queue] Removed product %s', productId);
    }
    async startProcessing() {
        if (this.isProcessing) {
            console.log('[Queue] Already processing');
            return;
        }
        // If queue in memory is empty, load all pending and in_queue products from DB
        if (this.state.items.length === 0) {
            await this.loadPendingFromDb();
        }
        if (this.state.items.length === 0) {
            console.log('[Queue] No products in queue to process');
            return;
        }
        this.shouldStop = false;
        this.state.isRunning = true;
        this.isProcessing = true;
        this.broadcast();
        console.log('[Queue] Starting processing loop with %d items', this.state.items.length);
        this.processLoop().catch((err) => {
            console.error('[Queue] processLoop crashed:', err);
            this.state.isRunning = false;
            this.isProcessing = false;
            this.broadcast();
        });
    }
    async stopProcessing() {
        console.log('[Queue] Stop requested');
        this.shouldStop = true;
        this.state.isRunning = false;
        this.broadcast();
    }
    async clearQueue() {
        // Reset all in-queue products back to pending
        const ids = this.state.items.map((i) => i.productId);
        if (ids.length > 0) {
            await prisma_1.default.product.updateMany({
                where: { id: { in: ids }, status: 'in_queue' },
                data: { status: 'pending', queueOrder: null },
            });
        }
        this.state.items = [];
        this.broadcast();
        console.log('[Queue] Queue cleared');
    }
    // Публікація ТІЛЬКИ цього одного товару прямо зараз (без черги)
    async publishDirectly(productId) {
        console.log('[DirectPublish] Publishing single product directly: %s', productId);
        const product = await prisma_1.default.product.findUnique({ where: { id: productId } });
        if (!product)
            return { success: false, error: 'Product not found' };
        // Remove from in-memory queue if it was queued
        this.state.items = this.state.items.filter((item) => item.productId !== productId);
        await prisma_1.default.product.update({
            where: { id: productId },
            data: { status: 'publishing', errorMessage: null },
        }).catch(() => null);
        this.broadcast();
        const settings = await prisma_1.default.settings.findFirst();
        const cookiesPath = path.join(process.cwd(), '.session-cookies.json');
        const hasCookies = fs.existsSync(cookiesPath);
        if (!hasCookies && (!settings || !settings.wallapopEmail || !settings.wallapopPassword)) {
            const err = 'Потрібна авторизація на Wallapop. Виконайте вхід або імпортуйте cookies у Налаштуваннях.';
            await prisma_1.default.product.update({
                where: { id: productId },
                data: { status: 'error', errorMessage: err },
            }).catch(() => null);
            this.broadcast();
            return { success: false, error: err };
        }
        try {
            // Always initialize visible browser during publication as requested
            await browser_service_1.browserService.initialize(false);
            const alreadyIn = await browser_service_1.browserService.isLoggedIn();
            if (!alreadyIn) {
                if (settings?.wallapopEmail && settings?.wallapopPassword) {
                    const ok = await browser_service_1.browserService.login(settings.wallapopEmail, settings.wallapopPassword);
                    if (!ok) {
                        const err = 'Помилка авторизації на Wallapop. Перевірте облікові дані або імпортуйте cookies.';
                        await prisma_1.default.product.update({
                            where: { id: productId },
                            data: { status: 'error', errorMessage: err },
                        }).catch(() => null);
                        this.broadcast();
                        return { success: false, error: err };
                    }
                }
                else {
                    const err = 'Потрібна авторизація на Wallapop. Виконайте вхід або імпортуйте cookies у Налаштуваннях.';
                    await prisma_1.default.product.update({
                        where: { id: productId },
                        data: { status: 'error', errorMessage: err },
                    }).catch(() => null);
                    this.broadcast();
                    return { success: false, error: err };
                }
            }
            const result = await browser_service_1.browserService.publishProduct(product);
            if (result.success) {
                await prisma_1.default.product.update({
                    where: { id: productId },
                    data: {
                        status: 'published',
                        wallapopId: result.wallapopId ?? null,
                        wallapopUrl: result.url ?? null,
                        errorMessage: null,
                    },
                });
                console.log('[DirectPublish] Product %s published successfully', productId);
            }
            else {
                await prisma_1.default.product.update({
                    where: { id: productId },
                    data: {
                        status: 'error',
                        errorMessage: result.error ?? 'Unknown error',
                    },
                });
                console.warn('[DirectPublish] Product %s failed: %s', productId, result.error);
            }
            this.broadcast();
            return result;
        }
        catch (err) {
            const msg = err?.message || String(err);
            await prisma_1.default.product.update({
                where: { id: productId },
                data: { status: 'error', errorMessage: msg },
            }).catch(() => null);
            this.broadcast();
            return { success: false, error: msg };
        }
        finally {
            // Закриваємо браузер тільки якщо черга зараз не працює у фоні
            if (!this.state.isRunning) {
                await browser_service_1.browserService.close().catch(() => null);
            }
        }
    }
    // ── Internal Processing ─────────────────────────────────────────────────────
    async processLoop() {
        try {
            // Load settings once
            let settings = await prisma_1.default.settings.findFirst();
            const cookiesPath = path.join(process.cwd(), '.session-cookies.json');
            const hasCookies = fs.existsSync(cookiesPath);
            if (!hasCookies && (!settings || !settings.wallapopEmail || !settings.wallapopPassword)) {
                console.error('[Queue] No credentials or cookies configured');
                return;
            }
            // Initialize browser visibly
            try {
                await browser_service_1.browserService.initialize(false);
                const alreadyIn = await browser_service_1.browserService.isLoggedIn();
                if (!alreadyIn) {
                    if (settings?.wallapopEmail && settings?.wallapopPassword) {
                        const ok = await browser_service_1.browserService.login(settings.wallapopEmail, settings.wallapopPassword);
                        if (!ok) {
                            console.error('[Queue] Login failed, aborting queue');
                            return;
                        }
                    }
                }
            }
            catch (err) {
                console.error('[Queue] Browser init/login error:', err);
                return;
            }
            // Process items one by one
            while (this.state.items.length > 0 && !this.shouldStop) {
                const item = this.state.items[0];
                this.state.currentItem = item.productId;
                this.broadcast();
                let published = false;
                try {
                    published = await this.processItem(item.productId);
                }
                catch (err) {
                    console.error('[Queue] Error processing item %s:', item.productId, err);
                }
                // Remove from queue after processing (success or error)
                this.state.items.shift();
                this.state.currentItem = null;
                this.broadcast();
                // If more items remain and an item was actually published, wait delay before next item
                if (published && this.state.items.length > 0 && !this.shouldStop) {
                    settings = await prisma_1.default.settings.findFirst();
                    const delay = (settings?.publishDelay ?? 10) * 1000;
                    console.log('[Queue] Waiting %ds before next item (%d items remaining)', delay / 1000, this.state.items.length);
                    await this.sleep(delay);
                }
            }
        }
        finally {
            // Cleanup browser and reset running state
            await browser_service_1.browserService.close().catch(() => null);
            this.state.isRunning = false;
            this.isProcessing = false;
            this.shouldStop = false;
            this.state.currentItem = null;
            this.broadcast();
            console.log('[Queue] Processing complete. Done: %d, Failed: %d', this.state.completedCount, this.state.failedCount);
        }
    }
    async processItem(productId) {
        const product = await prisma_1.default.product.findUnique({ where: { id: productId } });
        if (!product) {
            console.warn('[Queue] Product %s not found in DB, skipping', productId);
            return false;
        }
        // Пропускати ті, які вже опубліковані
        if (product.status === 'published' && product.wallapopId) {
            console.log('[Queue] Product %s is already published (wallapopId: %s), skipping', productId, product.wallapopId);
            return false;
        }
        // Mark as publishing
        await prisma_1.default.product.update({
            where: { id: productId },
            data: { status: 'publishing' },
        }).catch(() => null);
        this.broadcast();
        try {
            const result = await browser_service_1.browserService.publishProduct(product);
            if (result.success) {
                await prisma_1.default.product.update({
                    where: { id: productId },
                    data: {
                        status: 'published',
                        wallapopId: result.wallapopId ?? null,
                        wallapopUrl: result.url ?? null,
                        errorMessage: null,
                    },
                });
                this.state.completedCount++;
                console.log('[Queue] Product %s published successfully', productId);
                return true;
            }
            else {
                await prisma_1.default.product.update({
                    where: { id: productId },
                    data: {
                        status: 'error',
                        errorMessage: result.error ?? 'Unknown error',
                    },
                });
                this.state.failedCount++;
                console.warn('[Queue] Product %s failed: %s', productId, result.error);
                return false;
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await prisma_1.default.product.update({
                where: { id: productId },
                data: { status: 'error', errorMessage: message },
            }).catch(() => null);
            this.state.failedCount++;
            console.error('[Queue] Unexpected error for product %s: %s', productId, message);
            return false;
        }
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    broadcast() {
        exports.queueEvents.emit('state', this.getState());
    }
}
exports.queueService = new QueueService();
exports.default = exports.queueService;
