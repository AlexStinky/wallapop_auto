'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ArrowLeft, Edit, Send, Trash2, ExternalLink, AlertCircle, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { Product, getProduct, publishProductNow, deleteProduct, getImageUrl } from '@/lib/api';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatDate, getStatusLabel } from '@/lib/utils';
import Link from 'next/link';
import toast from 'react-hot-toast';

const conditionLabels: Record<string, string> = {
  new: 'Новий (Nunca se ha usado)',
  used_like_new: 'Як новий (Como nuevo)',
  used_good: 'Хороший стан (En buen estado)',
  used_fair: 'Задовільний стан (Aceptable)',
  poor: 'Для ремонту / деталей (Para piezas)',
};

const categoryLabels: Record<string, string> = {
  'Motos': 'Motos',
  'Motor y accesorios': 'Motor y accesorios',
  'Moda y accesorios': 'Moda y accesorios',
  'Tecnología y electrónica': 'Tecnología y electrónica',
  'Deporte y ocio': 'Deporte y ocio',
  'Bicicletas': 'Bicicletas',
  'Hogar y jardín': 'Hogar y jardín',
  'Electrodomésticos': 'Electrodomésticos',
  'Cine, libros y música': 'Cine, libros y música',
  'Niños y bebés': 'Niños y bebés',
  'Coleccionismo': 'Coleccionismo',
  'Construcción y reformas': 'Construcción y reformas',
  'Industria y agricultura': 'Industria y agricultura',
  'Otros': 'Otros',
  phones: 'Tecnología y electrónica',
  clothing: 'Moda y accesorios',
  shoes: 'Moda y accesorios',
  electronics: 'Tecnología y electrónica',
  furniture: 'Hogar y jardín',
  cars: 'Motor y accesorios',
  sports: 'Deporte y ocio',
  toys: 'Niños y bebés',
  books: 'Cine, libros y música',
  other: 'Otros',
};

export default function ProductDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [currentImage, setCurrentImage] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const fetch = async () => {
      try {
        const data = await getProduct(id);
        setProduct(data);
      } catch {
        toast.error('Товар не знайдено');
        router.back();
      } finally {
        setLoading(false);
      }
    };
    fetch();
  }, [id, router]);

  const handlePublish = async () => {
    if (!product) return;
    setPublishing(true);
    try {
      await publishProductNow(product.id);
      toast.success('Публікацію запущено!');
      const updated = await getProduct(id);
      setProduct(updated);

      // Poll until product finishes publishing
      let attempts = 0;
      const pollTimer = setInterval(async () => {
        attempts++;
        try {
          const fresh = await getProduct(id);
          setProduct(fresh);
          if (fresh && fresh.status !== 'publishing') {
            clearInterval(pollTimer);
            setPublishing(false);
            if (fresh.status === 'published') {
              toast.success('Товар успішно опубліковано на Wallapop!');
            } else if (fresh.status === 'error') {
              toast.error(fresh.errorMessage || 'Помилка публікації на Wallapop', { duration: 6000 });
            }
          }
        } catch (_) {}
        if (attempts >= 60) {
          clearInterval(pollTimer);
          setPublishing(false);
        }
      }, 2000);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Помилка при публікації');
      setPublishing(false);
    }
  };

  const handleDelete = async () => {
    if (!product) return;
    setDeleting(true);
    try {
      await deleteProduct(product.id);
      toast.success('Товар видалено');
      router.push('/products');
    } catch {
      toast.error('Помилка при видаленні');
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#00C9A7] border-t-transparent" />
      </div>
    );
  }

  if (!product) return null;

  const images = product.images ?? [];

  return (
    <div className="flex flex-col gap-0 bg-[#F8F9FA]">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between bg-white px-4 py-3 shadow-sm">
        <button
          onClick={() => router.back()}
          className="flex h-9 w-9 items-center justify-center rounded-xl text-gray-600 hover:bg-gray-100"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="flex-1 truncate px-2 text-base font-semibold text-gray-900">
          {product.title}
        </h1>
        <StatusBadge status={product.status} />
      </div>

      {/* Image carousel */}
      {images.length > 0 ? (
        <div className="relative aspect-square w-full overflow-hidden bg-gray-100">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={getImageUrl(images[currentImage])}
            alt={product.title}
            className="h-full w-full object-cover"
          />
          {images.length > 1 && (
            <>
              <button
                onClick={() => setCurrentImage((i) => (i - 1 + images.length) % images.length)}
                className="absolute left-2 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                onClick={() => setCurrentImage((i) => (i + 1) % images.length)}
                className="absolute right-2 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white"
              >
                <ChevronRight size={18} />
              </button>
              <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1">
                {images.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setCurrentImage(i)}
                    className={`h-1.5 w-1.5 rounded-full transition-colors ${
                      i === currentImage ? 'bg-white' : 'bg-white/40'
                    }`}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="aspect-square w-full bg-gray-100" />
      )}

      {/* Thumbnail row */}
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto bg-white px-4 py-2">
          {images.map((src, i) => (
            <button
              key={i}
              onClick={() => setCurrentImage(i)}
              className={`h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
                i === currentImage ? 'border-[#00C9A7]' : 'border-transparent'
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={getImageUrl(src)}
                alt=""
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}

      {/* Details */}
      <div className="flex flex-col gap-3 px-4 py-4">
        {/* Price & title */}
        <Card>
          <p className="text-2xl font-bold text-[#00C9A7]">€{product.price}</p>
          <h2 className="mt-1 text-lg font-semibold text-gray-900">{product.title}</h2>
          <p className="mt-1 text-sm text-gray-500">{product.description}</p>
        </Card>

        {/* Properties */}
        <Card className="divide-y divide-gray-50">
          {(
            [
              { label: 'Категорія', value: String(categoryLabels[product.category] ?? product.category) },
              { label: 'Стан', value: String(conditionLabels[product.condition] ?? product.condition) },
              product.brand ? { label: 'Бренд', value: String(product.brand) } : null,
              product.model ? { label: 'Модель', value: String(product.model) } : null,
              product.year ? { label: 'Рік випуску', value: String(product.year) } : null,
              product.style ? { label: 'Стиль / Тип', value: String(product.style) } : null,
              product.material ? { label: 'Матеріал', value: String(product.material) } : null,
              product.color ? { label: 'Колір', value: String(product.color) } : null,
              product.location ? { label: 'Локація', value: String(product.location) } : null,
              product.weight ? { label: 'Вага', value: String(product.weight) } : null,
              { label: 'Кількість', value: String(product.quantity) },
              { label: 'Статус', value: String(getStatusLabel(product.status)) },
              { label: 'Створено', value: String(formatDate(product.createdAt)) },
            ].filter(Boolean) as { label: string; value: string }[]
          ).map((row) => (
            <div key={row.label} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
              <span className="text-sm text-gray-500">{row.label}</span>
              <span className="text-sm font-medium text-gray-800">{row.value}</span>
            </div>
          ))}
        </Card>

        {/* Error */}
        {product.status === 'error' && product.errorMessage && !/revisa la informaci|hemos rellenado/i.test(product.errorMessage) && (
          <div className="flex gap-2 rounded-xl bg-red-50 p-3 text-red-600">
            <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
            <p className="text-sm">{product.errorMessage}</p>
          </div>
        )}

        {/* Wallapop link */}
        {product.status === 'published' && product.wallapopId && (
          <a
            href={`https://es.wallapop.com/item/${product.wallapopId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-xl bg-[#00C9A7]/10 py-3 text-sm font-medium text-[#00C9A7] hover:bg-[#00C9A7]/20"
          >
            <ExternalLink size={16} />
            Відкрити оголошення на Wallapop
          </a>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          {product.status === 'published' ? (
            <Button
              variant="primary"
              size="lg"
              onClick={handlePublish}
              loading={publishing}
              fullWidth
            >
              <RotateCcw size={16} />
              Опублікувати повторно
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              onClick={handlePublish}
              loading={publishing}
              fullWidth
            >
              <Send size={16} />
              Опублікувати зараз
            </Button>
          )}
          <Link href={`/products/${product.id}/edit`} className="flex-1">
            <Button variant="secondary" size="lg" fullWidth>
              <Edit size={16} />
              Редагувати
            </Button>
          </Link>
        </div>

        {/* Delete */}
        {confirmDelete ? (
          <div className="flex gap-2">
            <Button
              variant="danger"
              size="lg"
              onClick={handleDelete}
              loading={deleting}
              fullWidth
            >
              Підтвердити видалення
            </Button>
            <Button
              variant="ghost"
              size="lg"
              onClick={() => setConfirmDelete(false)}
              fullWidth
            >
              Скасувати
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="md"
            onClick={() => setConfirmDelete(true)}
            fullWidth
            className="text-red-400 hover:text-red-600"
          >
            <Trash2 size={15} />
            Видалити товар
          </Button>
        )}
      </div>
    </div>
  );
}
