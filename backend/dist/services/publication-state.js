"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.restorePublishedProducts = restorePublishedProducts;
exports.setPublicationState = setPublicationState;
const prisma_1 = __importDefault(require("../db/prisma"));
async function restorePublishedProducts() {
    await prisma_1.default.product.updateMany({
        where: {
            status: 'pending',
            AND: [
                {
                    OR: [
                        { wallapopStatus: 'published' },
                        { vintedStatus: 'published' },
                        { wallapopId: { isSet: true, not: null, notIn: [''] } },
                        { vintedId: { isSet: true, not: null, notIn: [''] } },
                    ],
                },
                ...['wallapopStatus', 'vintedStatus'].map(field => ({
                    OR: [
                        { [field]: { in: ['pending', 'published'] } },
                        { [field]: null },
                        { [field]: { isSet: false } },
                    ],
                })),
            ],
        },
        data: { status: 'published' },
    });
}
// Commit the platform result and the overall status together. The other worker
// may finish the same product at the same time.
async function setPublicationState(id, platform, state, details = {}) {
    const other = platform === 'wallapop' ? 'vinted' : 'wallapop';
    const otherStatus = other === 'wallapop' ? 'wallapopStatus' : 'vintedStatus';
    for (let attempt = 0;; attempt++) {
        const product = await prisma_1.default.product.findUniqueOrThrow({ where: { id } });
        const sibling = product[otherStatus];
        const otherEnabled = other === 'wallapop' ? product.publishToWallapop : product.publishToVinted;
        const states = [state];
        if (otherEnabled || sibling === 'publishing' || sibling === 'in_queue') {
            const priorListing = other === 'wallapop' ? product.wallapopId : product.vintedId;
            states.push(priorListing && (!sibling || sibling === 'pending') ? 'published' : sibling ?? 'pending');
        }
        const status = ['publishing', 'in_queue', 'error', 'published'].find(s => states.includes(s))
            ?? 'pending';
        // Match the sibling state as well as the timestamp: two writes can share a
        // millisecond. MongoDB records created before the status field have it unset.
        const matchesSibling = [{ [otherStatus]: sibling }];
        if (sibling === 'pending' || sibling === null)
            matchesSibling.push({ [otherStatus]: { isSet: false } });
        const { count } = await prisma_1.default.product.updateMany({
            where: { id, updatedAt: product.updatedAt, OR: matchesSibling },
            data: {
                [platform + 'Status']: state,
                [platform + 'Url']: details.url,
                [platform + 'Id']: details.listingId,
                queueOrder: details.queueOrder,
                errorMessage: details.errorMessage ?? (states.includes('error') ? product.errorMessage : null),
                status,
            },
        });
        if (count === 1)
            return prisma_1.default.product.findUniqueOrThrow({ where: { id } });
        if (attempt >= 4)
            throw new Error('Product changed repeatedly while updating ' + platform + ' status');
    }
}
