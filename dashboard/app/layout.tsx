import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Shell } from '@/components/Shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'Aave Position Guardian',
  description: 'Read-only early-warning dashboard for Aave V3 borrowers. Not financial advice.',
  robots: { index: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
