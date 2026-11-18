'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Edit, Trash2, Send, ImageIcon, ExternalLink, RotateCcw, Clock } from 'lucide-react';
import { Product, getImageUrl } from '@/lib/api';
import { formatDate, cn } from '@/lib/utils';
import { StatusBadge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';

interface ProductCardProps {
  product: Product;
  onPublish?: (id: string, platform?: 'wallapop' | 'vinted' | 'both') => void;
  onAddToQueue?: (id: string) => void;
  onDelete?: (id: string) => void;
  loading?: boolean;
}

export function ProductCard({ product, onPublish, onAddToQueue, onDelete, loading }: ProductCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const thumbnail = product.images?.[0];

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex gap-3 p-3">
        {/* Thumbnail */}
        <Link href={`/products/${product.id}`} className="flex-shrink-0">
          <div className="relative h-20 w-20 overflow-hidden rounded-xl bg-gray-100">
            {thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={getImageUrl(thumbnail)}
                alt={product.title}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <ImageIcon size={24} className="text-gray-300" />
              </div>
            )}
          </div>
        </Link>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col justify-between">
          <div>
            <Link href={`/products/${product.id}`}>
              <h3 className="truncate text-sm font-semibold text-gray-900 hover:text-[#00C9A7]">
                {product.title}
              </h3>
            </Link>
            <p className="mt-0.5 text-base font-bold text-[#00C9A7]">€{product.price}</p>
            <div className="mt-1 flex items-center gap-2">
              <StatusBadge status={product.status} />
              {product.vintedStatus === 'in_queue' && product.status !== 'in_queue' && (
                <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                  Черга Vinted
                </span>
              )}
              {product.vintedStatus === 'publishing' && product.status !== 'publishing' && (
                <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 animate-pulse">
                  Vinted...
                </span>
              )}
              {product.quantity > 1 && (
                <span className="text-xs text-gray-400">×{product.quantity}</span>
              )}
            </div>
          </div>
          <p className="text-[10px] text-gray-400">{formatDate(product.createdAt)}</p>
        </div>
      </div>

      {/* Error message */}
      {product.status === 'error' && product.errorMessage && !/revisa la informaci|hemos rellenado/i.test(product.errorMessage) && (
        <div className="mx-3 mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
          {product.errorMessage}
        </div>
      )}

      {/* Platform links */}
      <div className="mx-3 mb-2 flex flex-wrap gap-3">
        {product.wallapopId && (
          <a
            href={product.wallapopUrl || `https://es.wallapop.com/item/${product.wallapopId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-[#00C9A7] hover:underline"
          >
            <ExternalLink size={11} />
            Wallapop
          </a>
        )}
        {product.vintedUrl && (
          <a
            href={product.vintedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-[#09B1BA] hover:underline"
          >
            <ExternalLink size={11} />
            Vinted
          </a>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-1.5 border-t border-gray-50 px-3 py-2">
        <div className="flex gap-1.5">
          {product.status === 'published' ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onPublish?.(product.id, 'both')}
              loading={loading}
              className="flex-1"
            >
              <RotateCcw size={13} />
              Опублікувати повторно
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => onPublish?.(product.id, 'both')}
              loading={loading}
              className="flex-1"
            >
              <Send size={13} />
              Опублікувати зараз
            </Button>
          )}
          <Link
            href={`/products/${product.id}`}
            className="inline-flex items-center justify-center px-3 py-1.5 text-sm rounded-lg bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 shadow-sm active:scale-95"
            title="Редагувати / Переглянути"
          >
            <Edit size={13} />
          </Link>
          {confirmDelete ? (
            <>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  onDelete?.(product.id);
                  setConfirmDelete(false);
                }}
                className="flex-1"
              >
                Підтвердити
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                Скасувати
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              className="text-red-400 hover:text-red-600"
            >
              <Trash2 size={13} />
            </Button>
          )}
        </div>

        {/* Separate platform publish buttons */}
        <div className="flex gap-1.5 pt-0.5">
          <button
            type="button"
            disabled={loading || product.wallapopStatus === 'in_queue' || product.wallapopStatus === 'publishing'}
            onClick={() => onAddToQueue?.(product.id)}
            className={cn(
              "flex-1 rounded-lg border py-1.5 px-2 text-[11px] font-semibold active:scale-95 transition-all flex items-center justify-center gap-1 disabled:opacity-75",
              product.wallapopStatus === 'in_queue'
                ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                : product.wallapopStatus === 'publishing'
                ? "border-amber-300 bg-amber-50 text-amber-700 animate-pulse"
                : "border-[#00C9A7]/40 bg-[#00C9A7]/5 text-[#008F75] hover:bg-[#00C9A7]/15"
            )}
            title={product.wallapopStatus === 'in_queue' ? "В черзі Wallapop (запуск кнопкою 'Запустити')" : "Додати товар до черги Wallapop"}
          >
            <Clock size={11} className={product.wallapopStatus === 'in_queue' ? "text-emerald-500" : "text-[#00C9A7]"} />
            {product.wallapopStatus === 'in_queue'
              ? 'В черзі Wallapop'
              : product.wallapopStatus === 'publishing'
              ? 'Публікується...'
              : 'Додати в чергу Wallapop'}
          </button>
          <button
            type="button"
            disabled={loading || product.vintedStatus === 'in_queue' || product.vintedStatus === 'publishing'}
            onClick={() => onPublish?.(product.id, 'vinted')}
            className={cn(
              "flex-1 rounded-lg border py-1.5 px-2 text-[11px] font-semibold active:scale-95 transition-all flex items-center justify-center gap-1 disabled:opacity-75",
              product.vintedStatus === 'in_queue'
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : product.vintedStatus === 'publishing'
                ? "border-amber-300 bg-amber-50 text-amber-700 animate-pulse"
                : "border-[#09B1BA]/40 bg-[#09B1BA]/5 text-[#07858c] hover:bg-[#09B1BA]/15"
            )}
            title={product.vintedStatus === 'in_queue' ? "В черзі Vinted (інтервал не частіше 1 хв)" : "Опублікувати тільки на Vinted"}
          >
            <Send size={11} className={product.vintedStatus === 'in_queue' ? "text-blue-500" : "text-[#09B1BA]"} />
            {product.vintedStatus === 'in_queue'
              ? 'В черзі Vinted'
              : product.vintedStatus === 'publishing'
              ? 'Публікується...'
              : 'Опублікувати на Vinted'}
          </button>
        </div>
      </div>
    </Card>
  );
}
