import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jammarly',
  description: 'Settings, sync and tone learning for the Jammarly writing assistant.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-ink antialiased">{children}</body>
    </html>
  );
}
