// NAV2 -- the signed-in user's OWN SHARE of a jointly held fund (PO decision 06-10-2026: SHARE, never the whole holding).
//
// In the personal Fund analytics report a holding the user owns jointly with another household member shows the user's own share of it: the
// units, value, amount put in, amount taken out and gain or loss are the user's allocation (basis points) of the folio's, and the XIRR is
// worked out on the user's share of every cash flow and of the terminal value. The fund's OWN performance (CAGR, volatility, rolling returns,
// drawdown ...) is a property of the fund and is never scaled.
//
// NO second validator and NO second allocation reader: the allocation comes from the existing ownership read model
// (ownerModel.deriveAccountOwnership over ii_ownership_allocation, loaded by ownerClass.loadOwnerClassContext) and the division uses the existing
// attributeByBasisPoints (largest remainder: the owners' parts add back to the whole exactly, 1,000,000 at 60/40 is 600,000 and 400,000, never
// 1,000,000 twice). This file only decides WHICH accounts count for the user, and applies that division to the investor inputs. PURE.
//
// What counts, per account (its effective ownership):
//   sole household member   -> counted in full (unchanged from before; a spouse's own folio is household-owned and stays in the household report)
//   joint, members only     -> the user's share, if the user's own member is one of the owners; otherwise it is not the user's holding: not counted
//   no owner / incomplete   -> NOT counted and NOT guessed: the holding is shown with the state "ownership share not set"
//   trust, HUF, company     -> not part of the personal report (excluded and disclosed elsewhere); SMSF is not an Investment Intelligence owner
//   joint including an entity -> likewise entity-involved: excluded

import { attributeByBasisPoints } from '@/lib/services/investment-intelligence/ownerAttribution';
import type { AccountOwnership } from '@/lib/services/investment-intelligence/ownerModel';
import type { InvestorExperienceInput, ValuationView } from './investorExperience';

export type ShareMode =
  /** every counted folio is owned by one household member */
  | 'sole'
  /** at least one counted folio is a joint holding: the user's share applies to it */
  | 'share'
  /** no folio of this fund could be counted for the user because no owner share is set (shown, not guessed) */
  | 'not_set';

export interface ShareAllocationRef {
  accountId: string;
  memberId: string;
  basisPoints: number;
  /** All the owners of the folio, kept so the division adds back to the whole. */
  allShares: Array<{ memberId: string; basisPoints: number }>;
}

/** What the report says about the user's ownership of one fund; goes into the pinned manifest and the report. */
export interface OwnershipShare {
  mode: ShareMode;
  /** The user's share of the JOINT folios of this fund in basis points (e.g. 6000), null when no joint folio is counted. */
  jointBasisPoints: number | null;
  /** The user's member id, the folios counted at their share, and the number of folios left out because their owner share is not set. */
  selfMemberId: string | null;
  jointFolios: Array<{ memberId: string; basisPoints: number; allocationGroup: string | null }>;
  soleFolios: number;
  notSetFolios: number;
  /** Joint folios the user is not an owner of (not the user's holding): counted nowhere. */
  notYoursFolios: number;
}

export type AccountDecision =
  | { kind: 'sole' }
  | { kind: 'joint'; allocation: ShareAllocationRef }
  | { kind: 'not_set' }
  | { kind: 'not_yours' }
  | { kind: 'entity' };

/** Pure. What one account is, for the user's personal report. */
export function decideAccount(accountId: string, ownership: AccountOwnership, selfMemberId: string | null): AccountDecision {
  if (ownership.kind === 'unassigned') return { kind: 'not_set' };
  if (ownership.hasEntity || ownership.kind === 'entity') return { kind: 'entity' };
  if (ownership.kind === 'member') return { kind: 'sole' };
  const memberShares = ownership.shares.filter((s) => s.memberId).map((s) => ({ memberId: s.memberId as string, basisPoints: s.basisPoints }));
  const mine = selfMemberId ? memberShares.find((s) => s.memberId === selfMemberId) : undefined;
  if (!mine) return selfMemberId ? { kind: 'not_yours' } : { kind: 'not_set' }; // no own member known: the share cannot be known, so it is not guessed
  return { kind: 'joint', allocation: { accountId, memberId: mine.memberId, basisPoints: mine.basisPoints, allShares: memberShares } };
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The user's part of ONE amount of a folio owned by `allShares`, by the existing largest-remainder division. null when the split is not valid. */
export function userPartOf(amount: number, a: ShareAllocationRef, decimals = 4): number | null {
  const parts = attributeByBasisPoints(amount, a.allShares.map((s) => ({ key: s.memberId, basisPoints: s.basisPoints })), decimals);
  return parts?.find((p) => p.key === a.memberId)?.amount ?? null;
}

/**
 * Pure. The investor input of ONE joint folio reduced to the user's share: every cash flow, the units, the market value and the statement value
 * are the user's part. XIRR over these is the XIRR of the user's own money. Returns null when the allocation is not a valid split (never a guess).
 */
export function shareOfInvestorInput(input: InvestorExperienceInput, a: ShareAllocationRef): InvestorExperienceInput | null {
  const flows: InvestorExperienceInput['flows'][number][] = [];
  for (const f of input.flows) {
    const p = userPartOf(f.amount, a);
    if (p === null) return null;
    flows.push({ ...f, amount: p });
  }
  const v = input.valuation;
  const scale = (n: number | null | undefined, decimals: number): number | null | undefined => {
    if (n === null || n === undefined) return n;
    return userPartOf(n, a, decimals);
  };
  const units = scale(v.units, 6);
  const marketValue = scale(v.marketValue, 4);
  const statementValue = scale(v.statementValue, 4);
  if (units === null || marketValue === null || statementValue === null) return null;
  const valuation: ValuationView = { ...v, units: units as number | null, marketValue: marketValue as number | null, ...(v.statementValue !== undefined ? { statementValue: statementValue as number | null } : {}) };
  return { ...input, flows, valuation };
}

/** Pure. The sum of several investor inputs of the SAME fund (its counted folios): flows concatenated, units and values added; basis taken from the first. */
export function combineInvestorInputs(parts: readonly InvestorExperienceInput[]): InvestorExperienceInput | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const sum = (pick: (v: ValuationView) => number | null | undefined): number | null => {
    const xs = parts.map((p) => pick(p.valuation)).filter((x): x is number => typeof x === 'number');
    return xs.length ? r6(xs.reduce((s, x) => s + x, 0)) : null;
  };
  const statement = sum((v) => v.statementValue);
  const valuation: ValuationView = {
    ...first.valuation,
    units: sum((v) => v.units),
    marketValue: sum((v) => v.marketValue),
    ...(statement !== null ? { statementValue: statement } : {}),
    stale: parts.some((p) => p.valuation.stale),
    // a fund held in several folios has no single NAV or statement date of its own: only the basis is kept when they agree
    basis: parts.every((p) => p.valuation.basis === first.valuation.basis) ? first.valuation.basis : 'market_nav',
  };
  return { instrumentId: first.instrumentId, flows: parts.flatMap((p) => [...p.flows]), valuation, asOfDate: first.asOfDate };
}

/** "50%", "60%", "33.33%": the share as shown (day-first style number formatting is not needed for a plain percentage; no trailing zeros). */
export function percentLabel(basisPoints: number): string {
  const pct = basisPoints / 100;
  return `${Number.isInteger(pct) ? pct : String(Math.round(pct * 100) / 100)}%`;
}

/** The sentence beside the figures. Exact wording the PO asked for. */
export function ownershipSentence(o: OwnershipShare | null | undefined): string | null {
  if (!o) return null;
  if (o.mode === 'not_set') {
    if (o.notSetFolios === 0 && o.notYoursFolios > 0) return 'You are not an owner of this joint holding, so it is shown without your own-money figures.';
    return 'Ownership share not set: this holding is shown without your own-money figures until the owner share is set. Nothing is guessed.';
  }
  const extra = [
    o.mode === 'share' && o.soleFolios > 0 ? ' Other folios of this fund held in your own name are counted in full.' : '',
    o.notSetFolios > 0 ? ' One folio whose owner share is not set is left out of these figures.' : '',
  ].join('');
  if (o.mode === 'share' && o.jointBasisPoints !== null) return `Your share: ${percentLabel(o.jointBasisPoints)} of a joint holding.${extra}`;
  return extra ? extra.trim() : null;
}
