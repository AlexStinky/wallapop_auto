"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueService = exports.queueEvents = void 0;
const events_1 = require("events");
const prisma_1 = __importDefault(require("../db/prisma"));
const browser_service_1 = require("./browser.service");
const vinted_service_1 = require("./vinted.service");
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
    // Helper: Publish a product to Wallapop, Vinted, or both based on flags
    async publishToBothPlatforms(product, headless, platformOverride) {
        const errors = [];
        let wallapopSuccess = false;
        let vintedSuccess = false;
        const shouldPublishWallapop = platformOverride
            ? (platformOverride === 'wallapop' || platformOverride === 'both')
            : product.publishToWallapop !== false;
        const shouldPublishVinted = platformOverride
            ? (platformOverride === 'vinted' || platformOverride === 'both')
            : product.publishToVinted !== false;
        // 1. Publish to Wallapop (if enabled)
        if (shouldPublishWallapop) {
            try {
                console.log('[DualPublish] Step 1: Wallapop for product %s', product.id);
                await browser_service_1.browserService.initialize(headless);
                const isWpLoggedIn = await browser_service_1.browserService.isLoggedIn();
                if (!isWpLoggedIn) {
                    const settings = await prisma_1.default.settings.findFirst();
                    if (settings?.wallapopEmail && settings?.wallapopPassword) {
                        await browser_service_1.browserService.login(settings.wallapopEmail, settings.wallapopPassword);
                    }
                }
                const wpResult = await browser_service_1.browserService.publishProduct(product);
                if (wpResult.success) {
                    wallapopSuccess = true;
                    await prisma_1.default.product.update({
                        where: { id: product.id },
                        data: {
                            wallapopId: wpResult.wallapopId ?? null,
                            wallapopUrl: wpResult.url ?? null,
                            wallapopStatus: 'published',
                        },
                    }).catch(() => null);
                    console.log('[DualPublish] Wallapop success for %s', product.id);
                }
                else {
                    errors.push(`Wallapop: ${wpResult.error || 'Unknown error'}`);
                    await prisma_1.default.product.update({
                        where: { id: product.id },
                        data: { wallapopStatus: 'error' },
                    }).catch(() => null);
                }
            }
            catch (wpErr) {
                errors.push(`Wallapop: ${wpErr.message || String(wpErr)}`);
                await prisma_1.default.product.update({
                    where: { id: product.id },
                    data: { wallapopStatus: 'error' },
                }).catch(() => null);
            }
            finally {
                await browser_service_1.browserService.close().catch(() => null);
            }
        }
        // Small delay between platforms if both are publishing
        if (shouldPublishWallapop && shouldPublishVinted) {
            await this.sleep(2000);
        }
        // 2. Publish to Vinted (if enabled)
        if (shouldPublishVinted) {
            try {
                console.log('[DualPublish] Step 2: Vinted for product %s', product.id);
                await vinted_service_1.vintedBrowserService.initialize(headless);
                const isVintedLoggedIn = await vinted_service_1.vintedBrowserService.isLoggedIn();
                if (!isVintedLoggedIn) {
                    const settings = await prisma_1.default.settings.findFirst();
                    if (settings?.vintedEmail && settings?.vintedPassword) {
                        await vinted_service_1.vintedBrowserService.login(settings.vintedEmail, settings.vintedPassword);
                    }
                }
                const vintedResult = await vinted_service_1.vintedBrowserService.publishProduct(product);
                if (vintedResult.success) {
                    vintedSuccess = true;
                    await prisma_1.default.product.update({
                        where: { id: product.id },
                        data: {
                            vintedId: vintedResult.vintedId ?? null,
                            vintedUrl: vintedResult.url ?? null,
                            vintedStatus: 'published',
                        },
                    }).catch(() => null);
                    console.log('[DualPublish] Vinted success for %s', product.id);
                }
                else {
                    errors.push(`Vinted: ${vintedResult.error || 'Unknown error'}`);
                    await prisma_1.default.product.update({
                        where: { id: product.id },
                        data: { vintedStatus: 'error' },
                    }).catch(() => null);
                }
            }
            catch (vintedErr) {
                errors.push(`Vinted: ${vintedErr.message || String(vintedErr)}`);
                await prisma_1.default.product.update({
                    where: { id: product.id },
                    data: { vintedStatus: 'error' },
                }).catch(() => null);
            }
            finally {
                await vinted_service_1.vintedBrowserService.close().catch(() => null);
            }
        }
        const expectedCount = (shouldPublishWallapop ? 1 : 0) + (shouldPublishVinted ? 1 : 0);
        const successCount = (wallapopSuccess ? 1 : 0) + (vintedSuccess ? 1 : 0);
        const overallSuccess = expectedCount > 0 && successCount === expectedCount;
        const partialSuccess = successCount > 0;
        const finalStatus = overallSuccess ? 'published' : (partialSuccess ? 'published' : 'error');
        const finalErrorMessage = errors.length > 0 ? errors.join(' | ') : null;
        await prisma_1.default.product.update({
            where: { id: product.id },
            data: {
                status: finalStatus,
                errorMessage: finalErrorMessage,
            },
        }).catch(() => null);
        return {
            success: partialSuccess,
            error: finalErrorMessage ?? undefined,
        };
    }
    // Публікація ТІЛЬКИ цього одного товару прямо зараз (без черги)
    async publishDirectly(productId, platformOverride) {
        console.log('[DirectPublish] Publishing single product directly (%s): %s', platformOverride || 'all configured', productId);
        const product = await prisma_1.default.product.findUnique({ where: { id: productId } });
        if (!product)
            return { success: false, error: 'Product not found' };
        // Remove from in-memory queue if it was queued
        this.state.items = this.state.items.filter((item) => item.productId !== productId);
        const shouldWallapop = platformOverride
            ? platformOverride === 'wallapop' || platformOverride === 'both'
            : product.publishToWallapop !== false;
        const shouldVinted = platformOverride
            ? platformOverride === 'vinted' || platformOverride === 'both'
            : product.publishToVinted !== false;
        const updateData = {
            status: 'publishing',
            errorMessage: null,
        };
        if (shouldWallapop)
            updateData.wallapopStatus = 'publishing';
        if (shouldVinted)
            updateData.vintedStatus = 'publishing';
        await prisma_1.default.product.update({
            where: { id: productId },
            data: updateData,
        }).catch(() => null);
        this.broadcast();
        const settings = await prisma_1.default.settings.findFirst();
        const headless = settings?.headless ?? true;
        try {
            const result = await this.publishToBothPlatforms(product, headless, platformOverride);
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
    }
    // ── Internal Processing ─────────────────────────────────────────────────────
    async processLoop() {
        try {
            let settings = await prisma_1.default.settings.findFirst();
            const headless = settings?.headless ?? true;
            // Process items one by one
            while (this.state.items.length > 0 && !this.shouldStop) {
                const item = this.state.items[0];
                this.state.currentItem = item.productId;
                this.broadcast();
                let published = false;
                try {
                    published = await this.processItem(item.productId, headless);
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
            this.state.isRunning = false;
            this.isProcessing = false;
            this.shouldStop = false;
            this.state.currentItem = null;
            this.broadcast();
            console.log('[Queue] Processing complete. Done: %d, Failed: %d', this.state.completedCount, this.state.failedCount);
        }
    }
    async processItem(productId, headless = true) {
        const product = await prisma_1.default.product.findUnique({ where: { id: productId } });
        if (!product) {
            console.warn('[Queue] Product %s not found in DB, skipping', productId);
            return false;
        }
        // Skip if already published on enabled platforms
        const wallapopDone = product.publishToWallapop === false || product.wallapopStatus === 'published';
        const vintedDone = product.publishToVinted === false || product.vintedStatus === 'published';
        if (wallapopDone && vintedDone) {
            console.log('[Queue] Product %s is already published on chosen platforms, skipping', productId);
            return false;
        }
        // Mark as publishing
        await prisma_1.default.product.update({
            where: { id: productId },
            data: {
                status: 'publishing',
                wallapopStatus: product.publishToWallapop === false ? null : (product.wallapopStatus === 'published' ? 'published' : 'publishing'),
                vintedStatus: product.publishToVinted === false ? null : (product.vintedStatus === 'published' ? 'published' : 'publishing'),
            },
        }).catch(() => null);
        this.broadcast();
        try {
            const result = await this.publishToBothPlatforms(product, headless);
            if (result.success) {
                this.state.completedCount++;
                return true;
            }
            else {
                this.state.failedCount++;
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
