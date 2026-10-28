import { TuningForm } from '@/components/tuning/TuningForm';
import { PageHeader } from '@/components/ui';
import { serverKeyStatus } from '@/lib/server-key';
import { requirePageUser } from '@/lib/session';
import { loadProfile } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function TuningPage() {
  const { uid } = await requirePageUser();
  const [{ profile, version }, serverKey] = await Promise.all([loadProfile(uid), serverKeyStatus(uid)]);
  return (
    <>
      <PageHeader title="Tuning" description="Goals, categories, dictionary and models. Every change syncs to your devices as an operation." />
      <TuningForm profile={profile} version={version} serverKey={serverKey} />
    </>
  );
}
