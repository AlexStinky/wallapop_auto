import { Router, Request, Response, NextFunction } from 'express';
import { queueService, queueEvents } from '../services/queue.service';
import { createError } from '../middleware/error';

const router = Router();

function formatQueueState(state: ReturnType<typeof queueService.getState>) {
  return {
    ...state,
    pending: state.items.length,
    processing: state.currentItem,
    completed: state.completedCount,
    failed: state.failedCount,
  };
}

// GET /api/queue — return current queue state
router.get('/', (_req: Request, res: Response) => {
  res.json(formatQueueState(queueService.getState()));
});

// POST /api/queue/start — begin processing
router.post('/start', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let state = queueService.getState();
    if (state.items.length === 0) {
      await queueService.loadPendingFromDb();
      state = queueService.getState();
    }
    if (state.items.length === 0) {
      throw createError('Немає товарів для публікації. Додайте новий товар або оберіть повторну публікацію.', 400);
    }
    await queueService.startProcessing();
    const updated = formatQueueState(queueService.getState());
    res.json({ message: 'Queue processing started', state: updated, ...updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/queue/stop — stop processing after current item
router.post('/stop', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await queueService.stopProcessing();
    const updated = formatQueueState(queueService.getState());
    res.json({ message: 'Queue processing will stop after current item', state: updated, ...updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/queue/clear — clear all pending items
router.delete('/clear', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await queueService.clearQueue();
    res.json({ message: 'Queue cleared', state: queueService.getState() });
  } catch (err) {
    next(err);
  }
});

// GET /api/queue/status — SSE endpoint for real-time updates
router.get('/status', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.flushHeaders();

  // Send initial state immediately
  sendSSE(res, queueService.getState());

  // Subscribe to updates
  const onState = (state: unknown) => {
    sendSSE(res, state);
  };

  queueEvents.on('state', onState);

  // Heartbeat every 25 seconds to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    queueEvents.off('state', onState);
  });
});

function sendSSE(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export default router;
