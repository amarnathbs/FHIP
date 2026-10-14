import Link from 'next/link';
import {
  FINANCIAL_IMPORT_LOCK_COPY,
  FINANCIAL_IMPORT_MANUAL_ENTRY_NOTE,
  FINANCIAL_IMPORT_UNAVAILABLE_COPY,
  financialImportUpgradeHref,
  type FinancialImportDomain,
} from '@/lib/entitlements/financialDataImportContract';
import { PremiumImportPill } from './PremiumImportPill';

/**
 * Shown INSTEAD OF an import form for a Free user (or while the plan cannot be confirmed). It renders no file
 * input, no document-type chooser and no upload button: the gate is visible before any file is chosen. The manual
 * path is named explicitly so the lock never reads as "you cannot maintain your own numbers".
 */
export function ImportLockedNotice({
  domain,
  label,
  state,
}: {
  domain: FinancialImportDomain;
  /** e.g. "Import from Payslip" */
  label: string;
  state: 'premium_required' | 'unavailable' | 'checking';
}) {
  if (state === 'checking') {
    return (
      <div role="status" aria-live="polite" className="mt-4 rounded-card border border-line p-4 text-sm text-muted">
        Checking your plan&hellip;
      </div>
    );
  }
  if (state === 'unavailable') {
    return (
      <div role="status" data-testid="import-unavailable" className="mt-4 rounded-card border border-line p-4 text-sm text-muted">
        <p>{FINANCIAL_IMPORT_UNAVAILABLE_COPY}</p>
      </div>
    );
  }
  return (
    <section
      aria-label={`${label} is a Premium feature`}
      data-testid="import-locked"
      className="mt-4 rounded-card border border-ai/30 bg-ai/5 p-4"
    >
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
        <span>{label}</span>
        <PremiumImportPill />
      </p>
      <p className="mt-2 text-sm text-muted">{FINANCIAL_IMPORT_LOCK_COPY}</p>
      <p className="mt-1 text-xs text-muted">{FINANCIAL_IMPORT_MANUAL_ENTRY_NOTE}</p>
      <Link
        href={financialImportUpgradeHref(domain)}
        className="mt-3 inline-flex min-h-[32px] items-center rounded-full border border-ai px-4 py-1.5 text-sm font-medium text-ai hover:bg-ai/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ai focus-visible:ring-offset-1"
      >
        View Premium plans
      </Link>
    </section>
  );
}
