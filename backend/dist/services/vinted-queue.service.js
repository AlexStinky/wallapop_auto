"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.vintedQueueService = exports.vintedQueueEvents = void 0;
const events_1 = require("events");
const prisma_1 = __importDefault(require("../db/prisma"));
const vinted_service_1 = require("./vinted.service");
const publication_state_1 = require("./publication-state");
exports.vintedQueueEvents = new events_1.EventEmitter();
exports.vintedQueueEvents.setMaxListeners(50);
class VintedQueueService {
    constructor() {
        this.adding = new Map();
        this.queue = [];
        this.isProcessing = false;
        this.currentProductId = null;
        this.completedCount = 0;
        this.failedCount = 0;
        this.lastPublishedAt = 0;
        this.MIN_INTERVAL_MS = 60000; // 60 секунд (1 хвилина) між публікаціями
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
        let idx = this.queue.indexOf(productId);
        if (idx === -1) {
            let addition = this.adding.get(productId);
            if (!addition) {
                addition = (0, publication_state_1.setPublicationState)(productId, 'vinted', 'in_queue')
                    .then(() => this.queue.push(productId) - 1)
                    .finally(() => this.adding.delete(productId));
                this.adding.set(productId, addition);
            }
            idx = await addition;
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
                try {
                    await this.processItem(productId);
                }
                catch (error) {
                    this.failedCount++;
                    console.error('[VintedQueue] Failed to process', productId, error);
                }
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
        const product = await (0, publication_state_1.setPublicationState)(productId, 'vinted', 'publishing');
        this.broadcast();
        let result;
        try {
            const settings = await prisma_1.default.settings.findFirst();
            const headless = settings?.headless ?? true;
            await vinted_service_1.vintedBrowserService.initialize(headless);
            const isVintedLoggedIn = await vinted_service_1.vintedBrowserService.isLoggedIn();
            if (!isVintedLoggedIn) {
                if (settings?.vintedEmail && settings?.vintedPassword) {
                    await vinted_service_1.vintedBrowserService.login(settings.vintedEmail, settings.vintedPassword);
                }
            }
            result = await vinted_service_1.vintedBrowserService.publishProduct(product);
        }
        catch (error) {
            result = { success: false, error: error instanceof Error ? error.message : String(error) };
        }
        finally {
            await vinted_service_1.vintedBrowserService.close().catch(() => undefined);
        }
        if (result.success) {
            await (0, publication_state_1.setPublicationState)(productId, 'vinted', 'published', {
                listingId: result.vintedId ?? null, url: result.url ?? null,
            });
            this.completedCount++;
        }
        else {
            const message = 'Vinted: ' + (result.error || 'Unknown error');
            await (0, publication_state_1.setPublicationState)(productId, 'vinted', 'error', { errorMessage: message });
            this.failedCount++;
        }
        return result.success;
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
