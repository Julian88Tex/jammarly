import { Nav } from '@/components/Nav';
import { requirePageUser } from '@/lib/session';
import { APP_VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await requirePageUser();
  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="border-b border-line bg-panel md:border-b-0 md:border-r">
        <Nav version={APP_VERSION} account={user.email || user.name} />
      </aside>
      <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
