'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Edit, Trash2, Send, ImageIcon, ExternalLink, RotateCcw } from 'lucide-react';
import { Product, getApiBaseUrl } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { StatusBadge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';

interface ProductCardProps {
  product: Product;
  onPublish?: (id: string) => void;
  onDelete?: (id: string) => void;
  loading?: boolean;
}

export function ProductCard({ product, onPublish, onDelete, loading }: ProductCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const thumbnail = product.images?.[0];
  const apiUrl = getApiBaseUrl();

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex gap-3 p-3">
        {/* Thumbnail */}
        <Link href={`/products/${product.id}`} className="flex-shrink-0">
          <div className="relative h-20 w-20 overflow-hidden rounded-xl bg-gray-100">
            {thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbnail.startsWith('http') ? thumbnail : `${apiUrl}/${thumbnail}`}
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

      {/* Wallapop link */}
      {product.status === 'published' && product.wallapopId && (
        <div className="mx-3 mb-2">
          <a
            href={`https://es.wallapop.com/item/${product.wallapopId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-[#00C9A7] hover:underline"
          >
            <ExternalLink size={11} />
            Відкрити на Wallapop
          </a>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-1.5 border-t border-gray-50 px-3 py-2">
        {product.status === 'published' ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onPublish?.(product.id)}
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
            onClick={() => onPublish?.(product.id)}
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
    </Card>
  );
}
