import { EventEmitter } from 'events';
import prisma from '../db/prisma';
import { vintedBrowserService } from './vinted.service';
import { setPublicationState } from './publication-state';

export const vintedQueueEvents = new EventEmitter();
vintedQueueEvents.setMaxListeners(50);

export interface VintedQueueState {
  isRunning: boolean;
  queue: string[];
  currentProductId: string | null;
  completedCount: number;
  failedCount: number;
  lastPublishedAt: number;
  nextAllowedInSeconds: number;
}

class VintedQueueService {
  private adding = new Map<string, Promise<number>>();
  private queue: string[] = [];
  private isProcessing = false;
  private currentProductId: string | null = null;
  private completedCount = 0;
  private failedCount = 0;
  private lastPublishedAt = 0;
  private readonly MIN_INTERVAL_MS = 60_000; // 60 секунд (1 хвилина) між публікаціями

  getState(): VintedQueueState {
    const elapsed = Date.now() - this.lastPublishedAt;
    const remainingMs =
      this.lastPublishedAt > 0 && elapsed < this.MIN_INTERVAL_MS ? this.MIN_INTERVAL_MS - elapsed : 0;
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

  async loadPendingFromDb(): Promise<number> {
    const products = await prisma.product.findMany({
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

  async enqueue(productId: string): Promise<{ position: number; estimatedWaitSeconds: number }> {
    let idx = this.queue.indexOf(productId);
    if (idx === -1) {
      let addition = this.adding.get(productId);
      if (!addition) {
        addition = setPublicationState(productId, 'vinted', 'in_queue')
          .then(() => this.queue.push(productId) - 1)
          .finally(() => this.adding.delete(productId));
        this.adding.set(productId, addition);
      }
      idx = await addition;
    }

    const position = idx + 1;
    const elapsed = Date.now() - this.lastPublishedAt;
    const currentWait =
      this.lastPublishedAt > 0 && elapsed < this.MIN_INTERVAL_MS ? (this.MIN_INTERVAL_MS - elapsed) / 1000 : 0;
    const estimatedWaitSeconds = Math.ceil(currentWait + (position - 1) * 60);

    console.log(
      '[VintedQueue] Enqueued product %s (pos: %d, estimated wait: %ds)',
      productId,
      position,
      estimatedWaitSeconds
    );

    this.broadcast();
    this.startProcessing();

    return { position, estimatedWaitSeconds };
  }

  async enqueueMany(productIds: string[]): Promise<number> {
    let count = 0;
    for (const id of productIds) {
      try {
        await this.enqueue(id);
        count++;
      } catch {}
    }
    return count;
  }

  private startProcessing(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.broadcast();

    this.processLoop().catch((err) => {
      console.error('[VintedQueue] processLoop error:', err);
      this.isProcessing = false;
      this.broadcast();
    });
  }

  private async processLoop(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const productId = this.queue[0];
        this.currentProductId = productId;
        this.broadcast();

        // 1. Дотримання ліміту: не частіше ніж 1 раз на хвилину (60 000 мс)
        const elapsed = Date.now() - this.lastPublishedAt;
        if (this.lastPublishedAt > 0 && elapsed < this.MIN_INTERVAL_MS) {
          const waitMs = this.MIN_INTERVAL_MS - elapsed;
          console.log(
            '[VintedQueue] Rate limit: waiting %ds before publishing item %s...',
            Math.ceil(waitMs / 1000),
            productId
          );
          await this.sleep(waitMs);
        }

        // 2. Публікація товару
        console.log(
          '[VintedQueue] Starting publication for product %s (%d remaining in queue)',
          productId,
          this.queue.length - 1
        );
        try {
          await this.processItem(productId);
        } catch (error) {
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
    } finally {
      this.isProcessing = false;
      this.currentProductId = null;
      this.broadcast();
      console.log(
        '[VintedQueue] Queue finished. Completed: %d, Failed: %d',
        this.completedCount,
        this.failedCount
      );
    }
  }

  private async processItem(productId: string): Promise<boolean> {
    const product = await setPublicationState(productId, 'vinted', 'publishing');
    this.broadcast();
    let result;
    try {
      const settings = await prisma.settings.findFirst();
      const headless = settings?.headless ?? true;
      await vintedBrowserService.initialize(headless);
      const isVintedLoggedIn = await vintedBrowserService.isLoggedIn();
      if (!isVintedLoggedIn) {
        if (settings?.vintedEmail && settings?.vintedPassword) {
          await vintedBrowserService.login(settings.vintedEmail, settings.vintedPassword);
        }
      }

      result = await vintedBrowserService.publishProduct(product);
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await vintedBrowserService.close().catch(() => undefined);
    }

    if (result.success) {
      await setPublicationState(productId, 'vinted', 'published', {
        listingId: result.vintedId ?? null, url: result.url ?? null,
      });
      this.completedCount++;
    } else {
      const message = 'Vinted: ' + (result.error || 'Unknown error');
      await setPublicationState(productId, 'vinted', 'error', { errorMessage: message });
      this.failedCount++;
    }
    return result.success;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private broadcast(): void {
    vintedQueueEvents.emit('state', this.getState());
  }
}

export const vintedQueueService = new VintedQueueService();
export default vintedQueueService;
