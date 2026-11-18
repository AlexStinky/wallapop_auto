import { EventEmitter } from 'events';
import prisma from '../db/prisma';
import { vintedBrowserService } from './vinted.service';

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
  private queue: string[] = [];
  private isProcessing = false;
  private currentProductId: string | null = null;
  private completedCount = 0;
  private failedCount = 0;
  private lastPublishedAt = 0;
  private readonly MIN_INTERVAL_MS = 60_000; // 60 секунд (1 хвилина) між публікаціями

  constructor() {
    // Автоматично відновлюємо незавершені публікації з БД при запуску
    setTimeout(() => {
      this.loadPendingFromDb().catch((err) => {
        console.error('[VintedQueue] Error loading pending items from DB:', err);
      });
    }, 3000);
  }

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

  async enqueue(productId: string): Promise<{ position: number; estimatedWaitSeconds: number }> {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new Error(`Product ${productId} not found`);
    }

    // Оновлюємо статус товару в БД
    await prisma.product
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
        await this.processItem(productId);

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
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      console.warn('[VintedQueue] Product %s not found in DB, skipping', productId);
      return false;
    }

    if (product.vintedStatus === 'published' && product.vintedUrl) {
      console.log('[VintedQueue] Product %s is already published on Vinted, skipping', productId);
      return true;
    }

    // Переводимо у стан публікації
    await prisma.product
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

    const settings = await prisma.settings.findFirst();
    const headless = settings?.headless ?? true;

    try {
      await vintedBrowserService.initialize(headless);
      const isVintedLoggedIn = await vintedBrowserService.isLoggedIn();
      if (!isVintedLoggedIn) {
        if (settings?.vintedEmail && settings?.vintedPassword) {
          await vintedBrowserService.login(settings.vintedEmail, settings.vintedPassword);
        }
      }

      const result = await vintedBrowserService.publishProduct(product);
      if (result.success) {
        this.completedCount++;
        const currentProd = await prisma.product.findUnique({ where: { id: productId } });
        const wallapopDone =
          !currentProd?.publishToWallapop || currentProd?.wallapopStatus === 'published';

        await prisma.product
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
      } else {
        this.failedCount++;
        const errMsg = `Vinted: ${result.error || 'Unknown error'}`;
        await prisma.product
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
    } catch (err: any) {
      this.failedCount++;
      const msg = `Vinted: ${err?.message || String(err)}`;
      await prisma.product
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
    } finally {
      await vintedBrowserService.close().catch(() => null);
    }
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
