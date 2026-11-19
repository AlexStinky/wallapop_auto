'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { getProducts, Product } from './api';

export function useProducts() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchProducts = () => getProducts()
    .then(data => { setProducts(data); setLoadError(false); })
    .catch(() => toast.error('Не вдалося завантажити товари', { id: 'products-load' }))
    .finally(() => setLoading(false));

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const data = await getProducts();
        if (!cancelled) {
          setProducts(data);
          setLoadError(false);
        }
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(refresh, 3000);
        }
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  return { products, setProducts, loadError, loading, fetchProducts };
}
