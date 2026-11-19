'use client';

import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { getApiErrorMessage, getProduct, Product, publishProductNow } from './api';

export function usePublication(onProduct: (product: Product) => void, scope?: string) {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout> | null>());
  const [busy, setBusy] = useState<string[]>([]);
  useEffect(() => {
    const jobs = timers.current;
    return () => {
      jobs.forEach(timer => { if (timer !== null) clearTimeout(timer); });
      jobs.clear();
    };
  }, [scope]);

  async function publish(id: string, platform?: 'wallapop' | 'vinted' | 'both') {
    const jobs = timers.current;
    if (jobs.has(id)) return;
    jobs.set(id, null);
    setBusy(previous => [...previous, id]);
    function finish() {
      jobs.delete(id);
      setBusy(previous => previous.filter(item => item !== id));
    }
    try {
      const result = await publishProductNow(id, platform);
      if (!jobs.has(id)) return;
      toast.success(result.message);
    } catch (err) {
      if (jobs.has(id)) {
        toast.error(getApiErrorMessage(err, 'Помилка при публікації'));
        finish();
      }
      return;
    }

    async function refresh() {
      try {
        const product = await getProduct(id);
        if (!jobs.has(id)) return;
        onProduct(product);
        const status = platform === 'vinted' ? product.vintedStatus :
          platform === 'wallapop' ? product.wallapopStatus : product.status;
        if (status === 'published' || status === 'error') {
          if (status === 'published') toast.success('Товар успішно опубліковано!');
          else toast.error(product.errorMessage || 'Помилка публікації');
          finish();
          return;
        }
      } catch (err) {
        if (jobs.has(id)) {
          toast.error(getApiErrorMessage(err, 'Не вдалося перевірити стан публікації'));
          finish();
        }
        return;
      }
      jobs.set(id, setTimeout(refresh, 2000));
    }
    await refresh();
  }

  return { publish, busy };
}
