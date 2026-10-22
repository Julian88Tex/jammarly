import { redirect } from 'next/navigation';
import { getPageSession, isOwner } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const session = await getPageSession();
  redirect(isOwner(session) ? '/overview' : '/login');
}
