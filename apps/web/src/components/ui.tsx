import type { ReactNode } from 'react';

export function Card({ title, description, actions, children, className = '' }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-line bg-panel p-4 shadow-sm ${className}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title !== undefined && <h2 className="text-[15px] font-semibold">{title}</h2>}
            {description !== undefined && <p className="mt-0.5 text-muted">{description}</p>}
          </div>
          {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description !== undefined && <p className="mt-1 max-w-2xl text-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export type Tone = 'neutral' | 'brand' | 'accent' | 'warn' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-panel-2 text-muted',
  brand: 'bg-brand/15 text-brand-strong dark:text-brand',
  accent: 'bg-accent/15 text-accent dark:text-[#7A9BFF]',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium ${TONE_CLASS[tone]}`}>{children}</span>;
}

export function Notice({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const border = tone === 'danger' ? 'border-danger/40' : tone === 'warn' ? 'border-warn/40' : tone === 'brand' ? 'border-brand/40' : 'border-line';
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`rounded-md border ${border} ${TONE_CLASS[tone]} px-3 py-2`}>
      {children}
    </div>
  );
}

export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-[12.5px] text-muted">{hint}</span>}
    </label>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-panel-2/60 px-3 py-2">
      <div className="text-[12px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold">{value}</div>
      {hint !== undefined && <div className="text-[12.5px] text-muted">{hint}</div>}
    </div>
  );
}

export function Meter({ value, max, warnAt = 0.8 }: { value: number; max: number; warnAt?: number }) {
  const ratio = max > 0 ? value / max : 0;
  const cls = ratio >= 1 ? 'meter over' : ratio >= warnAt ? 'meter warn' : 'meter';
  return (
    <div className={cls} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-muted">{children}</p>;
}

export function percent(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}
