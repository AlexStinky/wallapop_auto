'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Package, RefreshCw, Search, X, Send } from 'lucide-react';
import { Product, ProductStatus, getProducts, publishProductNow, publishAllProducts, deleteProduct } from '@/lib/api';
import { ProductCard } from '@/components/ui/ProductCard';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/utils';
import toast from 'react-hot-toast';

type FilterTab = 'all' | 'pending' | 'published' | 'error';

const filterTabs: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'Всі' },
  { key: 'pending', label: 'Очікують' },
  { key: 'published', label: 'Опубліковано' },
  { key: 'error', label: 'Помилка' },
];

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [publishingAll, setPublishingAll] = useState(false);

  const fetchProducts = async () => {
    setLoading(true);
    try {
      const data = await getProducts();
      setProducts(data);
    } catch {
      toast.error('Не вдалося завантажити товари');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts();
    const interval = setInterval(fetchProducts, 3000);
    return () => clearInterval(interval);
  }, []);

  const handlePublishAll = async () => {
    setPublishingAll(true);
    try {
      const res = await publishAllProducts();
      toast.success(res.message || 'Всі товари додано до черги');
      await fetchProducts();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Помилка при запуску черги');
    } finally {
      setPublishingAll(false);
    }
  };

  const handlePublish = async (id: string) => {
    setPublishingId(id);
    try {
      await publishProductNow(id);
      toast.success('Публікацію запущено!');
      await fetchProducts();

      // Poll until product finishes publishing
      let attempts = 0;
      const pollTimer = setInterval(async () => {
        attempts++;
        try {
          const freshProducts = await getProducts();
          setProducts(freshProducts);
          const current = freshProducts.find((p) => p.id === id);
          if (current && current.status !== 'publishing') {
            clearInterval(pollTimer);
            setPublishingId(null);
            if (current.status === 'published') {
              toast.success('Товар успішно опубліковано на Wallapop!');
            } else if (current.status === 'error') {
              toast.error(current.errorMessage || 'Помилка публікації на Wallapop', { duration: 6000 });
            }
          }
        } catch (_) {}
        if (attempts >= 60) {
          clearInterval(pollTimer);
          setPublishingId(null);
        }
      }, 2000);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Помилка при публікації');
      setPublishingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProduct(id);
      toast.success('Товар видалено');
      setProducts((prev) => prev.filter((p) => p.id !== id));
    } catch {
      toast.error('Помилка при видаленні');
    }
  };

  const filtered = products.filter((p) => {
    const matchesTab =
      activeTab === 'all'
        ? true
        : activeTab === 'pending'
        ? p.status === 'pending' || p.status === 'in_queue'
        : (p.status as ProductStatus) === activeTab;
    const matchesSearch =
      search.trim() === '' ||
      p.title.toLowerCase().includes(search.toLowerCase()) ||
      p.category.toLowerCase().includes(search.toLowerCase());
    return matchesTab && matchesSearch;
  });

  return (
    <div className="flex flex-col gap-4 px-4 py-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Мої товари</h1>
        <div className="flex items-center gap-2">
          {products.some((p) => p.status === 'pending' || p.status === 'in_queue') && (
            <Button
              variant="primary"
              size="sm"
              onClick={handlePublishAll}
              loading={publishingAll}
              className="text-xs"
            >
              <Send size={13} />
              Опублікувати всі
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchProducts}
            loading={loading}
            className="h-9 w-9 rounded-xl p-0"
          >
            <RefreshCw size={16} />
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Пошук товарів..."
          className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-9 text-sm text-gray-900 placeholder-gray-400 focus:border-[#00C9A7] focus:outline-none focus:ring-2 focus:ring-[#00C9A7]/20"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        {filterTabs.map(({ key, label }) => {
          const count =
            key === 'all'
              ? products.length
              : key === 'pending'
              ? products.filter((p) => p.status === 'pending' || p.status === 'in_queue').length
              : products.filter((p) => p.status === key).length;
          return (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={cn(
                'flex flex-shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                activeTab === key
                  ? 'bg-[#00C9A7] text-white'
                  : 'bg-white text-gray-500 hover:bg-gray-50 border border-gray-200'
              )}
            >
              {label}
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                  activeTab === key ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Product list */}
      {loading ? (
        <div className="flex flex-col gap-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl bg-white" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-10 text-center">
          <Package size={36} className="mb-2 text-gray-200" />
          <p className="text-sm font-medium text-gray-500">
            {search ? 'Нічого не знайдено' : 'Немає товарів'}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            {search ? 'Спробуйте змінити пошук' : 'Натисніть + щоб додати товар'}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              onPublish={handlePublish}
              onDelete={handleDelete}
              loading={publishingId === product.id}
            />
          ))}
        </div>
      )}

      {/* FAB */}
      <Link href="/products/new" className="fixed bottom-20 right-4 z-40">
        <button className="flex h-14 w-14 items-center justify-center rounded-full bg-[#00C9A7] shadow-lg shadow-[#00C9A7]/30 transition-transform active:scale-95 hover:bg-[#00b396]">
          <Plus size={24} className="text-white" strokeWidth={2.5} />
        </button>
      </Link>
    </div>
  );
}
