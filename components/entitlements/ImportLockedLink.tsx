import Link from 'next/link';
import { financialImportUpgradeHref, type FinancialImportDomain } from '@/lib/entitlements/financialDataImportContract';
import { PremiumImportPill } from './PremiumImportPill';

/**
 * The page-level Import control as a Free user sees it: not a disabled dead-end button, but a visible link with a
 * Premium pill that leads to the existing plan / upgrade section. Its accessible name states both what it is and
 * why it is locked. The sibling manual Add control is untouched.
 */
export function ImportLockedLink({ domain, label }: { domain: FinancialImportDomain; label: string }) {
  return (
    <Link
      href={financialImportUpgradeHref(domain)}
      data-testid="import-locked-link"
      aria-label={`${label} - available on Premium. View Premium plans.`}
      className="inline-flex items-center gap-2 rounded border border-ai px-4 py-2 text-sm font-medium text-ai hover:bg-ai/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ai focus-visible:ring-offset-1"
    >
      {label}
      <PremiumImportPill />
    </Link>
  );
}
