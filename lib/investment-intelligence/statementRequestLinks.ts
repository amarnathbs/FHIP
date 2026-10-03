// Where an investor asks CAMS or KFintech for a full statement -- the ONE place
// these links and the guidance wording live (PO decision 2026-10-03), so a
// correction is a one-line change here and nowhere else.
//
// *** THE TWO URLS BELOW ARE UNVERIFIED. ***
// They are the Product Owner's best recollection of the official provider pages.
// Nobody on the build side has opened, fetched or checked them. The PO must
// confirm both before release (and re-check them from time to time: a provider
// can move a page). Do not add any other link or domain without the same check.

/** CAMS "Consolidated Account Statement" request page. UNVERIFIED, awaiting PO check. */
export const CAMS_STATEMENT_REQUEST_URL = 'https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement';

/** KFintech "Consolidated Account Statement" request page. UNVERIFIED, awaiting PO check. */
export const KFIN_STATEMENT_REQUEST_URL = 'https://mfs.kfintech.com/investor/General/ConsolidatedAccountStatement';

/** The only registrable domains a statement-help link may point at (the host itself or any subdomain of it). */
export const ALLOWED_STATEMENT_LINK_DOMAINS = ['camsonline.com', 'kfintech.com'] as const;

/** https only, and the host is an allowed domain or a subdomain of one. Anything else is refused. */
export function isAllowedStatementLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_STATEMENT_LINK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export const FULL_STATEMENT_HELP_TITLE = 'How to get your full statement';

export const FULL_STATEMENT_HELP_INTRO =
  'A full since-inception statement lists every purchase with its date, so FHIP can work out your returns. A summary or holdings-only statement shows what you hold but not when you bought it.';

export interface StatementProviderHelp {
  key: 'cams' | 'kfintech';
  name: string;
  /** Visible link text names the provider. */
  linkText: string;
  url: string;
}

export const STATEMENT_PROVIDERS: readonly StatementProviderHelp[] = [
  { key: 'cams', name: 'CAMS', linkText: 'CAMS investor services', url: CAMS_STATEMENT_REQUEST_URL },
  { key: 'kfintech', name: 'KFintech (KFin)', linkText: 'KFintech investor services', url: KFIN_STATEMENT_REQUEST_URL },
];

/** What to pick on either provider's request form. Short on purpose. */
export const FULL_STATEMENT_STEPS: readonly string[] = [
  'Choose the consolidated account statement (CAS) in its detailed form, with transactions. Do not choose the summary or holdings-only option.',
  'For the period, choose since inception (all time), not a recent date range.',
  'Include all folios.',
  'Enter your PAN and your email address.',
];

export const FULL_STATEMENT_DELIVERY =
  'The statement is emailed to the email address registered for your PAN. The PDF is password protected: the password is usually your PAN, or the one you set on the request form.';

export const FULL_STATEMENT_PRIVACY = 'FHIP never needs your CAMS or KFintech login. You upload the PDF yourself.';

export const EXTERNAL_LINK_NOTE = 'Opens the provider’s own website in a new tab.';
