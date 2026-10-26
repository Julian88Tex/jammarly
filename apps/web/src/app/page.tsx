import { redirect } from 'next/navigation';
import { getPageUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await getPageUser();
  redirect(user !== null ? '/overview' : '/login');
}
