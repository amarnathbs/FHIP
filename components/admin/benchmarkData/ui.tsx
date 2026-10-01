// Shared presentational building blocks for the Benchmark Data Admin screens.
// Presentational and stateless wherever possible, so the honest states
// (unavailable / empty / error / pending / automation OFF) can be rendered to
// static HTML and tested without a DOM (tests/unit/benchmarkDataClientStates.test.ts).
//
// Reuses the repository's Admin conventions: Tailwind tokens (trust, line, ink,
// muted, risk, positive, attention), 44px touch targets, visible focus rings,
// tables inside horizontal scroll containers, aria-live announcements.
import { useId, type ReactNode } from 'react';
import { NUM_CELL_CLASS, NUM_HEADER_CLASS } from '@/lib/ui/tableAlign';
import type { PendingImportTask } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import {
  automationStatus,
  formatCount,
  pendingStatusChip,
  visiblePendingTasks,
  type ApiFailure,
  type Tone,
} from './benchmarkDataUiLogic';

export { NUM_CELL_CLASS, NUM_HEADER_CLASS };

const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-trust';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'border-positive/30 bg-positive/10 text-positive',
  warn: 'border-attention/40 bg-attention/10 text-attention',
  bad: 'border-risk/30 bg-risk/10 text-risk',
  neutral: 'border-line bg-app text-muted',
  info: 'border-trust/30 bg-trust/10 text-trust',
};

/** Status chip: the label is always TEXT (never colour alone). */
export function Chip({ label, tone = 'neutral', title }: { label: string; tone?: Tone; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>
      {label}
    </span>
  );
}

export function Notice({ tone = 'info', title, children, live }: { tone?: Tone; title?: string; children?: ReactNode; live?: 'status' | 'alert' }) {
  return (
    <div role={live} className={`rounded-compact border px-3 py-2 text-sm ${TONE_CLASS[tone]}`}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? 'mt-1 text-ink' : 'text-ink'}>{children}</div> : null}
    </div>
  );
}

export function Panel({ title, id, description, children, actions }: { title: string; id?: string; description?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  const generated = useId();
  const hid = id ?? `panel-${generated}`;
  return (
    <section aria-labelledby={hid} className="rounded-card border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={hid} className="text-base font-semibold text-ink">
          {title}
        </h2>
        {actions}
      </div>
      {description ? <div className="mt-1 text-sm text-muted">{description}</div> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export type BtnKind = 'primary' | 'secondary' | 'danger';
const BTN: Record<BtnKind, string> = {
  primary: 'bg-trust text-white hover:opacity-90',
  secondary: 'border border-line bg-white text-ink hover:bg-gray-50',
  danger: 'border border-risk/40 bg-white text-risk hover:bg-risk/10',
};

export function Btn({ children, onClick, disabled, kind = 'primary', type = 'button', busy, describedBy }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: BtnKind; type?: 'button' | 'submit'; busy?: boolean; describedBy?: string }) {
  const off = disabled === true || busy === true;
  return (
    <button type={type} onClick={onClick} disabled={off} aria-disabled={off} aria-busy={busy === true} aria-describedby={describedBy} className={`inline-flex min-h-11 items-center justify-center rounded px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${BTN[kind]} ${FOCUS}`}>
      {busy ? 'Working...' : children}
    </button>
  );
}

export function LinkBtn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`min-h-11 text-sm font-semibold text-trust underline-offset-2 hover:underline ${FOCUS}`}>
      {children}
    </button>
  );
}

/** Horizontal scroll container for a wide table: the PAGE never scrolls sideways. */
export function ScrollTable({ label, children, minWidth = 'min-w-[720px]' }: { label: string; children: ReactNode; minWidth?: string }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className={`overflow-x-auto rounded-card border border-line bg-white ${FOCUS}`}>
      <table className={`w-full ${minWidth} text-left text-sm`}>
        <caption className="sr-only">{label}</caption>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, num }: { children: ReactNode; num?: boolean }) {
  return (
    <th scope="col" className={`whitespace-nowrap bg-gray-50 px-3 py-2 text-xs font-semibold text-muted ${num ? NUM_HEADER_CLASS : ''}`}>
      {children}
    </th>
  );
}

export function Td({ children, num, className = '' }: { children?: ReactNode; num?: boolean; className?: string }) {
  return <td className={`border-t border-line px-3 py-2 align-top ${num ? NUM_CELL_CLASS : ''} ${className}`}>{children}</td>;
}

export function LoadingPanel({ what }: { what: string }) {
  return (
    <div role="status" aria-live="polite" className="rounded-card border border-line bg-white p-4 text-sm text-muted">
      Loading {what}...
    </div>
  );
}

/** Explicit failure state (never an empty list). A 403 is not offered a Retry that can never succeed. */
export function ErrorPanel({ failure, what, onRetry }: { failure: ApiFailure; what: string; onRetry?: () => void }) {
  const title = failure.kind === 'forbidden' || failure.kind === 'unauthenticated' ? `You cannot view ${what}` : `Could not load ${what}`;
  return (
    <div role="alert" className="rounded-card border border-risk/30 bg-risk/5 p-4 text-sm">
      <p className="font-semibold text-risk">{title}</p>
      <p className="mt-1 text-ink">{failure.message}</p>
      <p className="mt-1 text-muted">Nothing is shown as a stand-in: an error is not the same as &quot;no data&quot;.</p>
      {failure.retryable && onRetry ? (
        <div className="mt-3">
          <Btn kind="secondary" onClick={onRetry}>
            Try again
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

/** The service says it cannot answer (for example the database migration is not applied): never a healthy empty dashboard. */
export function UnavailablePanel({ reason, what = 'Benchmark Data' }: { reason?: string; what?: string }) {
  return (
    <div role="alert" className="rounded-card border border-attention/40 bg-attention/10 p-4 text-sm">
      <p className="font-semibold text-attention">{what} is unavailable</p>
      <p className="mt-1 text-ink">{reason && reason.trim() ? reason : 'No reason was given by the server.'}</p>
      <p className="mt-1 text-muted">This is not an empty or healthy state. No benchmark data can be judged from this page until the service is available again.</p>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-line bg-white p-6 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      {children ? <div className="mt-1 text-sm text-muted">{children}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------- form fields ---

function describedBy(...ids: Array<string | null | false | undefined>): string | undefined {
  const v = ids.filter(Boolean).join(' ');
  return v || undefined;
}

export function FieldShell({ id, label, hint, error, children, required }: { id: string; label: string; hint?: ReactNode; error?: string | null; children: ReactNode; required?: boolean }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
        {required ? <span className="text-risk"> (required)</span> : null}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-muted">
          {hint}
        </p>
      ) : null}
      <div className="mt-1">{children}</div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs font-medium text-risk">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const INPUT = `block min-h-11 w-full rounded border border-line bg-white px-3 py-2 text-sm text-ink disabled:bg-gray-100 disabled:text-muted ${FOCUS}`;

export function TextField({ label, value, onChange, hint, error, required, disabled, type = 'text', placeholder, maxLength, list }: { label: string; value: string; onChange: (v: string) => void; hint?: ReactNode; error?: string | null; required?: boolean; disabled?: boolean; type?: 'text' | 'date' | 'number' | 'url'; placeholder?: string; maxLength?: number; list?: string }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      <input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={placeholder} maxLength={maxLength} list={list} aria-invalid={error ? true : undefined} aria-describedby={describedBy(hint && `${id}-hint`, error && `${id}-error`)} className={INPUT} />
    </FieldShell>
  );
}

export function TextAreaField({ label, value, onChange, hint, error, required, disabled, rows = 3, maxLength }: { label: string; value: string; onChange: (v: string) => void; hint?: ReactNode; error?: string | null; required?: boolean; disabled?: boolean; rows?: number; maxLength?: number }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={rows} disabled={disabled} maxLength={maxLength} aria-invalid={error ? true : undefined} aria-describedby={describedBy(hint && `${id}-hint`, error && `${id}-error`)} className={INPUT} />
    </FieldShell>
  );
}

export interface Opt {
  value: string;
  label: string;
}

export function SelectField({ label, value, onChange, options, placeholder = 'Choose...', hint, error, required, disabled }: { label: string; value: string; onChange: (v: string) => void; options: readonly Opt[]; placeholder?: string; hint?: ReactNode; error?: string | null; required?: boolean; disabled?: boolean }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-invalid={error ? true : undefined} aria-describedby={describedBy(hint && `${id}-hint`, error && `${id}-error`)} className={INPUT}>
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function CheckField({ label, checked, onChange, disabled, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-start gap-2">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} className={`mt-1 h-5 w-5 shrink-0 ${FOCUS}`} />
      <label htmlFor={id} className="text-sm text-ink">
        {label}
        {hint ? (
          <span id={`${id}-hint`} className="mt-0.5 block text-xs text-muted">
            {hint}
          </span>
        ) : null}
      </label>
    </div>
  );
}

export function RadioGroup({ legend, name, value, onChange, options, disabled }: { legend: string; name: string; value: string; onChange: (v: string) => void; options: ReadonlyArray<{ value: string; label: ReactNode; description?: ReactNode }>; disabled?: boolean }) {
  const base = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-medium text-ink">{legend}</legend>
      <div className="mt-1 space-y-1">
        {options.map((o) => {
          const id = `${base}-${o.value}`;
          return (
            <div key={o.value} className="flex min-h-11 items-start gap-2 rounded-compact border border-line bg-white px-3 py-2">
              <input id={id} type="radio" name={name} value={o.value} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} aria-describedby={o.description ? `${id}-d` : undefined} className={`mt-1 h-5 w-5 shrink-0 ${FOCUS}`} />
              <label htmlFor={id} className="text-sm text-ink">
                {o.label}
                {o.description ? (
                  <span id={`${id}-d`} className="mt-0.5 block text-xs text-muted">
                    {o.description}
                  </span>
                ) : null}
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

export function IssueList({ issues, tone = 'bad' }: { issues: readonly string[]; tone?: Tone }) {
  if (issues.length === 0) return null;
  return (
    <ul className={`list-disc space-y-1 rounded-compact border px-3 py-2 pl-7 text-sm ${TONE_CLASS[tone]}`}>
      {issues.map((m, i) => (
        <li key={i} className="text-ink">
          {m}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------- honest-state panels ---

/** Pending manual imports: "upload" wording only, never "update". The action sentence is shown verbatim. */
export function PendingImportsPanel({ tasks, canStage, onUpload }: { tasks: readonly PendingImportTask[]; canStage: boolean; onUpload?: (benchmarkKey: string) => void }) {
  const visible = visiblePendingTasks(tasks);
  return (
    <Panel title="Pending imports" description="Benchmarks on manual import that need a file from an administrator. Nothing here updates automatically.">
      {visible.length === 0 ? (
        <EmptyState title="No manual import is waiting">Every manual-import benchmark is up to date for its expected latest session, or no benchmark is on manual import yet.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {visible.map((t) => {
            const chip = pendingStatusChip(t.status);
            return (
              <li key={t.benchmarkKey} className="rounded-compact border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{t.benchmarkLabel}</span>
                  <Chip label={chip.label} tone={chip.tone} />
                </div>
                <p className="mt-1 text-sm text-ink">{t.action}</p>
                <p className="mt-1 text-xs text-muted">
                  Latest stored level: {t.latestValidDataDate ?? 'none'}. Expected latest session: {t.expectedLatestSession}.
                  {t.weekdaysBehind !== null ? ` ${formatCount(t.weekdaysBehind)} weekday(s) behind.` : ''}
                </p>
                <div className="mt-2">
                  {canStage ? (
                    <Btn kind="secondary" onClick={() => onUpload?.(t.benchmarkKey)}>
                      {`Upload a file for ${t.benchmarkLabel}`}
                    </Btn>
                  ) : (
                    <p className="text-xs text-muted">You do not have the upload permission, so you cannot start this upload.</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function AutomationBlock({ switches, notice }: { switches: { globalIngestion: boolean; writeIngestion: boolean; environmentFlag: boolean; effectivelyEnabled: boolean }; notice: string }) {
  const a = automationStatus(switches);
  return (
    <Panel title="Automation" description="Recurring (automatic) ingestion from a provider. Manual file uploads are a separate thing and are never counted as automatic updates.">
      <div className="flex flex-wrap items-center gap-2">
        <Chip label={a.headline} tone={a.on ? 'ok' : 'warn'} />
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-3">
        {a.switches.map((s) => (
          <li key={s.label} className="rounded-compact border border-line px-3 py-2 text-sm">
            <span className="text-muted">{s.label}: </span>
            <span className="font-semibold text-ink">{s.on ? 'ON' : 'OFF'}</span>
          </li>
        ))}
      </ul>
      {!a.on && a.blockedBy.length > 0 ? <p className="mt-2 text-sm text-ink">Recurring ingestion is off because: {a.blockedBy.join('; ')} {a.blockedBy.length === 1 ? 'is' : 'are'} OFF.</p> : null}
      <p className="mt-2 text-sm text-muted">{notice}</p>
    </Panel>
  );
}
