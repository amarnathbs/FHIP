// Document2 (4) F2. The Investment Intelligence pages print a short list of notices, each one carrying the INTERNAL scope key of the
// code that raised it ("risk_free", "data_currency", "benchmark_mapping"). A customer must never see those keys. This is the one
// place that turns a scope into a plain heading, and says what (if anything) the person can do about it: every actionable notice
// needs what happened, why, how to fix it and a link that works.

export interface WarningPresentation {
  /** Plain heading shown in place of the internal key. */
  label: string;
  /** A real next step, when the person can do something about it. Absent when it is on us. */
  action?: { href: string; text: string };
}

const DATA_PAGE = '/investment-intelligence/data';

const PRESENTATIONS: Record<string, WarningPresentation> = {
  risk_free: { label: 'Risk-free rate' },
  data_currency: { label: 'How up to date these figures are', action: { href: DATA_PAGE, text: 'Upload a newer statement' } },
  as_of_date: { label: 'Analysis date' },
  valuation: { label: 'Holding value', action: { href: DATA_PAGE, text: 'Open statements and data' } },
  nav: { label: 'Prices (NAV)' },
  benchmark: { label: 'Benchmark' },
  benchmark_mapping: { label: 'Benchmark' },
  fund_holdings: { label: 'Fund holdings' },
  persistence: { label: 'Saving results' },
};

/** The heading and next step for a notice's scope. An unknown scope is made readable (underscores to spaces, first letter up), never printed raw. */
export function presentWarningScope(scope: string): WarningPresentation {
  const known = PRESENTATIONS[scope];
  if (known) return known;
  const words = scope.replace(/[_-]+/g, ' ').trim();
  return { label: words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Notice' };
}
