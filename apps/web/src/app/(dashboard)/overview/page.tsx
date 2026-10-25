import { DevicesPanel } from '@/components/overview/DevicesPanel';
import { Card, Meter, PageHeader, Stat } from '@/components/ui';
import { listDevices } from '@/lib/devices';
import { getEnv } from '@/lib/env';
import { getQuotaStatus, loadProfile } from '@/lib/store';

export const dynamic = 'force-dynamic';

function fmt(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) || ms === 0 ? 'never' : new Date(ms).toUTCString();
}

export default async function OverviewPage() {
  const env = getEnv();
  const [{ profile, version }, devices, quota] = await Promise.all([loadProfile(), listDevices(), getQuotaStatus()]);
  const advRatio = quota.advancedOps / quota.limits.advancedOps;
  const simpleRatio = quota.simpleOps / quota.limits.simpleOps;
  const warn = advRatio >= 0.8 || simpleRatio >= 0.8;
  const voice = profile.voice.profiles;

  return (
    <>
      <PageHeader title="Overview" description="Sync status, paired devices and this month's storage usage." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Sync" description="The profile document every device merges with.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Version" value={version} />
            <Stat label="Last write" value={fmt(profile.updatedAt)} hint={`by ${profile.updatedBy || 'init'}`} />
            <Stat label="Devices" value={devices.length} />
            <Stat label="Dictionary" value={profile.dictionary.filter((e) => e.removedHlc === undefined || e.addedHlc > e.removedHlc).length} hint="words" />
            <Stat label="Voice (messages)" value={voice.messages === undefined ? '—' : `v${voice.messages.version}`} hint={voice.messages?.confidence ?? 'not yet learned'} />
            <Stat label="Voice (documents)" value={voice.documents === undefined ? '—' : `v${voice.documents.version}`} hint={voice.documents?.confidence ?? 'not yet learned'} />
          </div>
        </Card>

        <Card title="Usage" description={`Vercel Blob operations in ${quota.month} (Hobby plan budget).`}>
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex justify-between text-[12.5px]">
                <span>Advanced operations (writes, lists)</span>
                <span className="text-muted">
                  {quota.advancedOps} / {quota.limits.advancedOps}
                </span>
              </div>
              <Meter value={quota.advancedOps} max={quota.limits.advancedOps} />
            </div>
            <div>
              <div className="mb-1 flex justify-between text-[12.5px]">
                <span>Simple operations (reads)</span>
                <span className="text-muted">
                  {quota.simpleOps} / {quota.limits.simpleOps}
                </span>
              </div>
              <Meter value={quota.simpleOps} max={quota.limits.simpleOps} />
            </div>
            {warn ? (
              <p className="rounded-md border border-warn/40 bg-warn/15 px-3 py-2 text-warn">
                Over 80 % of the monthly budget. Past the cap, Blob stops answering until the window resets; the extension keeps working from its local copy.
              </p>
            ) : (
              <p className="text-[12.5px] text-muted">Counters are approximate (updated after writes). The dashboard warns at 80 %.</p>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4">
        <DevicesPanel initialDevices={devices} extensionIds={env.EXTENSION_IDS} appOrigin={env.APP_ORIGIN} />
      </div>
    </>
  );
}
