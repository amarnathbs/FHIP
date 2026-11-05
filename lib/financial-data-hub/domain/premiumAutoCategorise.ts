/**
 * Premium automatic categorisation -- the pure rules (PO 05-11-2026).
 *
 * THE PRODUCT DECISION. For a Premium person the statement is categorised and counted straight after import, without an approval step. The AI always
 * gives a best guess (it is never asked to "leave it for the person"), and the person edits whatever is wrong. This is the opposite of the manual flow,
 * where nothing counts until the person approves each total, so the safeguards live HERE and in the service instead of in an approval click:
 *
 *   - everything automatic is recorded as automatic (audit actor 'system', source 'premium_auto_categorise'), with the counts;
 *   - the screen says so, in words, with the number of lines that are NOT counted as spending or income (a wrong "own-account transfer" guess hides
 *     real spending, so that number is shown, not buried);
 *   - one click undoes it: every approval on the statement is withdrawn and the lines wait for the person exactly as in the manual flow;
 *   - a large proposed amount, a possible duplicate, a pending refund or transfer match and any other blocking check are NEVER approved automatically
 *     (they are the existing needs-a-decision lines, and the approval gate would refuse them anyway);
 *   - a line is never sent to the AI if it is person-to-person: their names would reach the provider (the masking hides only labelled names), so
 *     those lines get a FIXED answer below instead;
 *   - it runs once per statement. After an undo it does not run again by itself.
 *
 * PURE: no database, no network.
 */
import { payeeTextForAi } from './bankAiCategorise';
import type { NeedsDecisionItem, SurplusEffect } from './categoryReview';

/** `metadata.source` on the audit events this feature writes. The three together are the whole state machine (see readAutoState). */
export const AUTO_SOURCE = 'premium_auto_categorise';
export const AUTO_UNDO_SOURCE = 'premium_auto_categorise_undo';

/** What a line the AI is never shown is filed under, so that nothing is left waiting. */
export interface FixedPlacement {
  id: string;
  /** Exactly one of these is set: a category by key (the fixed answers), or the category id the review already suggested for the line. */
  categoryKey: 'payments_to_people' | 'income' | null;
  categoryId: string | null;
  /** True for a money-out line with nothing readable in it: filed as Other spending (spending, no category). */
  otherSpending?: boolean;
  subcategoryKey: string | null;
  /** In words, for the history and the screen. */
  why: string;
}

/**
 * Lines the rules could not classify and the AI is not allowed to see:
 *  - a line the review already has a suggestion for (own-account transfer wording such as "Linked Acc Trns To Savings") -> that suggestion;
 *  - money OUT that the AI may not be shown (Osko / PayID / transfer wording, or a person's name) -> Payments to People (counts as spending, PO
 *    decision 05-11-2026); money out with nothing readable in it -> Other spending;
 *  - money IN of any unresolved kind -> Income > Other Income. A credit's wording is never sent to the AI (a bare personal name is the usual case),
 *    and the rules already catch the refunds, interest, dividends, salary and platform payouts that are recognisable from their wording.
 * Money out to a business is NOT here: that is the AI's job, and if the AI could not be asked (switched off, not Premium, daily limit) the line stays a
 * question for the person rather than being filed under a guess nobody made.
 */
export function planFixedPlacements(needsDecision: readonly NeedsDecisionItem[]): FixedPlacement[] {
  const out: FixedPlacement[] = [];
  for (const item of needsDecision) {
    if (item.reason !== 'uncategorised' || item.current_category_id) continue;
    if (item.suggested_category_id) {
      out.push({ id: item.id, categoryKey: null, categoryId: item.suggested_category_id, subcategoryKey: null, why: 'Filed under the category the wording suggests. Change it if it is something else.' });
    } else if (item.direction === 'in') {
      out.push({ id: item.id, categoryKey: 'income', categoryId: null, subcategoryKey: 'other_income', why: 'Money in that we could not identify is filed as Other Income. Change it if it is something else.' });
    } else if (payeeTextForAi(item.description) === null) {
      if (/[A-Za-z]{3}/.test(item.description ?? '')) {
        out.push({ id: item.id, categoryKey: 'payments_to_people', categoryId: null, subcategoryKey: null, why: 'A payment to a person is filed as Payments to People. Change it if it is something else.' });
      } else {
        out.push({ id: item.id, categoryKey: null, categoryId: null, otherSpending: true, subcategoryKey: null, why: 'We could not read what this was, so it is filed as Other spending. Change it if you know.' });
      }
    }
  }
  return out;
}

export interface AutoRunSummary {
  /** Lines approved by this run. */
  approved_lines: number;
  /** Of those: counted as income / as spending (net) / not counted at all (transfers, loans, cash, investments) / anything else (refunds, splits). */
  income_lines: number;
  spending_lines: number;
  not_counted_lines: number;
  other_lines: number;
  /** Where the category came from. */
  placed_by_ai: number;
  guessed_by_ai: number;
  other_spending_lines: number;
  placed_by_fixed_answer: number;
  /** Lines still waiting for the person after the run (large amounts, duplicates, blocking checks, anything the AI could not be asked about). */
  left_for_you: number;
  statement_finalised: boolean;
}

export function emptyAutoSummary(): AutoRunSummary {
  return {
    approved_lines: 0, income_lines: 0, spending_lines: 0, not_counted_lines: 0, other_lines: 0, placed_by_ai: 0, guessed_by_ai: 0,
    other_spending_lines: 0, placed_by_fixed_answer: 0, left_for_you: 0, statement_finalised: false,
  };
}

/** Which bucket of the banner a group's lines fall into. */
export function summaryBucket(effect: SurplusEffect): 'income_lines' | 'spending_lines' | 'not_counted_lines' | 'other_lines' {
  if (effect === 'income') return 'income_lines';
  if (effect === 'spending') return 'spending_lines';
  if (effect === 'not_counted') return 'not_counted_lines';
  return 'other_lines';
}

export interface AuditEventRow {
  event_type: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface AutoState {
  /** The automatic run has already started or finished for this statement (so it must not start again). */
  ran: boolean;
  /** Shown on the screen: the latest finished run that has not been undone. */
  summary: AutoRunSummary | null;
}

/** Derives the state from the statement's audit events, in any order. */
export function readAutoState(events: readonly AuditEventRow[]): AutoState {
  let ran = false;
  let latestRun: { at: string; summary: AutoRunSummary | null } | null = null;
  let latestUndo: string | null = null;
  for (const e of events) {
    const source = e.metadata?.source;
    if (source === AUTO_UNDO_SOURCE) {
      ran = true;
      if (latestUndo === null || e.created_at > latestUndo) latestUndo = e.created_at;
      continue;
    }
    if (source !== AUTO_SOURCE) continue;
    ran = true;
    if (e.metadata?.phase === 'completed') {
      const summary = (e.metadata.summary ?? null) as AutoRunSummary | null;
      if (latestRun === null || e.created_at > latestRun.at) latestRun = { at: e.created_at, summary };
    }
  }
  const summary = latestRun && (latestUndo === null || latestRun.at > latestUndo) ? latestRun.summary : null;
  return { ran, summary };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The banner, in plain words. The not-counted number is stated on purpose: it is the one place a wrong guess hides real spending. */
export function autoBannerLines(s: AutoRunSummary): string[] {
  const lines: string[] = [];
  lines.push(
    `We categorised and counted ${plural(s.approved_lines, 'transaction', 'transactions')} for you: ${s.income_lines} as income, ${s.spending_lines} as spending` +
    `${s.not_counted_lines > 0 ? `, and ${s.not_counted_lines} as moves that are not counted as income or spending (transfers, loans, cash, investments)` : ''}.`,
  );
  const source: string[] = [];
  if (s.placed_by_ai > 0) source.push(`${plural(s.placed_by_ai, 'was', 'were')} categorised by AI${s.guessed_by_ai > 0 ? ` (${s.guessed_by_ai} of them best guesses)` : ''}`);
  if (s.other_spending_lines > 0) source.push(`${plural(s.other_spending_lines, 'was', 'were')} filed as Other spending because AI could not tell what they were`);
  if (s.placed_by_fixed_answer > 0) source.push(`${plural(s.placed_by_fixed_answer, 'payment to or from a person', 'payments to or from people')} ${s.placed_by_fixed_answer === 1 ? 'was' : 'were'} filed as Payments to People or Other Income`);
  if (source.length > 0) lines.push(`${source.join('; ')}.`);
  if (s.left_for_you > 0) lines.push(`${plural(s.left_for_you, 'transaction still needs', 'transactions still need')} you: large amounts, possible duplicates and anything we could not categorise are never approved for you.`);
  lines.push('If something is wrong, choose Undo, change it, and approve again.');
  return lines;
}
