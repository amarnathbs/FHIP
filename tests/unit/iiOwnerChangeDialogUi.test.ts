/**
 * Investment Intelligence -- the owner-change dialog, as used from the Review
 * and Resolutions tabs (2026-10-01).
 *
 * THE REPO HAS NO jsdom / testing-library (vitest runs in the node
 * environment), so this file does NOT click anything. It tests:
 *   1. the pure view-model (ownerChange.ts): percentage parsing, joint-split
 *      validity, the confirmation text -- the actual UI RULES;
 *   2. the dialog's markup with react-dom/server for each state (choose,
 *      joint editor, confirm), proving what the user is shown;
 *   3. structural contracts on the two clients (they use the dialog, send
 *      confirm:true, and the stale "percentage-split is not built" notes are
 *      gone). Interaction (focus trap, Escape, typing) is NOT executed here.
 *
 * Set OWNER_DIALOG_PREVIEW_OUT=<path.html> to also write the rendered states
 * to a standalone HTML file (used for the report's UX evidence).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OwnerChangeDialog } from '@/components/investment-intelligence/OwnerChangeDialog';
import {
  JOINT_CHOICE,
  apiErrorMessage,
  basisPointsToPercentText,
  describeOwnerChange,
  equalSplitRows,
  evaluateJointDraft,
  formatPercent,
  nextOwnershipView,
  ownerKeyOf,
  parsePercentToBasisPoints,
  selectionFromChoice,
  type JointRowDraft,
  type OwnerOptionsPayload,
  type OwnershipView,
} from '@/components/investment-intelligence/ownerChange';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SELF = id(1);
const SPOUSE = id(2);
const TRUST = id(11);
const HUF = id(12);

const payload = (over: Partial<OwnerOptionsPayload> = {}): OwnerOptionsPayload => ({
  accountId: id(100),
  current: { kind: 'member', owners: [{ kind: 'member', id: SELF, label: 'Asha Rao', detail: 'You', basisPoints: 10000 }] },
  options: [
    { kind: 'member', id: SELF, label: 'Asha Rao', detail: 'You', ownerRole: 'self' },
    { kind: 'member', id: SPOUSE, label: 'Ravi Rao', detail: 'Spouse', ownerRole: 'spouse' },
    { kind: 'entity', id: TRUST, label: 'Rao Family Trust', detail: 'Family trust', ownerRole: 'family_trust' },
    { kind: 'entity', id: HUF, label: 'Rao HUF', detail: 'Hindu Undivided Family (HUF)', ownerRole: 'other' },
  ],
  jointAvailable: true,
  published: false,
  ...over,
});

const row = (rowId: string, ownerKey: string, percentText: string): JointRowDraft => ({ rowId, ownerKey, percentText });
const mKey = (n: string) => `m:${n}`;
const noop = async () => ({ ok: true as const });

describe('parsePercentToBasisPoints', () => {
  it.each([
    ['60', 6000],
    ['33.33', 3333],
    ['33.3', 3330],
    ['100', 10000],
    ['0.5', 50],
    ['.5', 50],
    [' 12.34% ', 1234],
    ['0', 0],
  ])('"%s" -> %i', (text, bp) => expect(parsePercentToBasisPoints(text)).toBe(bp));

  it.each(['', 'abc', '-5', '1e2', '33.333', '100.01', '101', '1,5', '5 0'])('NEGATIVE CONTROL: "%s" is rejected (null)', (text) => expect(parsePercentToBasisPoints(text)).toBeNull());

  it('round-trips presentation', () => {
    expect(basisPointsToPercentText(3334)).toBe('33.34');
    expect(basisPointsToPercentText(5000)).toBe('50');
    expect(basisPointsToPercentText(6050)).toBe('60.5');
    expect(formatPercent(3334)).toBe('33.34%');
  });
});

describe('evaluateJointDraft', () => {
  it('valid 60/40 -> selection in basis points, total 100%', () => {
    const ev = evaluateJointDraft([row('a', mKey(SELF), '60'), row('b', mKey(SPOUSE), '40')]);
    expect(ev.valid).toBe(true);
    expect(ev.totalBasisPoints).toBe(10000);
    expect(ev.selection).toEqual({ kind: 'joint', allocations: [{ member_id: SELF, basis_points: 6000 }, { member_id: SPOUSE, basis_points: 4000 }] });
  });

  it('three-way equal split rows are 33.33 / 33.33 / 33.34 and valid', () => {
    const rows = equalSplitRows([mKey(SELF), mKey(SPOUSE), `e:${TRUST}`]);
    expect(rows.map((r) => r.percentText)).toEqual(['33.33', '33.33', '33.34']);
    expect(evaluateJointDraft(rows).valid).toBe(true);
  });

  it('NEGATIVE CONTROL [total]: 60 + 30 is invalid and the message says how much is left', () => {
    const ev = evaluateJointDraft([row('a', mKey(SELF), '60'), row('b', mKey(SPOUSE), '30')]);
    expect(ev.valid).toBe(false);
    expect(ev.selection).toBeNull();
    expect(ev.remainingBasisPoints).toBe(1000);
    expect(ev.problems.join(' ')).toContain('90.00%');
  });

  it('NEGATIVE CONTROL [over 100%] is invalid', () => {
    const ev = evaluateJointDraft([row('a', mKey(SELF), '70'), row('b', mKey(SPOUSE), '40')]);
    expect(ev.valid).toBe(false);
    expect(ev.problems.join(' ')).toContain('more than 100%');
  });

  it('NEGATIVE CONTROL [duplicate owner], [zero share], [one owner], [unchosen owner], [blank/ugly percent] are all invalid', () => {
    expect(evaluateJointDraft([row('a', mKey(SELF), '50'), row('b', mKey(SELF), '50')]).problems).toContain('Each owner can appear only once.');
    expect(evaluateJointDraft([row('a', mKey(SELF), '100'), row('b', mKey(SPOUSE), '0')]).valid).toBe(false);
    expect(evaluateJointDraft([row('a', mKey(SELF), '100')]).problems).toContain('Add at least two owners.');
    expect(evaluateJointDraft([row('a', '', '50'), row('b', mKey(SPOUSE), '50')]).valid).toBe(false);
    expect(evaluateJointDraft([row('a', mKey(SELF), ''), row('b', mKey(SPOUSE), '50')]).valid).toBe(false);
    expect(evaluateJointDraft([row('a', mKey(SELF), '33.333'), row('b', mKey(SPOUSE), '66.667')]).valid).toBe(false);
  });
});

describe('selectionFromChoice / nextOwnershipView', () => {
  it('maps a member, an entity and a joint choice to the API body', () => {
    expect(selectionFromChoice(mKey(SELF), []).selection).toEqual({ kind: 'member', member_id: SELF });
    expect(selectionFromChoice(`e:${TRUST}`, []).selection).toEqual({ kind: 'entity', business_entity_id: TRUST });
    expect(selectionFromChoice(JOINT_CHOICE, [row('a', mKey(SELF), '50'), row('b', `e:${TRUST}`, '50')]).selection).toEqual({
      kind: 'joint',
      allocations: [{ member_id: SELF, basis_points: 5000 }, { business_entity_id: TRUST, basis_points: 5000 }],
    });
  });
  it('NEGATIVE CONTROL: no choice, and an invalid joint, produce no selection (so "Review change" stays disabled)', () => {
    expect(selectionFromChoice('', []).selection).toBeNull();
    expect(selectionFromChoice(JOINT_CHOICE, [row('a', mKey(SELF), '50'), row('b', mKey(SPOUSE), '10')]).selection).toBeNull();
  });
  it('nextOwnershipView resolves labels from the server-provided options; an id the server did not offer yields null', () => {
    const p = payload();
    const v = nextOwnershipView({ kind: 'joint', allocations: [{ member_id: SELF, basis_points: 6000 }, { business_entity_id: TRUST, basis_points: 4000 }] }, p.options);
    expect(v?.owners.map((o) => `${o.label}:${o.basisPoints}`)).toEqual(['Asha Rao:6000', 'Rao Family Trust:4000']);
    expect(nextOwnershipView({ kind: 'member', member_id: id(99) }, p.options)).toBeNull();
  });
});

describe('describeOwnerChange: the confirmation in plain words', () => {
  const current: OwnershipView = { kind: 'member', owners: [{ kind: 'member', id: SELF, label: 'Asha Rao', detail: 'You', basisPoints: 10000 }] };

  it('joint: shows each owner with its percentage and the 100% total', () => {
    const next = nextOwnershipView({ kind: 'joint', allocations: [{ member_id: SELF, basis_points: 6000 }, { member_id: SPOUSE, basis_points: 4000 }] }, payload().options)!;
    const d = describeOwnerChange({ current, next, published: false, amend: false });
    expect(d.currentSummary).toBe('Asha Rao');
    expect(d.nextLines.map((l) => `${l.label} ${l.percent}`)).toEqual(['Asha Rao 60.00%', 'Ravi Rao 40.00%']);
    expect(d.nextTotal).toBe('100.00%');
    expect(d.consequences.join(' ')).toContain('counted once');
    expect(d.consequences[0]).toContain('not changed or recalculated');
    expect(d.blockedUntilUnpublished).toBe(false);
  });

  it('entity: says it is kept separate from personal Net Worth', () => {
    const next = nextOwnershipView({ kind: 'entity', business_entity_id: TRUST }, payload().options)!;
    const d = describeOwnerChange({ current, next, published: false, amend: false });
    expect(d.consequences.join(' ')).toContain('kept separate from your personal Net Worth');
    expect(d.consequences.join(' ')).toContain('will not be published');
    expect(d.nextTotal).toBeNull();
  });

  it('NEGATIVE CONTROL [published + entity]: warns that it will be refused until unpublished, and flags the confirm as blocked', () => {
    const next = nextOwnershipView({ kind: 'entity', business_entity_id: TRUST }, payload().options)!;
    const d = describeOwnerChange({ current, next, published: true, amend: false });
    expect(d.blockedUntilUnpublished).toBe(true);
    expect(d.consequences.join(' ')).toContain('unpublish');
  });

  it('published + member change: notes the Net Worth label updates on re-publish, and is not blocked', () => {
    const next = nextOwnershipView({ kind: 'member', member_id: SPOUSE }, payload().options)!;
    const d = describeOwnerChange({ current, next, published: true, amend: false });
    expect(d.blockedUntilUnpublished).toBe(false);
    expect(d.consequences.join(' ')).toContain('re-published');
  });

  it('amend wording says the earlier decision is kept; same-owner is called out; unassigned current reads "No owner recorded yet"', () => {
    const next = nextOwnershipView({ kind: 'member', member_id: SELF }, payload().options)!;
    expect(describeOwnerChange({ current, next, published: false, amend: true }).consequences.join(' ')).toContain('earlier decision is kept');
    expect(describeOwnerChange({ current, next, published: false, amend: false }).sameAsCurrent).toBe(true);
    expect(describeOwnerChange({ current: { kind: 'unassigned', owners: [] }, next, published: false, amend: false }).currentSummary).toBe('No owner recorded yet');
  });
});

describe('apiErrorMessage reads both error body shapes', () => {
  it('prefers the readable message of { error: CODE, message }', () => {
    expect(apiErrorMessage({ error: 'OWNER_CHANGE_NOT_CONFIRMED', message: 'Please confirm.' }, 'x')).toBe('Please confirm.');
    expect(apiErrorMessage({ error: 'Account not found.' }, 'x')).toBe('Account not found.');
    expect(apiErrorMessage(null, 'fallback')).toBe('fallback');
  });
});

describe('OwnerChangeDialog markup (react-dom/server)', () => {
  const render = (props: Partial<Parameters<typeof OwnerChangeDialog>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(OwnerChangeDialog, {
        accountId: id(100),
        accountLabel: '12345678 · Example AMC',
        mode: 'review',
        submit: noop,
        onClose: () => undefined,
        onDone: () => undefined,
        preloaded: payload(),
        ...props,
      })
    );

  it('choose step: members, then trusts/HUFs/companies, then "Jointly owned"; current owner shown; it is a labelled modal dialog', () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Current owner: ');
    expect(html).toContain('Asha Rao');
    expect(html).toContain('People in your household');
    expect(html).toContain('Trusts, HUFs and companies');
    expect(html).toContain('Rao Family Trust');
    expect(html).toContain('Rao HUF');
    expect(html).toContain('Jointly owned');
    expect(html).toContain('Review change');
    expect(html).not.toContain('Confirm owner change'); // nothing is saveable before the confirmation step
    expect(html.indexOf('People in your household')).toBeLessThan(html.indexOf('Trusts, HUFs and companies'));
    expect(html.indexOf('Trusts, HUFs and companies')).toBeLessThan(html.indexOf('Jointly owned'));
  });

  it('"Review change" is disabled until a valid choice exists', () => {
    expect(render()).toMatch(/<button[^>]*\sdisabled=""[^>]*>Review change<\/button>/);
    expect(render({ initialChoice: mKey(SPOUSE) })).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Review change<\/button>/);
  });

  it('joint editor: rows, percentage inputs, the running total and "Split equally"', () => {
    const html = render({ initialChoice: JOINT_CHOICE, initialJointRows: [row('a', mKey(SELF), '60'), row('b', mKey(SPOUSE), '30')] });
    expect(html).toContain('Add an owner');
    expect(html).toContain('Split equally');
    expect(html).toContain('data-testid="joint-total"');
    expect(html).toContain('Total: 90.00%');
    expect(html).toContain('10.00% still to assign');
    expect(html).toContain('They must add up to exactly 100%'); // the problem list
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Review change<\/button>/); // 90% cannot proceed
  });

  it('joint editor with a valid split enables Review change and shows "adds up to 100%"', () => {
    const html = render({ initialChoice: JOINT_CHOICE, initialJointRows: [row('a', mKey(SELF), '60'), row('b', mKey(SPOUSE), '40')] });
    expect(html).toContain('adds up to 100%');
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Review change<\/button>/);
  });

  it('joint-only (a joint-holding case): no single-owner choices are offered, and the statement\'s named holders are pre-filled equally', () => {
    const html = render({ jointOnly: true, holderHint: 'A**** R** / R**** R**', suggestedJointMemberIds: [SELF, SPOUSE] });
    expect(html).toContain('prints a joint holding');
    expect(html).toContain('A**** R** / R**** R**');
    expect(html).not.toContain('People in your household');
    expect(html).toContain('Total: 100.00%');
  });

  it('confirm step: current -> new owner, the percentages, the plain-words consequences, and an explicit confirm button', () => {
    const html = render({ initialStep: 'confirm', initialChoice: JOINT_CHOICE, initialJointRows: [row('a', mKey(SELF), '60'), row('b', `e:${TRUST}`, '40')] });
    expect(html).toContain('Please confirm this change');
    expect(html).toContain('Current owner');
    expect(html).toContain('New owner');
    expect(html).toContain('Asha Rao');
    expect(html).toContain('60.00%');
    expect(html).toContain('40.00%');
    expect(html).toContain('Total 100.00%');
    expect(html).toContain('What this means');
    expect(html).toContain('kept separate from your personal Net Worth');
    expect(html).toContain('Confirm owner change');
    expect(html).toContain('Back');
  });

  it('confirm step for an already-published account moving under an entity: the confirm button is DISABLED and the reason is shown', () => {
    const html = render({ initialStep: 'confirm', initialChoice: `e:${TRUST}`, preloaded: payload({ published: true }) });
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Confirm owner change<\/button>/);
    expect(html).toContain('unpublish its positions');
  });

  it('amend mode is titled as an amendment', () => {
    expect(render({ mode: 'amend' })).toContain('Amend the owner');
  });

  it('with no entity set up it points the user to add one first', () => {
    const html = render({ preloaded: payload({ options: payload().options.filter((o) => o.kind === 'member') }) });
    expect(html).toContain('You have no trust, HUF or company set up yet');
    expect(html).toContain('href="/companies"');
  });
});

describe('Review and Resolutions clients (structural contract)', () => {
  const review = read('components/investment-intelligence/ReviewCentreClient.tsx');
  const resolutions = read('components/investment-intelligence/ResolutionHistoryClient.tsx');

  it('Review uses the dialog for owner cases AND joint-holding cases, and sends confirm:true to the owner route', () => {
    expect(review).toContain('<OwnerChangeDialog');
    expect(review).toContain('Split ownership…');
    expect(review).toContain('Choose the owner…');
    expect(review).toContain('confirm: true');
    expect(review).toContain("/api/investment-intelligence/accounts/${encodeURIComponent(target.accountId)}/owner");
    expect(review).toContain('case_id: target.caseId');
  });

  it('NEGATIVE CONTROL [stale notes]: the "percentage-split screen is not built" wording is gone from Review', () => {
    expect(review).not.toMatch(/does not yet support/);
    expect(review).not.toMatch(/not yet built/);
    expect(review).not.toMatch(/percentage-split\s+decision, which this screen/);
  });

  it('Review no longer offers the old one-click household-member Assign (every owner change goes through the confirmation step)', () => {
    expect(review).not.toContain('assignOwner(');
    expect(review).not.toContain('Choose a household member');
  });

  it('the one other caller of the owner route (Statements & data statement detail) still works: it now confirms and sends confirm:true', () => {
    const data = read('components/investment-intelligence/InvestmentIntelligenceClient.tsx');
    expect(data).toContain('body: JSON.stringify({ ownerMemberId, confirm: true })');
    expect(data).toContain('window.confirm(`Assign this account to ${memberName}?');
    expect(data).toContain('json.message ?? json.error');
  });

  it('Resolutions uses the dialog for amendments, sends confirm:true, and shows joint / entity decisions', () => {
    expect(resolutions).toContain('<OwnerChangeDialog');
    expect(resolutions).toContain('mode="amend"');
    expect(resolutions).toContain('confirm: true');
    expect(resolutions).toContain("'Split as'");
    expect(resolutions).not.toContain('Choose a household member');
  });
});

describe('optional preview output', () => {
  it('writes the rendered states to OWNER_DIALOG_PREVIEW_OUT when set (UX evidence for the report)', () => {
    const out = process.env.OWNER_DIALOG_PREVIEW_OUT;
    if (!out) return;
    const states: { title: string; props: Partial<Parameters<typeof OwnerChangeDialog>[0]> }[] = [
      { title: '1. Review tab — choose the owner (member, trust/HUF/company, or joint)', props: { initialChoice: `e:${TRUST}` } },
      { title: '2. Joint split editor — 60 / 30 (total 90%, cannot continue)', props: { initialChoice: JOINT_CHOICE, initialJointRows: [row('a', mKey(SELF), '60'), row('b', mKey(SPOUSE), '30')] } },
      { title: '3. Joint-holding case — statement holders pre-filled equally (joint only)', props: { jointOnly: true, holderHint: 'A**** R** / R**** R**', suggestedJointMemberIds: [SELF, SPOUSE] } },
      { title: '4. Confirmation — joint 60/40 with a trust (current → new, consequences)', props: { initialStep: 'confirm', initialChoice: JOINT_CHOICE, initialJointRows: [row('a', mKey(SELF), '60'), row('b', `e:${TRUST}`, '40')] } },
      { title: '5. Confirmation — already published, moving under a trust (confirm disabled)', props: { initialStep: 'confirm', initialChoice: `e:${TRUST}`, preloaded: payload({ published: true }) } },
      { title: '6. Resolutions tab — amend a decision', props: { mode: 'amend', initialChoice: mKey(SPOUSE) } },
    ];
    const panels = states
      .map((s) => {
        const html = renderToStaticMarkup(
          createElement(OwnerChangeDialog, { accountId: id(100), accountLabel: '12345678 · Example AMC', mode: 'review', submit: noop, onClose: () => undefined, onDone: () => undefined, preloaded: payload(), ...s.props })
        );
        // The dialog is position:fixed over the page; in this preview each state sits in its own frame.
        const framed = html.replace('class="fixed inset-0 z-50 flex items-center justify-center p-4"', 'class="relative flex items-start justify-center p-4"').replace('class="absolute inset-0 bg-black/40"', 'class="hidden"');
        return `<section class="mb-10"><h3 class="mb-2 text-sm font-semibold text-slate-600">${s.title}</h3><div class="rounded-xl bg-slate-200 p-4">${framed}</div></section>`;
      })
      .join('\n');
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>Owner change dialog — preview</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={theme:{extend:{colors:{trust:{DEFAULT:'#2563EB'},primary:{DEFAULT:'#2563EB'},positive:{DEFAULT:'#198754'},attention:{DEFAULT:'#B7791F'},risk:{DEFAULT:'#C7362F'},ink:{DEFAULT:'#172033'},muted:{DEFAULT:'#5B677A'},line:{DEFAULT:'#DDE3EA'}},borderRadius:{card:'0.75rem',compact:'0.5rem'}}}}</script>
</head><body class="bg-slate-100 p-6 font-sans"><h1 class="mb-1 text-xl font-semibold">Owner-change dialog — static render of each state</h1><p class="mb-6 text-sm text-slate-600">Server-rendered markup of OwnerChangeDialog (react-dom/server) with the real component code and sample data; no interaction. Fixture names are invented.</p>${panels}</body></html>`;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, page, 'utf8');
    expect(fs.existsSync(out)).toBe(true);
  });
});

// keep `ownerKeyOf` exercised as part of the public helper surface
describe('ownerKeyOf', () => {
  it('prefixes member / entity ids so they cannot collide', () => {
    expect(ownerKeyOf({ kind: 'member', id: 'x' })).toBe('m:x');
    expect(ownerKeyOf({ kind: 'entity', id: 'x' })).toBe('e:x');
  });
});
