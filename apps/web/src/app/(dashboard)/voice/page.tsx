import { PageHeader } from '@/components/ui';
import { VoicePanel } from '@/components/voice/VoicePanel';
import { loadProfile } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function VoicePage() {
  const { profile, version } = await loadProfile();
  return (
    <>
      <PageHeader title="Voice" description="How Jammarly describes your writing in messages and documents. Edit anything; locked traits survive the next synthesis, removed items never come back." />
      <VoicePanel voice={profile.voice} history={profile.learning.history} version={version} />
    </>
  );
}
