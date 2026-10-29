/**
 * Pure selection logic of the bulk "Choose a category" tools on the statement
 * review (2026-10-29). Kept out of the component so every rule is unit-tested:
 * what a page holds, what "like this one" means, which selected lines a
 * suggestion covers, and the exact sentences the confirmation states (count and
 * category) before anything is written.
 *
 * NOTHING HERE APPROVES ANYTHING. Choosing categories in bulk only assigns them;
 * approval of the totals is the separate, existing step.
 */

import { derivePayeeKey } from './categoryReview';

/** Cards shown per page of the "Choose a category" list. */
export const BULK_CARDS_PER_PAGE = 50;
/** The server refuses more than this in one request (fdhBulkSetCategorySchema). */
export const BULK_MAX_SELECTION = 500;

export interface SelectableItem {
  id: string;
  description: string | null;
  can_choose_category: boolean;
  suggested_category_id: string | null;
}

export function cardPageCount(total: number, perPage = BULK_CARDS_PER_PAGE): number {
  return Math.max(1, Math.ceil(total / perPage));
}

/** The items on one page (1-based), clamped into range. */
export function itemsOnPage<T>(items: readonly T[], page: number, perPage = BULK_CARDS_PER_PAGE): T[] {
  const p = Math.min(Math.max(1, page), cardPageCount(items.length, perPage));
  return items.slice((p - 1) * perPage, p * perPage);
}

/** "Page 2 of 6, transactions 51 to 100 of 271" */
export function cardPageSummary(page: number, total: number, perPage = BULK_CARDS_PER_PAGE): string {
  if (total === 0) return 'No transactions';
  const pages = cardPageCount(total, perPage);
  const p = Math.min(Math.max(1, page), pages);
  return `Page ${p} of ${pages}, transactions ${(p - 1) * perPage + 1} to ${Math.min(p * perPage, total)} of ${total}`;
}

/** What makes two lines "the same payee": the payee words the remember-payee rule would use, else the description with its spacing and case ignored. */
export function likeKey(description: string | null | undefined): string | null {
  const payee = derivePayeeKey(description);
  if (payee) return payee;
  const plain = (description ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  return plain || null;
}

/** Ids of every selectable item with the same payee/description as `item` (the item itself included). */
export function idsLikeThis<T extends SelectableItem>(items: readonly T[], item: T): string[] {
  const key = likeKey(item.description);
  if (!key) return item.can_choose_category ? [item.id] : [];
  return items.filter((i) => i.can_choose_category && likeKey(i.description) === key).map((i) => i.id);
}

/** Only ids that are still listed and can be chosen here (a line approved or categorised meanwhile drops out of the selection). */
export function usableSelection<T extends SelectableItem>(items: readonly T[], selected: ReadonlySet<string>): T[] {
  return items.filter((i) => i.can_choose_category && selected.has(i.id));
}

export interface SuggestedPlan {
  /** Selected lines that have a suggested category. */
  covered: number;
  /** Selected lines with none: they are left exactly as they are. */
  notCovered: number;
  /** Lines per suggested category id. */
  perCategory: Array<{ category_id: string; count: number }>;
}

export function suggestedPlan(selectedItems: readonly SelectableItem[]): SuggestedPlan {
  const per = new Map<string, number>();
  let notCovered = 0;
  for (const i of selectedItems) {
    if (i.suggested_category_id) per.set(i.suggested_category_id, (per.get(i.suggested_category_id) ?? 0) + 1);
    else notCovered += 1;
  }
  const covered = selectedItems.length - notCovered;
  return { covered, notCovered, perCategory: [...per.entries()].map(([category_id, count]) => ({ category_id, count })) };
}

function txnWord(n: number): string {
  return `${n} ${n === 1 ? 'transaction' : 'transactions'}`;
}

const NO_APPROVAL_SENTENCE = 'This only sets the category. Nothing is approved, and nothing counts toward your income or spending until you approve it.';

/** The question asked before one category is set on several transactions. States the count and the category. */
export function confirmCategoryText(count: number, categoryLabel: string, rememberPayees: boolean): string {
  return `Set the category "${categoryLabel}" on ${txnWord(count)}? ${NO_APPROVAL_SENTENCE}${rememberPayees ? ' Each payee will also be remembered for next time.' : ''}`;
}

/** The question asked before each selected line gets its own suggested category. */
export function confirmSuggestedText(plan: SuggestedPlan, selectedCount: number, labelOf: (categoryId: string) => string, rememberPayees: boolean): string {
  const parts = plan.perCategory.map((c) => `${labelOf(c.category_id)}: ${c.count}`).join(', ');
  const rest = plan.notCovered > 0 ? ` The other ${txnWord(plan.notCovered)} ${plan.notCovered === 1 ? 'has no suggestion and stays as it is.' : 'have no suggestion and stay as they are.'}` : '';
  return `Apply the suggested category to ${plan.covered} of the ${selectedCount} selected (${parts})?${rest} ${NO_APPROVAL_SENTENCE}${rememberPayees ? ' Each payee will also be remembered for next time.' : ''}`;
}

export interface BulkResultView {
  requested: number;
  applied: number;
  unchanged: number;
  failed: Array<{ transaction_id: string; description: string | null; message: string }>;
  links_settled?: number;
  payees_remembered: number;
  payees_not_remembered: Array<{ payee_key: string; message: string }>;
}

/** The result sentence: counts for every outcome, so nothing is hidden behind "Saved". */
export function bulkResultText(r: BulkResultView): string {
  const bits: string[] = [];
  if (r.applied > 0) bits.push(`Category set on ${txnWord(r.applied)}.`);
  if (r.unchanged > 0) bits.push(`${txnWord(r.unchanged)} already had this choice and ${r.unchanged === 1 ? 'was left as it was.' : 'were left as they were.'}`);
  if (r.failed.length > 0) bits.push(`${txnWord(r.failed.length)} could not be set (listed below).`);
  if (r.applied === 0 && r.unchanged === 0 && r.failed.length === 0) bits.push('Nothing was changed.');
  if (r.payees_remembered > 0) bits.push(`We will remember ${r.payees_remembered === 1 ? '1 payee' : `${r.payees_remembered} payees`} next time.`);
  if (r.payees_not_remembered.length > 0) bits.push(`${r.payees_not_remembered.length === 1 ? '1 payee was' : `${r.payees_not_remembered.length} payees were`} not remembered.`);
  bits.push('Nothing was approved.');
  return bits.join(' ');
}
