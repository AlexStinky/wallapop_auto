import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { QueueItem, QueueState } from '../types';
import prisma from '../db/prisma';
import { browserService } from './browser.service';

// ─── SSE Broadcaster ─────────────────────────────────────────────────────────

export const queueEvents = new EventEmitter();
queueEvents.setMaxListeners(50);

// ─── Queue Service ────────────────────────────────────────────────────────────

class QueueService {
  private state: QueueState = {
    isRunning: false,
    items: [],
    currentItem: null,
    completedCount: 0,
    failedCount: 0,
  };

  private isProcessing = false;
  private shouldStop = false;

  // ── Public API ──────────────────────────────────────────────────────────────

  getState(): QueueState {
    return { ...this.state, items: [...this.state.items] };
  }

  async loadPendingFromDb(): Promise<number> {
    const products = await prisma.product.findMany({
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
      if (p.status === 'published' || p.wallapopId) continue;

      if (!this.state.items.some((i) => i.productId === p.id)) {
        this.state.items.push({ productId: p.id, addedAt: p.createdAt });
        added++;
      }
      if (p.status !== 'in_queue') {
        await prisma.product.update({
          where: { id: p.id },
          data: { status: 'in_queue', queueOrder: this.state.items.length, errorMessage: null },
        }).catch(() => null);
      }
    }

    // Гарантуємо сортування в черзі строго за часом створення: старі попереду (FIFO)
    const allIds = this.state.items.map((i) => i.productId);
    const allDbProducts = await prisma.product.findMany({
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

  async addToQueue(productId: string): Promise<void> {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return;

    // Prevent duplicates in queue array
    this.state.items = this.state.items.filter((i) => i.productId !== productId);
    this.state.items.push({ productId, addedAt: product.createdAt });

    // Update DB status (reset wallapopId if it was previously published and user wants to republish)
    await prisma.product.update({
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
    const allDbProducts = await prisma.product.findMany({
      where: { id: { in: allIds } },
      select: { id: true, createdAt: true },
    });
    const dateMap = new Map(allDbProducts.map((p) => [p.id, new Date(p.createdAt).getTime()]));
    this.state.items.sort((a, b) => (dateMap.get(a.productId) ?? 0) - (dateMap.get(b.productId) ?? 0));

    this.broadcast();
    console.log('[Queue] Added product %s (queue size: %d, sorted FIFO by createdAt)', productId, this.state.items.length);
  }

  async removeFromQueue(productId: string): Promise<void> {
    this.state.items = this.state.items.filter((i) => i.productId !== productId);

    await prisma.product.update({
      where: { id: productId },
      data: { status: 'pending', queueOrder: null },
    }).catch(() => null);

    this.broadcast();
    console.log('[Queue] Removed product %s', productId);
  }

  async startProcessing(): Promise<void> {
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

  async stopProcessing(): Promise<void> {
    console.log('[Queue] Stop requested');
    this.shouldStop = true;
    this.state.isRunning = false;
    this.broadcast();
  }

  async clearQueue(): Promise<void> {
    // Reset all in-queue products back to pending
    const ids = this.state.items.map((i) => i.productId);
    if (ids.length > 0) {
      await prisma.product.updateMany({
        where: { id: { in: ids }, status: 'in_queue' },
        data: { status: 'pending', queueOrder: null },
      });
    }
    this.state.items = [];
    this.broadcast();
    console.log('[Queue] Queue cleared');
  }

  // Публікація ТІЛЬКИ цього одного товару прямо зараз (без черги)
  async publishDirectly(productId: string): Promise<{ success: boolean; error?: string }> {
    console.log('[DirectPublish] Publishing single product directly: %s', productId);

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) return { success: false, error: 'Product not found' };

    // Remove from in-memory queue if it was queued
    this.state.items = this.state.items.filter((item) => item.productId !== productId);

    await prisma.product.update({
      where: { id: productId },
      data: { status: 'publishing', errorMessage: null },
    }).catch(() => null);
    this.broadcast();

    const settings = await prisma.settings.findFirst();
    const headless = settings?.headless ?? false;
    const cookiesPath = path.join(process.cwd(), '.session-cookies.json');
    const hasCookies = fs.existsSync(cookiesPath);

    if (!hasCookies && (!settings || !settings.wallapopEmail || !settings.wallapopPassword)) {
      const err = 'Потрібна авторизація на Wallapop. Виконайте вхід або імпортуйте cookies у Налаштуваннях.';
      await prisma.product.update({
        where: { id: productId },
        data: { status: 'error', errorMessage: err },
      }).catch(() => null);
      this.broadcast();
      return { success: false, error: err };
    }

    try {
      await browserService.initialize(headless);
      const alreadyIn = await browserService.isLoggedIn();
      if (!alreadyIn) {
        if (settings?.wallapopEmail && settings?.wallapopPassword) {
          const ok = await browserService.login(settings.wallapopEmail, settings.wallapopPassword);
          if (!ok) {
            const err = 'Помилка авторизації на Wallapop. Перевірте облікові дані або імпортуйте cookies.';
            await prisma.product.update({
              where: { id: productId },
              data: { status: 'error', errorMessage: err },
            }).catch(() => null);
            this.broadcast();
            return { success: false, error: err };
          }
        } else {
          const err = 'Потрібна авторизація на Wallapop. Виконайте вхід або імпортуйте cookies у Налаштуваннях.';
          await prisma.product.update({
            where: { id: productId },
            data: { status: 'error', errorMessage: err },
          }).catch(() => null);
          this.broadcast();
          return { success: false, error: err };
        }
      }

      const result = await browserService.publishProduct(product);
      if (result.success) {
        await prisma.product.update({
          where: { id: productId },
          data: {
            status: 'published',
            wallapopId: result.wallapopId ?? null,
            wallapopUrl: result.url ?? null,
            errorMessage: null,
          },
        });
        console.log('[DirectPublish] Product %s published successfully', productId);
      } else {
        await prisma.product.update({
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
    } catch (err: any) {
      const msg = err?.message || String(err);
      await prisma.product.update({
        where: { id: productId },
        data: { status: 'error', errorMessage: msg },
      }).catch(() => null);
      this.broadcast();
      return { success: false, error: msg };
    } finally {
      // Закриваємо браузер тільки якщо черга зараз не працює у фоні
      if (!this.state.isRunning) {
        await browserService.close().catch(() => null);
      }
    }
  }

  // ── Internal Processing ─────────────────────────────────────────────────────

  private async processLoop(): Promise<void> {
    try {
      // Load settings once
      let settings = await prisma.settings.findFirst();

      if (!settings || !settings.wallapopEmail || !settings.wallapopPassword) {
        console.error('[Queue] No credentials configured');
        return;
      }

      // Initialize browser
      try {
        await browserService.initialize(settings.headless);

        const alreadyIn = await browserService.isLoggedIn();
        if (!alreadyIn) {
          const ok = await browserService.login(settings.wallapopEmail, settings.wallapopPassword);
          if (!ok) {
            console.error('[Queue] Login failed, aborting queue');
            return;
          }
        }
      } catch (err) {
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
        } catch (err) {
          console.error('[Queue] Error processing item %s:', item.productId, err);
        }

        // Remove from queue after processing (success or error)
        this.state.items.shift();
        this.state.currentItem = null;
        this.broadcast();

        // If more items remain and an item was actually published, wait delay before next item
        if (published && this.state.items.length > 0 && !this.shouldStop) {
          settings = await prisma.settings.findFirst();
          const delay = (settings?.publishDelay ?? 10) * 1000;
          console.log('[Queue] Waiting %ds before next item (%d items remaining)', delay / 1000, this.state.items.length);
          await this.sleep(delay);
        }
      }
    } finally {
      // Cleanup browser and reset running state
      await browserService.close().catch(() => null);
      this.state.isRunning = false;
      this.isProcessing = false;
      this.shouldStop = false;
      this.state.currentItem = null;
      this.broadcast();
      console.log('[Queue] Processing complete. Done: %d, Failed: %d', this.state.completedCount, this.state.failedCount);
    }
  }

  private async processItem(productId: string): Promise<boolean> {
    const product = await prisma.product.findUnique({ where: { id: productId } });
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
    await prisma.product.update({
      where: { id: productId },
      data: { status: 'publishing' },
    }).catch(() => null);

    this.broadcast();

    try {
      const result = await browserService.publishProduct(product);

      if (result.success) {
        await prisma.product.update({
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
      } else {
        await prisma.product.update({
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.product.update({
        where: { id: productId },
        data: { status: 'error', errorMessage: message },
      }).catch(() => null);
      this.state.failedCount++;
      console.error('[Queue] Unexpected error for product %s: %s', productId, message);
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private broadcast(): void {
    queueEvents.emit('state', this.getState());
  }
}

export const queueService = new QueueService();
export default queueService;
