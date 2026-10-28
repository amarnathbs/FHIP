'use client';

/**
 * The "why am I on the Profile page?" notice (PO defect, 28-10-2026).
 *
 * A Free person who selects a locked Import control (for example "Import bank statement [Premium]" on Expenses) is sent to
 * `/profile?from=import-expenses`. Before this, nothing on the page said why they had arrived and the plan section was
 * far below the fold. This notice says, in plain words: what they tried, why it is not available, how to fix it (the
 * plan section, with a working control that takes them there) and what they can still do for free (add by hand).
 *
 * It is shown ONLY when (a) the `from` value is `import-<known domain>` and (b) the server says this person's import
 * access is Premium-required. A Premium person, a person whose plan is not known yet, and an unknown `from` value
 * all see nothing. Presentation only: it authorises nothing, and the URL carries the domain and no user data.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  FINANCIAL_IMPORT_PLAN_SECTION_ID,
  FINANCIAL_IMPORT_UPGRADE_PARAM,
  parseImportArrivalDomain,
  type FinancialImportDomain,
} from '@/lib/entitlements/financialDataImportContract';
import { useFinancialImportAccess } from '@/lib/entitlements/useFinancialImportAccess';
import { browserPlanSectionEnv, focusPlanSection } from '@/lib/entitlements/importArrival';

export const IMPORT_ARRIVAL_HEADING_ID = 'import-arrival-heading';
export const IMPORT_ARRIVAL_BODY_ID = 'import-arrival-body';

interface DomainCopy {
  /** Sentence-start phrase: what the person tried, e.g. "Importing a bank statement". */
  attempt: string;
  /** The control they pressed, for the "you chose" line. */
  control: string;
  /** What stays free, e.g. "Adding expenses by hand". */
  manual: string;
  /** Where the manual Add control lives; null when there is no single page for it. */
  manualHref: string | null;
}

// A Record over the full domain union: adding a domain to the contract fails to compile until it has wording here.
const COPY: Record<FinancialImportDomain, DomainCopy> = {
  expenses: { attempt: 'Importing a bank statement', control: 'Import bank statement', manual: 'Adding expenses by hand', manualHref: '/expenses' },
  income: { attempt: 'Importing a payslip', control: 'Import from Payslip', manual: 'Adding income by hand', manualHref: '/income' },
  liabilities: { attempt: 'Importing a loan or credit card statement', control: 'Import Statement', manual: 'Adding liabilities by hand', manualHref: '/liabilities' },
  investments: { attempt: 'Importing an investment statement', control: 'Import Australian Investment Statement', manual: 'Adding investments by hand', manualHref: '/investments' },
  retirement: { attempt: 'Importing a retirement or super statement', control: 'Import statement', manual: 'Adding retirement details by hand', manualHref: '/retirement' },
  insurance: { attempt: 'Importing an insurance document', control: 'Import document', manual: 'Adding insurance by hand', manualHref: '/insurance' },
  fdh: { attempt: 'Importing a financial document', control: 'Import a financial document', manual: 'Adding your information by hand', manualHref: null },
};

export function importArrivalCopy(domain: FinancialImportDomain): DomainCopy {
  return COPY[domain];
}

/** Reads the arrival domain from the URL and decides whether the notice shows. Unknown plan, Premium and bad values: no notice. */
export function useImportArrival(): { domain: FinancialImportDomain | null; show: boolean } {
  const params = useSearchParams();
  const domain = parseImportArrivalDomain(params?.get(FINANCIAL_IMPORT_UPGRADE_PARAM));
  const { access } = useFinancialImportAccess();
  return { domain, show: domain !== null && access?.state === 'premium_required' };
}

export function ImportArrivalNotice({ domain }: { domain: FinancialImportDomain }) {
  const copy = COPY[domain];
  return (
    <section
      aria-labelledby={IMPORT_ARRIVAL_HEADING_ID}
      data-testid="import-arrival-notice"
      data-domain={domain}
      className="rounded-card border border-ai/30 bg-ai/5 p-4"
    >
      <h2 id={IMPORT_ARRIVAL_HEADING_ID} className="text-base font-semibold text-ink">
        {copy.attempt} is part of Premium
      </h2>
      <div id={IMPORT_ARRIVAL_BODY_ID} className="mt-2 space-y-1 text-sm text-muted">
        <p>
          You were brought here because you chose &ldquo;{copy.control}&rdquo;. Uploading a statement and reading it automatically is a Premium
          feature, and your plan is Free.
        </p>
        <p>
          To unlock it, choose a plan in the Billing section below (confirm your billing country first if you have not yet), or enter a promo
          code if you have one. {copy.manual} stays free on every plan.
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a
          href={`#${FINANCIAL_IMPORT_PLAN_SECTION_ID}`}
          data-testid="import-arrival-view-plans"
          onClick={(e) => {
            e.preventDefault();
            focusPlanSection(browserPlanSectionEnv());
          }}
          className="inline-flex min-h-[32px] items-center rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ai focus-visible:ring-offset-1"
        >
          View plans and upgrade
        </a>
        {copy.manualHref && (
          <Link
            href={copy.manualHref}
            data-testid="import-arrival-manual-link"
            className="text-sm font-medium text-trust hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ai focus-visible:ring-offset-1"
          >
            {copy.manual} instead
          </Link>
        )}
      </div>
    </section>
  );
}
