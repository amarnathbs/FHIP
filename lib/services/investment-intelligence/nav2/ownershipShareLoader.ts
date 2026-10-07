// NAV2 -- the user's OWN SHARE of jointly held funds, for the Fund analytics report (PO decision 06-10-2026: SHARE, never the whole holding).
//
// Reuses, and does not replace: the ownership read model (ownerClass.loadOwnerClassContext, which derives every account's effective ownership
// with ownerModel.deriveAccountOwnership) and the certified analytics loader (loadAnalyticsDataset) run on a read-only per-account view
// (scopeClientToAccounts). Only the decision of what counts for the user and the division by basis points (lib/engines/nav2/ownershipShare.ts, which
// calls the existing attributeByBasisPoints) are new.
//
// When every counted account of the household is owned by a sole member (the usual case) nothing here runs a second load: `special` is false and the
// report is exactly what it was.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { InvestorExperienceInput } from '@/lib/engines/nav2/investorExperience';
import { combineInvestorInputs, decideAccount, shareOfInvestorInput, type AccountDecision, type OwnershipShare, type ShareAllocationRef } from '@/lib/engines/nav2/ownershipShare';
import type { SchemeDataset } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { fetchAllRows } from '../pagination';
import { scopeClientToAccounts, type OwnerClassContext } from '../ownerClass';

export interface SchemeOwnershipResult {
  investor: InvestorExperienceInput | null;
  ownership: OwnershipShare;
}

export interface OwnershipShareLoad {
  /** false: nothing but sole-member folios, the report is unchanged. */
  special: boolean;
  byInstrument: Map<string, SchemeOwnershipResult>;
}

interface DatasetLike {
  schemes: SchemeDataset[];
}

export interface OwnershipShareDeps {
  /** The certified dataset loader on a (scoped) client. */
  loadDataset: (client: SupabaseClient) => Promise<DatasetLike | null>;
  /** The investor input of one scheme dataset (the loader's own pure function). */
  investorInputFor: (s: SchemeDataset) => InvestorExperienceInput | null;
}

/** Pure. How the user's accounts fall, from the ownership context. Exported for tests. */
export function decideAllAccounts(ctx: Pick<OwnerClassContext, 'accounts'>, selfMemberId: string | null): Map<string, AccountDecision> {
  return new Map(ctx.accounts.map((a) => [a.id, decideAccount(a.id, a.ownership, selfMemberId)] as const));
}

interface JointGroup {
  alloc: ShareAllocationRef;
  ids: string[];
  group: string | null;
}

const keyOf = (a: ShareAllocationRef): string => `${a.memberId}:${a.basisPoints}|${[...a.allShares].map((s) => `${s.memberId}:${s.basisPoints}`).sort().join(',')}`;

export async function loadOwnershipShares(args: { sessionClient: SupabaseClient; userId: string; ctx: OwnerClassContext }, deps: OwnershipShareDeps): Promise<OwnershipShareLoad> {
  const { sessionClient, userId, ctx } = args;
  const { data: selfRow } = await sessionClient.from('household_members').select('id').eq('user_id', userId).eq('relationship', 'self').order('id', { ascending: true }).limit(1).maybeSingle();
  const selfMemberId = (selfRow as { id?: string } | null)?.id ?? null;
  const decisions = decideAllAccounts(ctx, selfMemberId);
  const kinds = [...decisions.values()].map((d) => d.kind);
  const special = kinds.some((k) => k === 'joint' || k === 'not_set' || k === 'not_yours');
  if (!special) return { special: false, byInstrument: new Map() };

  // which accounts hold which fund (read once: ids only)
  const pairs = new Map<string, Set<string>>(); // instrument -> account ids
  const add = (r: { account_id: string; instrument_id: string }) => {
    const set = pairs.get(r.instrument_id) ?? new Set<string>();
    set.add(r.account_id);
    pairs.set(r.instrument_id, set);
  };
  for (const r of await fetchAllRows<{ account_id: string; instrument_id: string }>(() => sessionClient.from('ii_holding_snapshots').select('account_id, instrument_id').eq('user_id', userId).order('id', { ascending: true }))) add(r);
  for (const r of await fetchAllRows<{ account_id: string; instrument_id: string }>(() => sessionClient.from('ii_transactions').select('account_id, instrument_id').eq('user_id', userId).neq('status', 'reversed').order('id', { ascending: true }))) add(r);

  // groups of accounts that share one decision: the sole-member accounts, and the joint accounts with the same split
  const soleIds = [...decisions.entries()].filter(([, d]) => d.kind === 'sole').map(([id]) => id);
  const jointGroups = new Map<string, JointGroup>();
  for (const [id, d] of decisions) {
    if (d.kind !== 'joint') continue;
    const k = keyOf(d.allocation);
    const g = jointGroups.get(k) ?? { alloc: d.allocation, ids: [], group: ctx.allocationGroupByAccount?.get(id) ?? null };
    g.ids.push(id);
    jointGroups.set(k, g);
  }

  const soleInputs = new Map<string, InvestorExperienceInput>();
  if (soleIds.length > 0) {
    const ds = await deps.loadDataset(scopeClientToAccounts(sessionClient, soleIds));
    for (const s of ds?.schemes ?? []) {
      const i = deps.investorInputFor(s);
      if (i) soleInputs.set(s.instrumentId, i);
    }
  }
  const jointInputs: Array<{ group: JointGroup; inputs: Map<string, InvestorExperienceInput> }> = [];
  for (const g of jointGroups.values()) {
    const ds = await deps.loadDataset(scopeClientToAccounts(sessionClient, g.ids));
    const inputs = new Map<string, InvestorExperienceInput>();
    for (const s of ds?.schemes ?? []) {
      const i = deps.investorInputFor(s);
      if (i) inputs.set(s.instrumentId, i);
    }
    jointInputs.push({ group: g, inputs });
  }

  const byInstrument = new Map<string, SchemeOwnershipResult>();
  for (const [instrumentId, accountIds] of pairs) {
    const ds = [...accountIds].map((id) => decisions.get(id)).filter((d): d is AccountDecision => !!d);
    const sole = ds.filter((d) => d.kind === 'sole').length;
    const notSet = ds.filter((d) => d.kind === 'not_set').length;
    const notYours = ds.filter((d) => d.kind === 'not_yours').length;
    const parts: InvestorExperienceInput[] = [];
    const jointFolios: OwnershipShare['jointFolios'] = [];
    let jointBp: number | null = null;
    let invalid = false;
    const s = soleInputs.get(instrumentId);
    if (s && sole > 0) parts.push(s);
    for (const j of jointInputs) {
      const inGroup = j.group.ids.filter((id) => accountIds.has(id));
      const base = j.inputs.get(instrumentId);
      if (inGroup.length === 0 || !base) continue;
      const scaled = shareOfInvestorInput(base, j.group.alloc);
      if (!scaled) {
        invalid = true; // an invalid split is never trusted and never guessed
        continue;
      }
      parts.push(scaled);
      jointBp = j.group.alloc.basisPoints;
      for (let n = 0; n < inGroup.length; n++) jointFolios.push({ memberId: j.group.alloc.memberId, basisPoints: j.group.alloc.basisPoints, allocationGroup: j.group.group });
    }
    const counted = parts.length > 0 && !invalid;
    const ownership: OwnershipShare = {
      mode: !counted ? 'not_set' : jointFolios.length > 0 ? 'share' : 'sole',
      jointBasisPoints: counted ? jointBp : null,
      selfMemberId,
      jointFolios: counted ? jointFolios : [],
      soleFolios: sole,
      notSetFolios: notSet + (invalid ? 1 : 0),
      notYoursFolios: notYours,
    };
    byInstrument.set(instrumentId, { investor: counted ? combineInvestorInputs(parts) : null, ownership });
  }
  return { special: true, byInstrument };
}
