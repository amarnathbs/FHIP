// Document2 (4) WP-B2 (25-10-2026) -- the result card shown after "Re-evaluate", built from what the check actually found.
//
// PURE. The PO clicked Re-evaluate on a position that "Needs review" and saw nothing: the result was one small grey line that repeated,
// word for word, the blocker box directly beneath it. The result is now a card of its own that always says WHEN it was checked, WHAT it
// found (with the figures), WHETHER anything changed, and WHAT TO DO, with a real button where there is one.

import { describeTruthBlocker, type TruthBlockerCta } from '@/lib/services/investment-intelligence/caseLifecycle';
import { describeUnitVariance, UPLOAD_SECTION_ID, type UnitVarianceFacts } from './unitVarianceGuidance';

export interface ReevaluationFacts {
  before: string | null;
  after: string;
  blocking: { code: string; message: string }[];
  /** The truth row after the check (ii_portfolio_truth_status). */
  reconciledClosingUnits: number | string | null;
  statementClosingUnits: number | string | null;
  unitVariance: number | string | null;
  /** Earliest transaction date held for the position (yyyy-mm-dd), if known. */
  earliestTransactionDate: string | null;
  /** The reasons that were showing BEFORE the click (codes), to say honestly whether anything changed. */
  previousReasonCodes: string[];
  /** "dd-mm-yyyy hh:mm" in the person's own format, supplied by the caller. */
  checkedAtLabel: string;
  /**
   * Whether the position is ALREADY published (29-10-2026). A published position must never be told it is "ready to publish": it is
   * published. Omitted means not published (the earlier behaviour).
   */
  publication?: 'not_published' | 'published_current' | 'published_refresh_available';
}

export interface ReevaluationCard {
  tone: 'ready' | 'blocked';
  /** The first line, large: the outcome. */
  headline: string;
  /** Whether the outcome is different from before the click. */
  changed: boolean;
  /** "Checked just now (dd-mm-yyyy hh:mm)". */
  checkedLine: string;
  lines: string[];
  /** A real button, when there is one. */
  cta: { label: string; kind: 'upload' } | { label: string; kind: 'link'; href: string } | { label: string; kind: 'anchor'; targetId: string } | null;
}

const READY = new Set(['certified', 'certified_with_warnings']);

export function buildReevaluationCard(f: ReevaluationFacts, date: (iso: string) => string): ReevaluationCard {
  const checkedLine = `Checked just now (${f.checkedAtLabel}).`;
  const sameReasons = f.previousReasonCodes.length === f.blocking.length && f.blocking.every((b) => f.previousReasonCodes.includes(b.code));
  const publication = f.publication ?? 'not_published';
  if (READY.has(f.after)) {
    const changed = f.before !== f.after;
    if (publication !== 'not_published') {
      // Already published: "ready to publish" would be untrue. Say what is true about the PUBLISHED position.
      const headline =
        publication === 'published_refresh_available'
          ? `Re-evaluated: ${changed ? 'this position is certified' : 'nothing changed'}. It is published, and a newer certified statement is available. Use Refresh to bring net worth up to date.`
          : changed
            ? 'Re-evaluated: this position is certified. The published position is unchanged and up to date.'
            : 'Re-evaluated: nothing changed. The published position is still published and up to date.';
      return { tone: 'ready', headline, changed, checkedLine, lines: [], cta: null };
    }
    return {
      tone: 'ready',
      headline: changed ? 'Re-evaluated: this position is now ready to publish.' : 'Re-evaluated: nothing changed. This position is still ready to publish.',
      changed,
      checkedLine,
      lines: [],
      cta: null,
    };
  }
  const changed = !(f.before === f.after && sameReasons);
  const unit = f.blocking.find((b) => b.code === 'unit_variance_exceeds_tolerance');
  const lines: string[] = [];
  let headline: string;
  let cta: ReevaluationCard['cta'] = null;
  if (unit) {
    const facts: UnitVarianceFacts = { rebuiltUnits: f.reconciledClosingUnits, statementUnits: f.statementClosingUnits, variance: f.unitVariance, earliestTransactionDate: f.earliestTransactionDate };
    const g = describeUnitVariance(facts, date);
    headline = g.headline;
    lines.push(...g.lines);
    cta = { label: g.cta.label, kind: 'upload' };
    const others = f.blocking.filter((b) => b.code !== 'unit_variance_exceeds_tolerance');
    for (const o of others) lines.push(`Also: ${describeTruthBlocker(o.code, o.message).what}`);
  } else {
    const first = f.blocking[0];
    const g = first ? describeTruthBlocker(first.code, first.message) : null;
    headline = g ? `Still needs review: ${g.what}` : 'Still needs review.';
    if (g) {
      lines.push(g.why, `What will fix it: ${g.how}`);
      cta = ctaOf(g.cta);
    }
    for (const o of f.blocking.slice(1)) lines.push(`Also: ${describeTruthBlocker(o.code, o.message).what}`);
  }
  lines.unshift(changed ? 'The result has changed since the last check.' : 'Nothing has changed since the last check: the same reason still applies.');
  if (publication !== 'not_published') lines.push('This position is still published at its last certified value.');
  return { tone: 'blocked', headline, changed, checkedLine, lines, cta };
}

function ctaOf(c: TruthBlockerCta): ReevaluationCard['cta'] {
  if (c.kind === 'link') return { label: c.label, kind: 'link', href: c.href };
  if (c.kind === 'anchor') return { label: c.label, kind: 'anchor', targetId: c.targetId };
  return null;
}

export { UPLOAD_SECTION_ID };
