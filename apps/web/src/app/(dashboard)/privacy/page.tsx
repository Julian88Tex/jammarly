import { PrivacyForm } from '@/components/privacy/PrivacyForm';
import { PageHeader } from '@/components/ui';
import { requirePageUser } from '@/lib/session';
import { loadProfile } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function PrivacyPage() {
  const { uid } = await requirePageUser();
  const { profile, version } = await loadProfile(uid);
  return (
    <>
      <PageHeader title="Privacy and data" description="What leaves your devices, how long it is kept, and how to take it with you or delete it." />
      <PrivacyForm privacy={profile.settings.privacy.value} privateSites={profile.settings.privateSites.value} version={version} />
    </>
  );
}
