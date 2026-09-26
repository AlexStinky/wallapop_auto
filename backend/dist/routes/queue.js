"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const queue_service_1 = require("../services/queue.service");
const error_1 = require("../middleware/error");
const router = (0, express_1.Router)();
function formatQueueState(state) {
    return {
        ...state,
        pending: state.items.length,
        processing: state.currentItem,
        completed: state.completedCount,
        failed: state.failedCount,
    };
}
// GET /api/queue — return current queue state
router.get('/', (_req, res) => {
    res.json(formatQueueState(queue_service_1.queueService.getState()));
});
// POST /api/queue/start — begin processing
router.post('/start', async (_req, res, next) => {
    try {
        let state = queue_service_1.queueService.getState();
        if (state.items.length === 0) {
            await queue_service_1.queueService.loadPendingFromDb();
            state = queue_service_1.queueService.getState();
        }
        if (state.items.length === 0) {
            throw (0, error_1.createError)('Немає товарів для публікації. Додайте новий товар або оберіть повторну публікацію.', 400);
        }
        await queue_service_1.queueService.startProcessing();
        const updated = formatQueueState(queue_service_1.queueService.getState());
        res.json({ message: 'Queue processing started', state: updated, ...updated });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/queue/stop — stop processing after current item
router.post('/stop', async (_req, res, next) => {
    try {
        await queue_service_1.queueService.stopProcessing();
        const updated = formatQueueState(queue_service_1.queueService.getState());
        res.json({ message: 'Queue processing will stop after current item', state: updated, ...updated });
    }
    catch (err) {
        next(err);
    }
});
// DELETE /api/queue/clear — clear all pending items
router.delete('/clear', async (_req, res, next) => {
    try {
        await queue_service_1.queueService.clearQueue();
        res.json({ message: 'Queue cleared', state: queue_service_1.queueService.getState() });
    }
    catch (err) {
        next(err);
    }
});
// GET /api/queue/status — SSE endpoint for real-time updates
router.get('/status', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
    res.flushHeaders();
    // Send initial state immediately
    sendSSE(res, queue_service_1.queueService.getState());
    // Subscribe to updates
    const onState = (state) => {
        sendSSE(res, state);
    };
    queue_service_1.queueEvents.on('state', onState);
    // Heartbeat every 25 seconds to keep connection alive through proxies
    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
    }, 25000);
    req.on('close', () => {
        clearInterval(heartbeat);
        queue_service_1.queueEvents.off('state', onState);
    });
});
function sendSSE(res, data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}
exports.default = router;
