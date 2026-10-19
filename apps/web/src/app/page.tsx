import { APP_VERSION, PROFILE_VERSION } from '@/lib/version';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">Jammarly</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Web app v{APP_VERSION}, profile schema v{PROFILE_VERSION}. Dashboard pages land in the implementation phase.
      </p>
    </main>
  );
}
