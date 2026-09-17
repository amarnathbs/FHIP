// AIE-1.4 — synthetic insurance-document fixture text, in the bounded
// generic `Label: Value` layout parser.ts/labels.ts document and certify
// (documentCatalogue.ts's header explains why: no real insurer's exact
// layout was sourced for this pass). Every value below is invented —
// reproduces only a structural shape, never real policy content.

export interface InsuranceFixtureOptions {
  header?: string;
  insurer?: string;
  policyType?: string;
  productName?: string;
  policyNumber?: string;
  policyOwnerName?: string;
  insuredPersonName?: string;
  beneficiaryName?: string;
  coverAmount?: string;
  currency?: string;
  renewalDate?: string;
  premium?: string;
  premiumFrequency?: string;
  excess?: string;
  waitingPeriodDays?: string;
  benefitPeriod?: string;
  exclusions?: string;
  annualPremiumTotal?: string;
  /** When true, appends a second "Component 2" cover/premium pair to
   * exercise multi-component detection (AIE14-INS-08). */
  includeSecondComponent?: boolean;
  /** Omit any of these label lines entirely (by field key from labels.ts). */
  omitFields?: string[];
}

const DEFAULTS: Required<Omit<InsuranceFixtureOptions, 'includeSecondComponent' | 'omitFields'>> = {
  header: 'INSURANCE POLICY SCHEDULE',
  insurer: 'Acme Life Insurance Ltd',
  policyType: 'Life',
  productName: 'Acme SecureLife Term Cover',
  policyNumber: '1234567890123456',
  policyOwnerName: 'John Smith',
  insuredPersonName: 'John Smith',
  beneficiaryName: 'Jane Smith',
  coverAmount: '500000',
  currency: 'AUD',
  renewalDate: '2026-01-01',
  premium: '100.00',
  premiumFrequency: 'Monthly',
  excess: '500',
  waitingPeriodDays: '90',
  benefitPeriod: '2 years',
  exclusions: 'Pre-existing conditions; Self-inflicted injury',
  annualPremiumTotal: '1200.00',
};

const FIELD_TO_LABEL: Record<string, string> = {
  insurer: 'Insurer',
  policyType: 'Policy Type',
  productName: 'Product Name',
  policyNumber: 'Policy Number',
  policyOwnerName: 'Policy Owner',
  insuredPersonName: 'Insured Person',
  beneficiaryName: 'Beneficiary',
  coverAmount: 'Sum Insured',
  currency: 'Currency',
  renewalDate: 'Renewal Date',
  premium: 'Premium',
  premiumFrequency: 'Premium Frequency',
  excess: 'Excess',
  waitingPeriodDays: 'Waiting Period',
  benefitPeriod: 'Benefit Period',
  exclusions: 'Exclusions',
  annualPremiumTotal: 'Total Annual Premium',
};

export function buildAieInsuranceFixtureText(options: InsuranceFixtureOptions = {}): string {
  const opts = { ...DEFAULTS, ...options };
  const omit = new Set(options.omitFields ?? []);
  const lines: string[] = [opts.header, ''];
  for (const [field, label] of Object.entries(FIELD_TO_LABEL)) {
    if (omit.has(field)) continue;
    const value = (opts as unknown as Record<string, string>)[field];
    if (value === undefined) continue;
    lines.push(`${label}: ${value}`);
  }
  if (options.includeSecondComponent) {
    lines.push('');
    lines.push('Component 2: Income Protection Rider');
    lines.push(`Sum Insured: 2000`);
    lines.push(`Premium: 40.00`);
  }
  return lines.join('\n');
}

/** A document that is clearly insurance-domain but not one of the certified
 * sub-classes (AIE14-INS-01) — used to exercise the deferred/unsupported
 * path safely. */
export function buildAieInsurancePdsFixtureText(): string {
  return [
    'PRODUCT DISCLOSURE STATEMENT',
    '',
    'Insurer: Acme Life Insurance Ltd',
    'Policy Type: Life',
    'This Product Disclosure Statement describes the terms of cover available under this product.',
    'Sum Insured: 500000',
    'Premium: 100.00',
  ].join('\n');
}

/** Text with no insurance-domain signal at all — must never be sniffed. */
export function buildAieUnrelatedFixtureText(): string {
  return ['MONTHLY BANK STATEMENT', '', 'Account Number: 123456789', 'Opening Balance: 1,000.00', 'Closing Balance: 1,200.00'].join('\n');
}
