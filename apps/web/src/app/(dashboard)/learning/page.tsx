import { LearningPanel } from '@/components/learning/LearningPanel';
import { PageHeader } from '@/components/ui';
import { buildSummary } from '@/lib/learning/data';
import { latestRunStatus } from '@/lib/learning/job';
import { requirePageUser } from '@/lib/session';
import { loadProfile } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function LearningPage() {
  const { uid } = await requirePageUser();
  const [{ version }, summary, status] = await Promise.all([loadProfile(uid), buildSummary(uid), latestRunStatus(uid)]);
  return (
    <>
      <PageHeader title="Learning" description="What your accepts and dismissals taught Jammarly over the last 28 days, and the rules it adjusted." />
      <LearningPanel summary={summary} status={status} version={version} />
    </>
  );
}
