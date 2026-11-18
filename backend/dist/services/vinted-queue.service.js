"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.vintedQueueService = exports.vintedQueueEvents = void 0;
const events_1 = require("events");
const prisma_1 = __importDefault(require("../db/prisma"));
const vinted_service_1 = require("./vinted.service");
exports.vintedQueueEvents = new events_1.EventEmitter();
exports.vintedQueueEvents.setMaxListeners(50);
class VintedQueueService {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.currentProductId = null;
        this.completedCount = 0;
        this.failedCount = 0;
        this.lastPublishedAt = 0;
        this.MIN_INTERVAL_MS = 60000; // 60 секунд (1 хвилина) між публікаціями
        // Автоматично відновлюємо незавершені публікації з БД при запуску
        setTimeout(() => {
            this.loadPendingFromDb().catch((err) => {
                console.error('[VintedQueue] Error loading pending items from DB:', err);
            });
        }, 3000);
    }
    getState() {
        const elapsed = Date.now() - this.lastPublishedAt;
        const remainingMs = this.lastPublishedAt > 0 && elapsed < this.MIN_INTERVAL_MS ? this.MIN_INTERVAL_MS - elapsed : 0;
        return {
            isRunning: this.isProcessing,
            queue: [...this.queue],
            currentProductId: this.currentProductId,
            completedCount: this.completedCount,
            failedCount: this.failedCount,
            lastPublishedAt: this.lastPublishedAt,
            nextAllowedInSeconds: Math.ceil(remainingMs / 1000),
        };
    }
    async loadPendingFromDb() {
        const products = await prisma_1.default.product.findMany({
            where: {
                vintedStatus: 'in_queue',
                NOT: { vintedStatus: 'published' },
            },
            orderBy: { createdAt: 'asc' },
        });
        let added = 0;
        for (const p of products) {
            if (!this.queue.includes(p.id) && this.currentProductId !== p.id) {
                this.queue.push(p.id);
                added++;
            }
        }
        if (added > 0) {
            console.log('[VintedQueue] Loaded %d pending Vinted products from DB into queue', added);
            this.broadcast();
            this.startProcessing();
        }
        return this.queue.length;
    }
    async enqueue(productId) {
        const product = await prisma_1.default.product.findUnique({ where: { id: productId } });
        if (!product) {
            throw new Error(`Product ${productId} not found`);
        }
        // Оновлюємо статус товару в БД
        await prisma_1.default.product
            .update({
            where: { id: productId },
            data: {
                vintedStatus: 'in_queue',
                status: product.status === 'published' ? 'published' : 'in_queue',
                errorMessage: null,
            },
        })
            .catch(() => null);
        let idx = this.queue.indexOf(productId);
        if (idx === -1) {
            this.queue.push(productId);
            idx = this.queue.length - 1;
        }
        const position = idx + 1;
        const elapsed = Date.now() - this.lastPublishedAt;
        const currentWait = this.lastPublishedAt > 0 && elapsed < this.MIN_INTERVAL_MS ? (this.MIN_INTERVAL_MS - elapsed) / 1000 : 0;
        const estimatedWaitSeconds = Math.ceil(currentWait + (position - 1) * 60);
        console.log('[VintedQueue] Enqueued product %s (pos: %d, estimated wait: %ds)', productId, position, estimatedWaitSeconds);
        this.broadcast();
        this.startProcessing();
        return { position, estimatedWaitSeconds };
    }
    async enqueueMany(productIds) {
        let count = 0;
        for (const id of productIds) {
            try {
                await this.enqueue(id);
                count++;
            }
            catch { }
        }
        return count;
    }
    startProcessing() {
        if (this.isProcessing)
            return;
        this.isProcessing = true;
        this.broadcast();
        this.processLoop().catch((err) => {
            console.error('[VintedQueue] processLoop error:', err);
            this.isProcessing = false;
            this.broadcast();
        });
    }
    async processLoop() {
        try {
            while (this.queue.length > 0) {
                const productId = this.queue[0];
                this.currentProductId = productId;
                this.broadcast();
                // 1. Дотримання ліміту: не частіше ніж 1 раз на хвилину (60 000 мс)
                const elapsed = Date.now() - this.lastPublishedAt;
                if (this.lastPublishedAt > 0 && elapsed < this.MIN_INTERVAL_MS) {
                    const waitMs = this.MIN_INTERVAL_MS - elapsed;
                    console.log('[VintedQueue] Rate limit: waiting %ds before publishing item %s...', Math.ceil(waitMs / 1000), productId);
                    await this.sleep(waitMs);
                }
                // 2. Публікація товару
                console.log('[VintedQueue] Starting publication for product %s (%d remaining in queue)', productId, this.queue.length - 1);
                await this.processItem(productId);
                // 3. Фіксація часу завершення публікації
                this.lastPublishedAt = Date.now();
                // 4. Видалення обробленого товару з черги
                this.queue.shift();
                this.currentProductId = null;
                this.broadcast();
            }
        }
        finally {
            this.isProcessing = false;
            this.currentProductId = null;
            this.broadcast();
            console.log('[VintedQueue] Queue finished. Completed: %d, Failed: %d', this.completedCount, this.failedCount);
        }
    }
    async processItem(productId) {
        const product = await prisma_1.default.product.findUnique({ where: { id: productId } });
        if (!product) {
            console.warn('[VintedQueue] Product %s not found in DB, skipping', productId);
            return false;
        }
        if (product.vintedStatus === 'published' && product.vintedUrl) {
            console.log('[VintedQueue] Product %s is already published on Vinted, skipping', productId);
            return true;
        }
        // Переводимо у стан публікації
        await prisma_1.default.product
            .update({
            where: { id: productId },
            data: {
                vintedStatus: 'publishing',
                status: 'publishing',
                errorMessage: null,
            },
        })
            .catch(() => null);
        this.broadcast();
        const settings = await prisma_1.default.settings.findFirst();
        const headless = settings?.headless ?? true;
        try {
            await vinted_service_1.vintedBrowserService.initialize(headless);
            const isVintedLoggedIn = await vinted_service_1.vintedBrowserService.isLoggedIn();
            if (!isVintedLoggedIn) {
                if (settings?.vintedEmail && settings?.vintedPassword) {
                    await vinted_service_1.vintedBrowserService.login(settings.vintedEmail, settings.vintedPassword);
                }
            }
            const result = await vinted_service_1.vintedBrowserService.publishProduct(product);
            if (result.success) {
                this.completedCount++;
                const currentProd = await prisma_1.default.product.findUnique({ where: { id: productId } });
                const wallapopDone = !currentProd?.publishToWallapop || currentProd?.wallapopStatus === 'published';
                await prisma_1.default.product
                    .update({
                    where: { id: productId },
                    data: {
                        vintedId: result.vintedId ?? null,
                        vintedUrl: result.url ?? null,
                        vintedStatus: 'published',
                        status: wallapopDone ? 'published' : currentProd?.status,
                        errorMessage: null,
                    },
                })
                    .catch(() => null);
                console.log('[VintedQueue] Product %s published successfully to Vinted: %s', productId, result.url);
                return true;
            }
            else {
                this.failedCount++;
                const errMsg = `Vinted: ${result.error || 'Unknown error'}`;
                await prisma_1.default.product
                    .update({
                    where: { id: productId },
                    data: {
                        vintedStatus: 'error',
                        status: 'error',
                        errorMessage: errMsg,
                    },
                })
                    .catch(() => null);
                console.warn('[VintedQueue] Product %s failed on Vinted: %s', productId, errMsg);
                return false;
            }
        }
        catch (err) {
            this.failedCount++;
            const msg = `Vinted: ${err?.message || String(err)}`;
            await prisma_1.default.product
                .update({
                where: { id: productId },
                data: {
                    vintedStatus: 'error',
                    status: 'error',
                    errorMessage: msg,
                },
            })
                .catch(() => null);
            console.error('[VintedQueue] Product %s crashed on Vinted:', productId, err);
            return false;
        }
        finally {
            await vinted_service_1.vintedBrowserService.close().catch(() => null);
        }
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    broadcast() {
        exports.vintedQueueEvents.emit('state', this.getState());
    }
}
exports.vintedQueueService = new VintedQueueService();
exports.default = exports.vintedQueueService;
