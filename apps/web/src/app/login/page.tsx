import { Suspense } from 'react';
import { LoginForm } from '@/components/LoginForm';

export const metadata = { title: 'Sign in · Jammarly' };

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <span className="inline-block h-6 w-6 rounded-md bg-brand" aria-hidden="true" />
        <span className="text-lg font-semibold tracking-tight">Jammarly</span>
      </div>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mb-5 mt-1 text-muted">The owner password for this deployment.</p>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
