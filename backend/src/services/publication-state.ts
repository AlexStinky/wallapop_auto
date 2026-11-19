import { Prisma } from '@prisma/client';
import prisma from '../db/prisma';
import { ProductStatus } from '../types';

type Platform = 'wallapop' | 'vinted';

// Commit the platform result and the overall status together. The other worker
// may finish the same product at the same time.
export async function setPublicationState(
  id: string,
  platform: Platform,
  state: ProductStatus,
  details: { errorMessage?: string; url?: string | null; listingId?: string | null; queueOrder?: number | null } = {}
) {
  const other = platform === 'wallapop' ? 'vinted' : 'wallapop';
  const otherStatus = other === 'wallapop' ? 'wallapopStatus' : 'vintedStatus';
  for (let attempt = 0; ; attempt++) {
    const product = await prisma.product.findUniqueOrThrow({ where: { id } });
    const sibling = product[otherStatus];
    const otherEnabled = other === 'wallapop' ? product.publishToWallapop : product.publishToVinted;
    const states: string[] = [state];
    if (otherEnabled || sibling === 'publishing' || sibling === 'in_queue') {
      const priorListing = other === 'wallapop' ? product.wallapopId : product.vintedId;
      states.push(priorListing && (!sibling || sibling === 'pending') ? 'published' : sibling ?? 'pending');
    }
    const status = (['publishing', 'in_queue', 'error'] as const).find(s => states.includes(s))
      ?? (states.every(s => s === 'published') ? 'published' : 'pending');

    // Match the sibling state as well as the timestamp: two writes can share a
    // millisecond. MongoDB records created before the status field have it unset.
    const matchesSibling: Prisma.ProductWhereInput[] = [{ [otherStatus]: sibling }];
    if (sibling === 'pending' || sibling === null) matchesSibling.push({ [otherStatus]: { isSet: false } });
    const { count } = await prisma.product.updateMany({
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
    if (count === 1) return prisma.product.findUniqueOrThrow({ where: { id } });
    if (attempt >= 4) throw new Error('Product changed repeatedly while updating ' + platform + ' status');
  }
}
