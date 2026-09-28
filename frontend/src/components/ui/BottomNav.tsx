'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Package, PlusCircle, Settings, Clock, Send, Save } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  { label: 'Головна', href: '/', icon: Home },
  { label: 'Товари', href: '/products', icon: Package },
  { label: 'Додати', href: '/products/new', icon: PlusCircle },
  { label: 'Налаштування', href: '/settings', icon: Settings },
];

export function BottomNav() {
  const pathname = usePathname();
  const isNewProduct = pathname === '/products/new';
  const isEditProduct = pathname.startsWith('/products/') && pathname.endsWith('/edit');

  return (
    <nav className="fixed bottom-0 left-1/2 z-50 w-full max-w-[480px] -translate-x-1/2 border-t border-gray-100 bg-white/95 backdrop-blur-md pb-safe shadow-[0_-4px_20px_rgba(0,0,0,0.05)]">
      {isNewProduct && (
        <div className="px-3 pt-2.5 pb-2 border-b border-gray-100 flex gap-2">
          <button
            id="btn-add-to-queue"
            type="button"
            onClick={() => {
              if (typeof window !== 'undefined') (window as any).__productSubmitMode = 'queue';
              const hiddenSubmit = document.getElementById('product-form-hidden-submit');
              if (hiddenSubmit) {
                hiddenSubmit.click();
              } else {
                const form = document.getElementById('product-form') as HTMLFormElement | null;
                if (form) form.requestSubmit();
              }
            }}
            className="flex-1 rounded-full border border-[#00C9A7] bg-white py-3 px-2 text-xs sm:text-sm font-semibold text-[#008F75] shadow-sm transition-all hover:bg-[#00C9A7]/5 active:scale-[0.98] flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            <Clock size={15} className="text-[#00C9A7] flex-shrink-0" />
            Додати в чергу
          </button>
          <button
            id="btn-publish-now"
            type="button"
            onClick={() => {
              if (typeof window !== 'undefined') (window as any).__productSubmitMode = 'publish_now';
              const hiddenSubmit = document.getElementById('product-form-hidden-submit');
              if (hiddenSubmit) {
                hiddenSubmit.click();
              } else {
                const form = document.getElementById('product-form') as HTMLFormElement | null;
                if (form) form.requestSubmit();
              }
            }}
            className="flex-1 rounded-full bg-[#00C9A7] py-3 px-2 text-xs sm:text-sm font-bold text-white shadow-md transition-all hover:bg-[#00b396] active:scale-[0.98] flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            <Send size={15} className="flex-shrink-0" />
            Опублікувати зараз
          </button>
        </div>
      )}

      {isEditProduct && (
        <div className="px-3 pt-2.5 pb-2 border-b border-gray-100 flex gap-2">
          <button
            type="button"
            onClick={() => window.history.back()}
            className="flex-1 rounded-full border border-gray-200 bg-white py-3 px-2 text-xs sm:text-sm font-semibold text-gray-700 shadow-sm transition-all hover:bg-gray-50 active:scale-[0.98] flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            Скасувати
          </button>
          <button
            id="btn-save-product"
            type="button"
            onClick={() => {
              const hiddenSubmit = document.getElementById('product-form-hidden-submit');
              if (hiddenSubmit) {
                hiddenSubmit.click();
              } else {
                const form = document.getElementById('product-form') as HTMLFormElement | null;
                if (form) form.requestSubmit();
              }
            }}
            className="flex-1 rounded-full bg-[#00C9A7] py-3 px-2 text-xs sm:text-sm font-bold text-white shadow-md transition-all hover:bg-[#00b396] active:scale-[0.98] flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            <Save size={15} className="flex-shrink-0" />
            Зберегти зміни
          </button>
        </div>
      )}
      <div className="flex items-center justify-around px-2 py-2">
        {tabs.map(({ label, href, icon: Icon }) => {
          const isActive =
            href === '/' ? pathname === '/' : pathname.startsWith(href) && (href !== '/' || pathname === '/');
          const addTab = href === '/products/new';
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex flex-col items-center gap-0.5 rounded-xl px-3 py-1.5 transition-colors',
                addTab
                  ? 'text-[#00C9A7]'
                  : isActive
                  ? 'text-[#00C9A7]'
                  : 'text-gray-400 hover:text-gray-600'
              )}
            >
              <Icon
                size={22}
                strokeWidth={isActive || addTab ? 2.5 : 1.8}
                className={cn(
                  addTab && 'scale-110'
                )}
              />
              <span className={cn('text-[10px] font-medium', isActive || addTab ? 'font-semibold' : '')}>
                {label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
