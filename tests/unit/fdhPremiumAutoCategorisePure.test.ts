/**
 * Premium automatic categorisation (PO 05-11-2026) -- the pure rules. Synthetic wording only.
 *
 * Pinned here: which lines get a fixed answer instead of going to the AI (people, unidentified credits, the review's own suggestion) and which are
 * left alone; the best-guess answer rules (a low-confidence guess is kept, "unknown" becomes Other spending, a misbehaving model is still ignored) and
 * that the DEFAULT mode is unchanged; the prompt; the audit-event state machine behind the banner; the banner words.
 */
import { describe, it, expect } from 'vitest';
import {
  AUTO_SOURCE, AUTO_UNDO_SOURCE, autoBannerLines, emptyAutoSummary, planFixedPlacements, readAutoState, summaryBucket, type AuditEventRow,
} from '@/lib/financial-data-hub/domain/premiumAutoCategorise';
import type { NeedsDecisionItem } from '@/lib/financial-data-hub/domain/categoryReview';
import { allowedAiCategories, buildAiBatches, looksLikePersonName, payeeTextForAi, resolveAiAnswer, type AiCandidateLine } from '@/lib/financial-data-hub/domain/bankAiCategorise';
import { buildOwnIdentity, nameOnlyNarrativeKind } from '@/lib/financial-data-hub/classification/ownIdentity';
import { bankCategoriseAnswerSchema } from '@/lib/aie/adapters/bankCategorise/schema';
import { buildBankCategoriseSystemPrompt } from '@/lib/aie/adapters/bankCategorise/gateway';

const item = (over: Partial<NeedsDecisionItem> & Pick<NeedsDecisionItem, 'id'>): NeedsDecisionItem => ({
  transaction_date: '2026-10-01', description: 'X', amount: 10, currency: 'AUD', direction: 'out', reason: 'uncategorised', reason_text: '',
  can_choose_category: true, current_category_id: null, suggested_category_id: null, ...over,
});

describe('fixed answers for the lines the AI may never see', () => {
  it('a payment to a person -> Payments to People; money in -> Other Income; the review\'s own suggestion is taken as it is', () => {
    const plan = planFixedPlacements([
      item({ id: 'p', description: 'Osko Payment To Jordan Smith Ref#Gift' }),
      item({ id: 'c', description: 'Quillfeather Studio Pty Ltd', direction: 'in' }),
      item({ id: 's', description: 'Linked Acc Trns To Savings', suggested_category_id: 'cat-transfer' }),
    ]);
    expect(plan).toMatchObject([
      { id: 'p', categoryKey: 'payments_to_people', categoryId: null },
      { id: 'c', categoryKey: 'income', subcategoryKey: 'other_income' },
      { id: 's', categoryKey: null, categoryId: 'cat-transfer' },
    ]);
  });

  it('LOOK-ALIKES that must be left alone: a business payment (the AI\'s job), a large amount, a transfer check, a line that already has a category', () => {
    expect(planFixedPlacements([
      item({ id: 'a', description: 'VISA-SOME NEW CAFE' }), // money out to a business: the AI, or the person if the AI could not be asked
      item({ id: 'b', description: 'Osko Payment To Jordan Smith', reason: 'large_amount' }),
      item({ id: 'c', description: 'Osko Payment To Jordan Smith', reason: 'transfer_check' }),
      item({ id: 'd', description: 'Osko Payment To Jordan Smith', current_category_id: 'cat-x' }),
      item({ id: 'e', description: 'Salary', direction: 'in', reason: 'possible_duplicate' }),
    ])).toEqual([]);
  });
});

describe('best-guess answers', () => {
  const lines: AiCandidateLine[] = ['ALPHA CAFE', 'BETA STORE', 'GAMMA CO', 'DELTA CO', 'EPSILON CO'].map((n, i) => ({
    id: `t${i}`, description: `VISA-${n}`, direction: 'out', reason: 'uncategorised', currentCategoryId: null, suggestedCategoryId: null,
  }));
  const batch = buildAiBatches(lines)[0];
  const allowed = allowedAiCategories([
    { id: 'c-food', category_key: 'food', display_name: 'Food', economic_type: 'expense' },
    { id: 'c-house', category_key: 'housing', display_name: 'Housing', economic_type: 'expense' },
  ]);
  const key = (t: string) => batch.payees.find((p) => p.text.includes(t))!.key;
  const answer = bankCategoriseAnswerSchema.parse({
    items: [
      { key: key('ALPHA'), categoryKey: 'food', confidence: 'high' },
      { key: key('BETA'), categoryKey: 'housing', confidence: 'low' },
      { key: key('GAMMA'), categoryKey: 'unknown', confidence: 'low' },
      { key: key('DELTA'), categoryKey: 'income', confidence: 'high' }, // outside the closed list
      // EPSILON: missing
    ],
  });

  it('DEFAULT mode is unchanged: low confidence and "unknown" stay unknown (the manual button keeps its rules)', () => {
    const r = resolveAiAnswer(answer, batch, allowed);
    expect([...r.accepted.keys()]).toEqual(['ALPHA CAFE']);
    expect(Object.fromEntries(r.rejected)).toEqual({ 'BETA STORE': 'low_confidence', 'GAMMA CO': 'unknown_answer', 'DELTA CO': 'not_in_list', 'EPSILON CO': 'missing' });
    expect(r.otherSpending.size).toBe(0);
    expect(r.guessed.size).toBe(0);
  });

  it('BEST-GUESS mode keeps the low-confidence guess, files "unknown" as Other spending, and STILL ignores a category outside the list and a missing item', () => {
    const r = resolveAiAnswer(answer, batch, allowed, { bestGuess: true });
    expect([...r.accepted.keys()].sort()).toEqual(['ALPHA CAFE', 'BETA STORE']);
    expect([...r.guessed]).toEqual(['BETA STORE']);
    expect([...r.otherSpending]).toEqual(['GAMMA CO']);
    expect(Object.fromEntries(r.rejected)).toEqual({ 'DELTA CO': 'not_in_list', 'EPSILON CO': 'missing' });
  });
});

describe('the prompt', () => {
  const allowed = [{ key: 'food', label: 'Food & Dining' }];
  it('the DEFAULT prompt still tells the model to answer "unknown" when unsure; the best-guess prompt asks for the closest category and a "low" mark', () => {
    const normal = buildBankCategoriseSystemPrompt(allowed);
    const guess = buildBankCategoriseSystemPrompt(allowed, { bestGuess: true });
    expect(normal).toContain('If you are not sure, or it could reasonably be several categories, or you cannot tell what the business is, answer "unknown" with confidence "low".');
    expect(guess).not.toContain('If you are not sure');
    expect(guess).toContain('Always choose the closest category on the list');
    expect(guess).toContain('mark a guess with confidence "low"');
    // Everything else is identical, so the closed list and the output contract are untouched.
    expect(guess.replace(/Always choose[^]*?could possibly apply\. /, '')).toBe(normal.replace(/If you are not sure[^]*?confidence "low"\. /, ''));
  });
});

describe('the banner state is read from the audit events, in any order', () => {
  const ev = (at: string, source: string, extra: Record<string, unknown> = {}, type = 'bulk_review_action_completed'): AuditEventRow => ({ event_type: type, created_at: at, metadata: { source, ...extra } });
  const summary = { ...emptyAutoSummary(), approved_lines: 5 };

  it('nothing yet: not run; started only: run but no banner; completed: banner; undone after: no banner but still "ran"', () => {
    expect(readAutoState([])).toEqual({ ran: false, summary: null });
    expect(readAutoState([ev('2026-11-05T01:00:00Z', AUTO_SOURCE, { phase: 'started' }, 'transaction_classification_run')])).toEqual({ ran: true, summary: null });
    const done = ev('2026-11-05T01:01:00Z', AUTO_SOURCE, { phase: 'completed', summary });
    expect(readAutoState([done]).summary).toEqual(summary);
    const undo = ev('2026-11-05T02:00:00Z', AUTO_UNDO_SOURCE);
    expect(readAutoState([undo, done])).toEqual({ ran: true, summary: null });
    expect(readAutoState([done, undo])).toEqual({ ran: true, summary: null }); // order of the list does not matter
  });

  it('LOOK-ALIKE: other bulk-review events, and an event from another source, are not part of it', () => {
    expect(readAutoState([ev('2026-11-05T01:00:00Z', 'something_else', { phase: 'completed', summary }), { event_type: 'bulk_review_action_completed', created_at: '2026-11-05T01:00:00Z', metadata: null }]))
      .toEqual({ ran: false, summary: null });
  });
});

describe('the words', () => {
  it('say what was counted, how many are NOT counted as spending or income, where the guesses came from, and how to undo', () => {
    const s = { ...emptyAutoSummary(), approved_lines: 100, income_lines: 30, spending_lines: 60, not_counted_lines: 10, placed_by_ai: 12, guessed_by_ai: 3, other_spending_lines: 2, placed_by_fixed_answer: 4, left_for_you: 2 };
    const text = autoBannerLines(s).join(' ');
    expect(text).toContain('100 transactions');
    expect(text).toContain('10 as moves that are not counted as income or spending');
    expect(text).toContain('3 of them best guesses');
    expect(text).toContain('2 were filed as Other spending');
    expect(text).toContain('2 transactions still need you');
    expect(text).toContain('Undo');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/); // never a yyyy-mm-dd date
  });
  it('the buckets follow the canonical effect of the group', () => {
    expect(['income', 'spending', 'not_counted', 'reduces_spending', 'refund_unlinked', 'split'].map((e) => summaryBucket(e as never)))
      .toEqual(['income_lines', 'spending_lines', 'not_counted_lines', 'other_lines', 'other_lines', 'other_lines']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Found by running the AI on the PO's two real NAB statements (05-11-2026): names inside bank lines reached the provider, and the model answered with
// the category's display name instead of its key, which lost half the answers.
// ---------------------------------------------------------------------------------------------------------------------------------

describe('a name inside a bank line is never sent to the AI', () => {
  it('a person\'s name (an initial or a title, no card wrapper, no business word) and a bare bank transfer are not sent', () => {
    for (const d of ['STEFANIE ZAJAKOVSKI V', 'U RANASINGHE C 12345', 'P HARANI Q', 'AMARNATH SURENDRA BE A', 'MR VIPIN BHATIA R LUNCH', 'U RANASINGHE D PAYMENT FOR FENCE', 'INTERNET TRANSFER FUNDS TRNS 998877']) {
      expect(payeeTextForAi(d), d).toBeNull();
    }
    expect(looksLikePersonName('STEFANIE ZAJAKOVSKI V')).toBe(true);
  });
  it('LOOK-ALIKES that are shops stay AI questions: a card purchase that ends in a letter, a company word, a single word', () => {
    for (const d of ['V SQ ST ALBANS ST A', 'V PAHAL GROUP PTY LTD ST A', 'VISA-SOME NEW CAFE', 'EFTPOS TASMAN BUTCHERS', 'Direct Debit Acme Gym Pty Ltd', 'KRISPY KREME MELBOUR', 'HARTNA']) {
      expect(payeeTextForAi(d), d).not.toBeNull();
    }
    expect(looksLikePersonName('V SQ ST ALBANS ST A')).toBe(false);
  });
  it('a person-name money-out line gets the fixed Payments to People answer, and an unreadable one is filed as Other spending', () => {
    const plan = planFixedPlacements([
      item({ id: 'n', description: 'STEFANIE ZAJAKOVSKI V' }),
      item({ id: 'u', description: '12345 6789' }),
      item({ id: 't', description: 'INTERNET TRANSFER FUNDS TRNS' }),
    ]);
    expect(plan).toMatchObject([
      { id: 'n', categoryKey: 'payments_to_people' },
      { id: 'u', categoryKey: null, otherSpending: true },
      { id: 't', categoryKey: 'payments_to_people' },
    ]);
  });
});

describe('the model answering with the category name instead of its key', () => {
  const lines: AiCandidateLine[] = ['ALPHA CAFE', 'BETA STORE', 'GAMMA CO'].map((n, i) => ({ id: `t${i}`, description: `VISA-${n}`, direction: 'out', reason: 'uncategorised', currentCategoryId: null, suggestedCategoryId: null }));
  const batch = buildAiBatches(lines)[0];
  const allowed = allowedAiCategories([
    { id: 'c-food', category_key: 'food', display_name: 'Food & Dining', economic_type: 'expense' },
    { id: 'c-house', category_key: 'housing', display_name: 'Housing', economic_type: 'expense' },
  ]);
  const key = (t: string) => batch.payees.find((p) => p.text.includes(t))!.key;
  it('an answer that is exactly an offered NAME (any case or spacing) is that category; any other text is still not in the list', () => {
    const r = resolveAiAnswer(bankCategoriseAnswerSchema.parse({
      items: [
        { key: key('ALPHA'), categoryKey: 'Food & Dining', confidence: 'high' },
        { key: key('BETA'), categoryKey: '  housing ', confidence: 'medium' }, // not the key exactly, but the name ignoring case and spacing
        { key: key('GAMMA'), categoryKey: 'Food and Dining', confidence: 'high' }, // not an offered name
      ],
    }), batch, allowed);
    expect([...r.accepted.entries()].map(([t, c]) => [t, c.key]).sort()).toEqual([['ALPHA CAFE', 'food'], ['BETA STORE', 'housing']]);
    expect(r.rejected.get('GAMMA CO')).toBe('not_in_list');
  });
  it('the prompt tells the model to answer with the key, in both modes', () => {
    for (const bestGuess of [false, true]) {
      expect(buildBankCategoriseSystemPrompt([{ key: 'food', label: 'Food & Dining' }], { bestGuess })).toContain('categoryKey must be the key written before the bracket');
    }
  });
});

describe('the holder\'s own name cut off by the bank\'s name field is the holder (own-account transfer evidence)', () => {
  const identity = buildOwnIdentity({ selfName: 'Amarnath Bekal', householdNames: [], accountIdentifiers: [], narratives: [] });
  it('"AMARNATH SURENDRA BE" + a reference letter and digits is self', () => {
    expect(nameOnlyNarrativeKind('AMARNATH SURENDRA BE R1234567890', identity)).toBe('self');
    expect(nameOnlyNarrativeKind('AMARNATH SURENDRA BE', identity)).toBe('self');
  });
  it('LOOK-ALIKES stay questions: a different surname, a different first name, a short name, a business word', () => {
    for (const d of ['AMARNATH SURENDRA BEDI R123', 'AMARNATH SURENDRA BHAT R123', 'RAJESH SURENDRA BE R123', 'AMARNATH B', 'AMARNATH BE', 'AMARNATH SURENDRA BE PTY LTD']) {
      expect(nameOnlyNarrativeKind(d, identity), d).toBeNull();
    }
  });
});
