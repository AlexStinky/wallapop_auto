"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueService = exports.queueEvents = void 0;
const events_1 = require("events");
const prisma_1 = __importDefault(require("../db/prisma"));
const browser_service_1 = require("./browser.service");
const publication_state_1 = require("./publication-state");
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
        this.adding = new Map();
        this.active = new Map();
        this.browserAvailable = Promise.resolve();
    }
    // ── Public API ──────────────────────────────────────────────────────────────
    getState() {
        return { ...this.state, items: [...this.state.items] };
    }
    async loadPendingFromDb() {
        const products = await prisma_1.default.product.findMany({
            where: {
                OR: [{ wallapopStatus: 'in_queue' }, { status: { in: ['pending', 'in_queue'] } }],
            },
            orderBy: { createdAt: 'asc' },
        });
        for (const product of products) {
            if ((product.publishToWallapop || product.wallapopStatus === 'in_queue') &&
                (product.wallapopStatus === 'in_queue' || (!product.wallapopId && product.wallapopStatus !== 'published'))) {
                await this.addToQueue(product.id);
            }
        }
        return this.state.items.length;
    }
    async addToQueue(productId) {
        if (this.active.has(productId) || this.state.items.some(i => i.productId === productId))
            return;
        const pending = this.adding.get(productId);
        if (pending)
            return pending;
        const addition = this.insertItem(productId);
        this.adding.set(productId, addition);
        try {
            await addition;
        }
        finally {
            this.adding.delete(productId);
        }
    }
    async insertItem(productId) {
        const product = await (0, publication_state_1.setPublicationState)(productId, 'wallapop', 'in_queue', {
            queueOrder: this.state.items.length + 1,
        });
        if (!this.active.has(productId) && !this.state.items.some(i => i.productId === productId)) {
            this.state.items.push({ productId, addedAt: product.createdAt });
            this.state.items.sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime());
            this.broadcast();
        }
    }
    async removeFromQueue(productId) {
        const queued = this.state.items.some(item => item.productId === productId);
        if (queued && !this.active.has(productId)) {
            await (0, publication_state_1.setPublicationState)(productId, 'wallapop', 'pending', { queueOrder: null });
        }
        this.state.items = this.state.items.filter(i => i.productId !== productId);
        this.broadcast();
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
        if (this.isProcessing)
            return;
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
        for (const item of [...this.state.items]) {
            if (item.productId !== this.state.currentItem)
                await this.removeFromQueue(item.productId);
        }
    }
    async publishNow(productId) {
        await this.addToQueue(productId);
        this.publishDirectly(productId).catch(error => console.error('[Wallapop] Publication failed', productId, error));
    }
    async publishDirectly(productId) {
        const running = this.active.get(productId);
        if (running)
            return running;
        const publication = this.browserAvailable.then(() => this.publishWallapop(productId));
        this.active.set(productId, publication);
        this.browserAvailable = publication.catch(() => undefined);
        try {
            return await publication;
        }
        finally {
            this.active.delete(productId);
            this.state.items = this.state.items.filter(i => i.productId !== productId);
            this.broadcast();
        }
    }
    async publishWallapop(productId) {
        const product = await (0, publication_state_1.setPublicationState)(productId, 'wallapop', 'publishing', { queueOrder: null });
        let result;
        try {
            const settings = await prisma_1.default.settings.findFirst();
            await browser_service_1.browserService.initialize(settings?.headless ?? true);
            if (!(await browser_service_1.browserService.isLoggedIn()) && settings?.wallapopEmail && settings.wallapopPassword) {
                await browser_service_1.browserService.login(settings.wallapopEmail, settings.wallapopPassword);
            }
            result = await browser_service_1.browserService.publishProduct(product);
        }
        catch (error) {
            result = { success: false, error: error instanceof Error ? error.message : String(error) };
        }
        finally {
            await browser_service_1.browserService.close().catch(() => undefined);
        }
        if (result.success) {
            await (0, publication_state_1.setPublicationState)(productId, 'wallapop', 'published', {
                listingId: result.wallapopId ?? null, url: result.url ?? null,
            });
        }
        else {
            await (0, publication_state_1.setPublicationState)(productId, 'wallapop', 'error', {
                errorMessage: 'Wallapop: ' + (result.error || 'Unknown error'),
            });
        }
        return result.success;
    }
    // ── Internal Processing ─────────────────────────────────────────────────────
    async processLoop() {
        try {
            // Process items one by one
            while (this.state.items.length > 0 && !this.shouldStop) {
                const item = this.state.items[0];
                this.state.currentItem = item.productId;
                this.broadcast();
                let published = false;
                try {
                    published = await this.publishDirectly(item.productId);
                }
                catch (err) {
                    console.error('[Queue] Error processing item %s:', item.productId, err);
                }
                if (published)
                    this.state.completedCount++;
                else
                    this.state.failedCount++;
                this.state.currentItem = null;
                this.broadcast();
                // If more items remain and an item was actually published, wait delay before next item
                if (published && this.state.items.length > 0 && !this.shouldStop) {
                    const settings = await prisma_1.default.settings.findFirst();
                    const delay = (settings?.publishDelay ?? 10) * 1000;
                    console.log('[Queue] Waiting %ds before next item (%d items remaining)', delay / 1000, this.state.items.length);
                    await this.sleep(delay);
                }
            }
        }
        finally {
            this.state.isRunning = false;
            this.isProcessing = false;
            this.shouldStop = false;
            this.state.currentItem = null;
            this.broadcast();
            console.log('[Queue] Processing complete. Done: %d, Failed: %d', this.state.completedCount, this.state.failedCount);
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
