import { EventEmitter } from 'events';
import { QueueItem, QueueState } from '../types';
import prisma from '../db/prisma';
import { browserService } from './browser.service';
import { setPublicationState } from './publication-state';

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

  private adding = new Map<string, Promise<void>>();
  private active = new Map<string, Promise<boolean>>();
  private browserAvailable: Promise<unknown> = Promise.resolve();

  // ── Public API ──────────────────────────────────────────────────────────────

  getState(): QueueState {
    return { ...this.state, items: [...this.state.items] };
  }

  async loadPendingFromDb(): Promise<number> {
    const products = await prisma.product.findMany({
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

  async addToQueue(productId: string): Promise<void> {
    if (this.active.has(productId) || this.state.items.some(i => i.productId === productId)) return;
    const pending = this.adding.get(productId);
    if (pending) return pending;
    const addition = this.insertItem(productId);
    this.adding.set(productId, addition);
    try {
      await addition;
    } finally {
      this.adding.delete(productId);
    }
  }

  private async insertItem(productId: string): Promise<void> {
    const product = await setPublicationState(productId, 'wallapop', 'in_queue', {
      queueOrder: this.state.items.length + 1,
    });
    if (!this.active.has(productId) && !this.state.items.some(i => i.productId === productId)) {
      this.state.items.push({ productId, addedAt: product.createdAt });
      this.state.items.sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime());
      this.broadcast();
    }
  }

  async removeFromQueue(productId: string): Promise<void> {
    const queued = this.state.items.some(item => item.productId === productId);
    if (queued && !this.active.has(productId)) {
      await setPublicationState(productId, 'wallapop', 'pending', { queueOrder: null });
    }
    this.state.items = this.state.items.filter(i => i.productId !== productId);
    this.broadcast();
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

    if (this.isProcessing) return;
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
    for (const item of [...this.state.items]) {
      if (item.productId !== this.state.currentItem) await this.removeFromQueue(item.productId);
    }
  }

  async publishNow(productId: string): Promise<void> {
    await this.addToQueue(productId);
    this.publishDirectly(productId).catch(error => console.error('[Wallapop] Publication failed', productId, error));
  }

  private async publishDirectly(productId: string): Promise<boolean> {
    const running = this.active.get(productId);
    if (running) return running;

    const publication = this.browserAvailable.then(() => this.publishWallapop(productId));
    this.active.set(productId, publication);
    this.browserAvailable = publication.catch(() => undefined);
    try {
      return await publication;
    } finally {
      this.active.delete(productId);
      this.state.items = this.state.items.filter(i => i.productId !== productId);
      this.broadcast();
    }
  }

  private async publishWallapop(productId: string): Promise<boolean> {
    const product = await setPublicationState(productId, 'wallapop', 'publishing', { queueOrder: null });
    let result;
    try {
      const settings = await prisma.settings.findFirst();
      await browserService.initialize(settings?.headless ?? true);
      if (!(await browserService.isLoggedIn()) && settings?.wallapopEmail && settings.wallapopPassword) {
        await browserService.login(settings.wallapopEmail, settings.wallapopPassword);
      }
      result = await browserService.publishProduct(product);
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await browserService.close().catch(() => undefined);
    }
    if (result.success) {
      await setPublicationState(productId, 'wallapop', 'published', {
        listingId: result.wallapopId ?? null, url: result.url ?? null,
      });
    } else {
      await setPublicationState(productId, 'wallapop', 'error', {
        errorMessage: 'Wallapop: ' + (result.error || 'Unknown error'),
      });
    }
    return result.success;
  }

  // ── Internal Processing ─────────────────────────────────────────────────────

  private async processLoop(): Promise<void> {
    try {
      // Process items one by one
      while (this.state.items.length > 0 && !this.shouldStop) {
        const item = this.state.items[0];
        this.state.currentItem = item.productId;
        this.broadcast();

        let published = false;
        try {
          published = await this.publishDirectly(item.productId);
        } catch (err) {
          console.error('[Queue] Error processing item %s:', item.productId, err);
        }

        if (published) this.state.completedCount++;
        else this.state.failedCount++;
        this.state.currentItem = null;
        this.broadcast();

        // If more items remain and an item was actually published, wait delay before next item
        if (published && this.state.items.length > 0 && !this.shouldStop) {
          const settings = await prisma.settings.findFirst();
          const delay = (settings?.publishDelay ?? 10) * 1000;
          console.log('[Queue] Waiting %ds before next item (%d items remaining)', delay / 1000, this.state.items.length);
          await this.sleep(delay);
        }
      }
    } finally {
      this.state.isRunning = false;
      this.isProcessing = false;
      this.shouldStop = false;
      this.state.currentItem = null;
      this.broadcast();
      console.log('[Queue] Processing complete. Done: %d, Failed: %d', this.state.completedCount, this.state.failedCount);
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
