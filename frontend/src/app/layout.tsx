import type { Metadata, Viewport } from 'next';
import { Toaster } from 'react-hot-toast';
import { BottomNav } from '@/components/ui/BottomNav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Wallapop Автопублікатор',
  description: 'Автоматична публікація товарів на Wallapop',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="uk">
      <body className="bg-[#F8F9FA] antialiased">
        <div className="relative mx-auto min-h-screen w-full max-w-[480px] bg-[#F8F9FA]">
          <main className="pb-24 pt-0">{children}</main>
          <BottomNav />
        </div>
        <Toaster
          position="top-center"
          toastOptions={{
            duration: 3000,
            style: {
              maxWidth: '440px',
              borderRadius: '12px',
              fontSize: '14px',
            },
            success: {
              iconTheme: {
                primary: '#00C9A7',
                secondary: '#fff',
              },
            },
          }}
        />
      </body>
    </html>
  );
}
