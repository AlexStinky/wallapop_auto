'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Package, CheckCircle, AlertCircle, Clock, RefreshCw } from 'lucide-react';
import { Product, getProducts, publishProductNow, deleteProduct } from '@/lib/api';
import { QueueStatus } from '@/components/ui/QueueStatus';
import { ProductCard } from '@/components/ui/ProductCard';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import toast from 'react-hot-toast';

export default function DashboardPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishingId, setPublishingId] = useState<string | null>(null);

  const fetchProducts = async () => {
    try {
      const data = await getProducts();
      setProducts(data);
    } catch {
      // Backend not running; show empty state
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts();
    const interval = setInterval(fetchProducts, 3000);
    return () => clearInterval(interval);
  }, []);

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

  const total = products.length;
  const published = products.filter((p) => p.status === 'published').length;
  const errors = products.filter((p) => p.status === 'error').length;
  const pending = products.filter((p) => p.status === 'pending').length;

  const stats = [
    { label: 'Всього', value: total, icon: Package, color: 'bg-blue-50 text-blue-600' },
    { label: 'Опубліковано', value: published, icon: CheckCircle, color: 'bg-green-50 text-green-600' },
    { label: 'Помилки', value: errors, icon: AlertCircle, color: 'bg-red-50 text-red-500' },
    { label: 'Очікують', value: pending, icon: Clock, color: 'bg-amber-50 text-amber-600' },
  ];

  const recentProducts = products.slice(0, 5);

  return (
    <div className="flex flex-col gap-4 px-4 py-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Панель керування</h1>
          <p className="text-xs text-gray-400">Wallapop Автопублікатор</p>
        </div>
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

      {/* Queue Status */}
      <QueueStatus />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3">
        {stats.map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="flex items-center gap-3">
            <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${color}`}>
              <Icon size={18} />
            </div>
            <div>
              <p className="text-xl font-bold text-gray-900">{value}</p>
              <p className="text-xs text-gray-500">{label}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* Recent Products */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Останні товари</h2>
          <Link
            href="/products"
            className="flex items-center gap-0.5 text-xs font-medium text-[#00C9A7] hover:underline"
          >
            Переглянути всі
            <ChevronRight size={14} />
          </Link>
        </div>

        {loading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-2xl bg-white" />
            ))}
          </div>
        ) : recentProducts.length === 0 ? (
          <Card className="flex flex-col items-center justify-center py-8 text-center">
            <Package size={32} className="mb-2 text-gray-200" />
            <p className="text-sm font-medium text-gray-500">Немає товарів</p>
            <p className="mt-1 text-xs text-gray-400">Додайте перший товар</p>
            <Link href="/products/new" className="mt-3">
              <Button size="sm">Додати товар</Button>
            </Link>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {recentProducts.map((product) => (
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
      </div>
    </div>
  );
}
