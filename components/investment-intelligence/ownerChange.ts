// Investment Intelligence -- owner-change dialog: pure view-model helpers
// (2026-10-01).
//
// WHY THIS IS A SEPARATE, PURE FILE. This repo's vitest baseline is
// node-environment only (no jsdom / testing-library), so the dialog's own
// rules -- how a typed percentage becomes basis points, when a joint split is
// valid, what the confirmation says in plain words -- live here, where they
// are unit-tested directly. OwnerChangeDialog.tsx only renders what this
// returns. The SERVER stays authoritative: every rule here is a courtesy
// mirror of `validateOwnerSelection()` (lib/services/investment-intelligence/
// ownerModel.ts) so the user is told early; nothing here is a security check.

import { PC5_TOTAL_BASIS_POINTS, defaultEqualAllocation } from '@/lib/pc5/jointAllocation';

export interface OwnerOptionView {
  kind: 'member' | 'entity';
  id: string;
  label: string;
  detail: string;
  ownerRole: string;
}

export interface OwnershipView {
  kind: 'unassigned' | 'member' | 'entity' | 'joint';
  owners: { kind: 'member' | 'entity'; id: string; label: string; detail: string; basisPoints: number }[];
}

export interface OwnerOptionsPayload {
  accountId: string;
  current: OwnershipView;
  options: OwnerOptionView[];
  jointAvailable: boolean;
  published: boolean;
}

/** A single owner is identified in the UI by "m:<uuid>" / "e:<uuid>". */
export const ownerKeyOf = (o: { kind: 'member' | 'entity'; id: string }) => `${o.kind === 'member' ? 'm' : 'e'}:${o.id}`;
export function ownerRefFromKey(key: string): { member_id: string } | { business_entity_id: string } | null {
  if (key.startsWith('m:') && key.length > 2) return { member_id: key.slice(2) };
  if (key.startsWith('e:') && key.length > 2) return { business_entity_id: key.slice(2) };
  return null;
}

/** The request body fragment the PATCH / amend routes accept. Mirrors ownerSelectionSchema. */
export type OwnerSelectionBody =
  | { kind: 'member'; member_id: string }
  | { kind: 'entity'; business_entity_id: string }
  | { kind: 'joint'; allocations: { member_id?: string; business_entity_id?: string; basis_points: number }[] };

/** The sentinel choice meaning "jointly owned". Not an owner key, so it can never collide with one. */
export const JOINT_CHOICE = 'joint';

// ---------------------------------------------------------------------------
// Percentages <-> basis points
// ---------------------------------------------------------------------------

/**
 * "33.33" -> 3333. Accepts digits with an optional "." and at most TWO decimal
 * places (basis points are hundredths of a percent); a trailing "%" and
 * surrounding spaces are tolerated. Anything else -- empty, negative,
 * scientific notation, more than two decimals, above 100 -- is null.
 */
export function parsePercentToBasisPoints(text: string): number | null {
  const t = text.trim().replace(/%$/, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t) && !/^\.\d{1,2}$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const bp = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isFinite(bp) || bp > PC5_TOTAL_BASIS_POINTS) return null;
  return bp;
}

/** 3334 -> "33.34". Presentation only. */
export function basisPointsToPercentText(bp: number): string {
  const text = (bp / 100).toFixed(2);
  return text.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}
/** 3334 -> "33.34%". Always two decimals. Presentation only. */
export const formatPercent = (bp: number) => `${(bp / 100).toFixed(2)}%`;

// ---------------------------------------------------------------------------
// Joint split draft
// ---------------------------------------------------------------------------

export interface JointRowDraft {
  /** Stable React key. */
  rowId: string;
  /** "m:<uuid>" / "e:<uuid>" or "" while unchosen. */
  ownerKey: string;
  /** What the user typed, e.g. "60" or "33.33". */
  percentText: string;
}

export const MAX_JOINT_OWNERS = 10;

/** K.6's default: equal shares, remainder to the last owner (so 3 owners = 33.33 / 33.33 / 33.34). */
export function equalSplitRows(ownerKeys: readonly string[], idPrefix = 'row'): JointRowDraft[] {
  const allocation = defaultEqualAllocation(ownerKeys.map((k) => ({ ownerMemberId: k })));
  return ownerKeys.map((k, i) => ({ rowId: `${idPrefix}-${i}`, ownerKey: k, percentText: basisPointsToPercentText(allocation[i].basisPoints) }));
}

export interface JointDraftEvaluation {
  /** Sum of every row that parsed, in basis points. */
  totalBasisPoints: number;
  /** 10000 - total; negative when over-allocated. */
  remainingBasisPoints: number;
  /** Plain-words problems, in the order a user should fix them. Empty when valid. */
  problems: string[];
  valid: boolean;
  /** Present only when valid. */
  selection: Extract<OwnerSelectionBody, { kind: 'joint' }> | null;
}

export function evaluateJointDraft(rows: readonly JointRowDraft[]): JointDraftEvaluation {
  const problems: string[] = [];
  let total = 0;
  const seen = new Set<string>();
  const allocations: { member_id?: string; business_entity_id?: string; basis_points: number }[] = [];

  if (rows.length < 2) problems.push('Add at least two owners.');
  if (rows.length > MAX_JOINT_OWNERS) problems.push(`A joint split can have at most ${MAX_JOINT_OWNERS} owners.`);

  rows.forEach((row, i) => {
    const n = i + 1;
    const ref = row.ownerKey ? ownerRefFromKey(row.ownerKey) : null;
    if (!ref) {
      problems.push(`Choose an owner for line ${n}.`);
    } else if (seen.has(row.ownerKey)) {
      problems.push('Each owner can appear only once.');
    } else {
      seen.add(row.ownerKey);
    }
    const bp = parsePercentToBasisPoints(row.percentText);
    if (bp === null) {
      problems.push(row.percentText.trim() === '' ? `Enter a percentage for line ${n}.` : `Line ${n}: use a percentage with at most two decimal places, for example 33.33.`);
    } else if (bp <= 0) {
      problems.push(`Line ${n}: each owner needs a share greater than 0%.`);
    } else {
      total += bp;
      if (ref) allocations.push({ ...ref, basis_points: bp });
    }
  });

  if (total !== PC5_TOTAL_BASIS_POINTS && rows.every((r) => parsePercentToBasisPoints(r.percentText) !== null)) {
    problems.push(total < PC5_TOTAL_BASIS_POINTS ? `The shares add up to ${formatPercent(total)}. They must add up to exactly 100%.` : `The shares add up to ${formatPercent(total)}, which is more than 100%.`);
  }

  const unique = Array.from(new Set(problems));
  const valid = unique.length === 0;
  return {
    totalBasisPoints: total,
    remainingBasisPoints: PC5_TOTAL_BASIS_POINTS - total,
    problems: unique,
    valid,
    selection: valid ? { kind: 'joint', allocations } : null,
  };
}

// ---------------------------------------------------------------------------
// The choice -> request body
// ---------------------------------------------------------------------------

export function selectionFromChoice(choice: string, jointRows: readonly JointRowDraft[]): { selection: OwnerSelectionBody | null; problems: string[] } {
  if (!choice) return { selection: null, problems: ['Choose who owns this account.'] };
  if (choice === JOINT_CHOICE) {
    const ev = evaluateJointDraft(jointRows);
    return { selection: ev.selection, problems: ev.problems };
  }
  const ref = ownerRefFromKey(choice);
  if (!ref) return { selection: null, problems: ['Choose who owns this account.'] };
  return { selection: 'member_id' in ref ? { kind: 'member', member_id: ref.member_id } : { kind: 'entity', business_entity_id: ref.business_entity_id }, problems: [] };
}

// ---------------------------------------------------------------------------
// The confirmation step, in plain words
// ---------------------------------------------------------------------------

export interface OwnerLine {
  label: string;
  detail: string;
  /** Present for joint lines. */
  percent?: string;
}

export interface OwnerChangeDescription {
  currentLines: OwnerLine[];
  currentSummary: string;
  nextLines: OwnerLine[];
  nextSummary: string;
  /** Joint only: "100.00%". */
  nextTotal: string | null;
  consequences: string[];
  /** True when this change would be refused today because the account is already in personal Net Worth and the new owner involves an entity. */
  blockedUntilUnpublished: boolean;
  sameAsCurrent: boolean;
}

function linesFor(view: OwnershipView): OwnerLine[] {
  return view.owners.map((o) => ({ label: o.label, detail: o.detail, ...(view.kind === 'joint' ? { percent: formatPercent(o.basisPoints) } : {}) }));
}
function summaryFor(view: OwnershipView): string {
  if (view.kind === 'unassigned') return 'No owner recorded yet';
  if (view.kind === 'joint') return `Jointly owned: ${view.owners.map((o) => `${o.label} ${formatPercent(o.basisPoints)}`).join(' / ')}`;
  return view.owners[0]?.label ?? 'Unknown';
}

/** Builds the NEXT ownership view from the choice, using the options the server returned. null when the choice is incomplete. */
export function nextOwnershipView(selection: OwnerSelectionBody | null, options: readonly OwnerOptionView[]): OwnershipView | null {
  if (!selection) return null;
  const byKey = new Map(options.map((o) => [ownerKeyOf(o), o] as const));
  const pick = (ref: { member_id?: string; business_entity_id?: string }) => (ref.member_id ? byKey.get(`m:${ref.member_id}`) : ref.business_entity_id ? byKey.get(`e:${ref.business_entity_id}`) : undefined);
  if (selection.kind === 'joint') {
    const owners: OwnershipView['owners'] = [];
    for (const a of selection.allocations) {
      const o = pick(a);
      if (!o) return null;
      owners.push({ kind: o.kind, id: o.id, label: o.label, detail: o.detail, basisPoints: a.basis_points });
    }
    return { kind: 'joint', owners };
  }
  const o = pick(selection);
  if (!o) return null;
  return { kind: o.kind, owners: [{ kind: o.kind, id: o.id, label: o.label, detail: o.detail, basisPoints: PC5_TOTAL_BASIS_POINTS }] };
}

export function sameOwnershipView(a: OwnershipView, b: OwnershipView): boolean {
  const key = (v: OwnershipView) => (v.kind === 'unassigned' ? 'unassigned' : `${v.owners.length > 1 ? 'joint' : v.owners[0]?.kind}|${v.owners.map((o) => `${o.kind}:${o.id}:${o.basisPoints}`).sort().join(',')}`);
  return key(a) === key(b);
}

export function describeOwnerChange(input: { current: OwnershipView; next: OwnershipView; published: boolean; amend: boolean; notJoint?: boolean }): OwnerChangeDescription {
  const { current, next, published } = input;
  const hasEntity = next.owners.some((o) => o.kind === 'entity');
  const consequences: string[] = ['The holdings and transactions in this account are not changed or recalculated. Only who they are attributed to changes.'];

  if (next.kind === 'member') {
    consequences.push(`This account will be treated as owned by ${next.owners[0].label} alone.`);
  } else if (next.kind === 'entity') {
    consequences.push(`This account will be owned by ${next.owners[0].label} (${next.owners[0].detail.toLowerCase()}).`);
  } else if (next.kind === 'joint') {
    consequences.push(`This account will be recorded as jointly owned: ${next.owners.map((o) => `${o.label} ${formatPercent(o.basisPoints)}`).join(', ')}. The shares add up to 100%.`);
  }

  if (input.notJoint) {
    consequences.push('You are confirming this account is not jointly held. The joint-holding issue is closed with that decision recorded in your audit history, and the value is attributed to this single owner only (it is never counted twice).');
  }

  if (hasEntity) {
    consequences.push(
      'Holdings owned by a trust, HUF or company are kept separate from your personal Net Worth. This account will not be published to your personal Net Worth, and it will no longer appear under "Imported, not yet in Net Worth".'
    );
  } else if (next.kind === 'joint') {
    consequences.push('The account is still counted once in your household Net Worth; the split only records who owns what share.');
  }

  let blockedUntilUnpublished = false;
  if (published && hasEntity) {
    blockedUntilUnpublished = true;
    consequences.push('This account is already counted in your personal Net Worth, so this change will be refused until you unpublish its positions from Statements & data.');
  } else if (published) {
    consequences.push('This account is already in your Net Worth. Its owner label there is updated the next time the position is re-published.');
  }

  consequences.push(
    input.amend
      ? 'The earlier decision is kept in history and marked as superseded by this one. Nothing is deleted.'
      : 'This is saved to your audit history. You can amend it later from the Resolutions tab; earlier decisions are never deleted.'
  );

  return {
    currentLines: linesFor(current),
    currentSummary: summaryFor(current),
    nextLines: linesFor(next),
    nextSummary: summaryFor(next),
    nextTotal: next.kind === 'joint' ? formatPercent(next.owners.reduce((s, o) => s + o.basisPoints, 0)) : null,
    consequences,
    blockedUntilUnpublished,
    sameAsCurrent: sameOwnershipView(current, next),
  };
}

/** Reads the readable message from either error body shape the API uses: `{ error }` or `{ error: CODE, message }`. */
export function apiErrorMessage(json: unknown, fallback: string): string {
  const o = (json ?? {}) as { error?: unknown; message?: unknown };
  if (typeof o.message === 'string' && o.message) return o.message;
  if (typeof o.error === 'string' && o.error) return o.error;
  return fallback;
}
