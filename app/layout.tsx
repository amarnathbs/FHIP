import type { Metadata } from 'next';
import './globals.css';
import { QueryProvider } from '@/components/providers/QueryProvider';

export const metadata: Metadata = {
  title: 'Financial Health Intelligence Platform',
  description: 'Understand and improve your financial health.',
  icons: {
    icon: [
      { url: '/images/fhip-icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/images/fhip-icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/images/fhip-icon-180.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans text-gray-900 antialiased">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
