import { redirect } from 'next/navigation';
import { Nav } from '@/components/Nav';
import { getPageSession, isOwner } from '@/lib/session';
import { APP_VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await getPageSession();
  if (!isOwner(session)) redirect('/login');
  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="border-b border-line bg-panel md:border-b-0 md:border-r">
        <Nav version={APP_VERSION} />
      </aside>
      <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
