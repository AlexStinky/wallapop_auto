export type ProductStatus = 'pending' | 'in_queue' | 'publishing' | 'published' | 'error';

export interface QueueItem {
  productId: string;
  addedAt: Date;
}

export interface QueueState {
  isRunning: boolean;
  items: QueueItem[];
  currentItem: string | null;
  completedCount: number;
  failedCount: number;
}

export interface PublishResult {
  success: boolean;
  wallapopId?: string;
  url?: string;
  error?: string;
}
