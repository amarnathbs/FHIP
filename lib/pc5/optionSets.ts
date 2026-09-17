/**
 * PC5 (M4) — K.5: the ownership choices a user may actually make, resolved
 * server-side from canonical data.
 *
 * ================================================================
 * K.5 ASKED FOR SEVEN THINGS. SIX EXISTED; THE SEVENTH (HUF) NOW DOES TOO,
 * BY PRODUCT-OWNER DECISION. THIS IS WHERE EACH ONE LIVES.
 * ================================================================
 * K.5: *"Support: self; spouse/partner; joint; child/dependent; HUF;
 * trust/family trust; other existing household entity types. Do not invent
 * a new entity type if an existing canonical one already models it."*
 *
 * The second sentence is the binding one, and honouring it required
 * establishing what this repository actually models before writing a line:
 *
 *   self               -> `household_members.relationship = 'self'`, mapping to
 *                         `OWNER_VALUES` `'self'`.                      EXISTS
 *   spouse / partner   -> relationships `'spouse'` and `'partner'`. BOTH already
 *                         map to the single owner role `'spouse'` via the
 *                         EXISTING `mapRelationshipToOwner` — a documented
 *                         decision from R3, not one PC5 made.           EXISTS
 *   joint              -> `OWNER_VALUES` `'joint'`, plus PC5's own
 *                         `ii_ownership_allocation` for the breakdown.  EXISTS
 *   child / dependent  -> relationships `'child'` and `'other_dependant'`,
 *                         mapping to `'child'` and `'other'`.           EXISTS
 *   trust / family trust -> `business_entities.entity_type = 'family_trust'`
 *                         (migration 0136). NOTE this is the REAL entity path,
 *                         and the one HUF was told to copy;
 *                         the `OWNER_VALUES` value `'family_trust'` is a
 *                         LEGACY cosmetic tag (`LEGACY_ENTITY_OWNER_RESTRICTIONS`,
 *                         `lib/constants.ts`) that is no longer offered for new
 *                         rows on any register.                          EXISTS
 *   other existing household entity types -> `business_entities.entity_type =
 *                         'company'`, and `retirement_members` / SMSF for the
 *                         retirement domain.                             EXISTS
 *
 *   HUF                -> `business_entities.entity_type = 'huf'`
 *                         (migration 0154), INDIA-ONLY.        EXISTS (M4B)
 *
 * ---------------------------------------------------------------------------
 * HUF — WHAT CHANGED, AND ON WHOSE DECISION
 * ---------------------------------------------------------------------------
 * PC5 originally recorded HUF as the one thing K.5 asked for that this
 * repository did not model, and REFUSED to invent it, raising it instead as
 * named open decision PO-PC5-1. The Product Owner closed it on 2026-09-15:
 * *"it is similar to family trust, create this in similar line for only
 * Indian users. All features of family trust need to adopt for HUF which is
 * similar in nature."* That is PC5's own option (a) — record an HUF-held
 * folio as a `business_entities` row, widening `entity_type` — and migration
 * 0154 implements exactly that and nothing more.
 *
 * WHAT DID NOT CHANGE: `OWNER_VALUES` is still the canonical EIGHT. HUF is
 * an `entity_type`, never a ninth owner role — the option PC5 called
 * indefensible (a ninth cosmetic tag with no valuation, consolidation or
 * net-worth semantics, requiring the `owner` CHECK on all seven registers
 * plus `ii_fhip_publications.published_owner` to be widened) is still
 * refused, and migration 0154 touches none of them. See
 * `businessEntityOwnerRole()` below for how an HUF entity's coarse
 * register-level role is resolved and why, and
 * `docs/investment-intelligence/PC5_HUF_ADDENDUM_2026-09-15.md` §4 for the
 * full decision record.
 *
 * `RESIDENT_HUF`, a value of `ii_tax_profiles.taxpayer_type` (migration
 * 0061), remains a separate thing entirely and is deliberately NOT linked:
 * it is an India income-tax FILING STATUS, not an owner and not an entity. A
 * user may file as an HUF without every folio being HUF-held, and may hold
 * an HUF folio while filing as an individual.
 *
 * ================================================================
 * WHY OPTIONS ARE RESOLVED HERE AND NEVER IN A STATIC REGISTRY
 * ================================================================
 * `AieReasonCodeMeta` is module-level, process-wide, shared by every
 * tenant. A user's household members must never be cached in it. Every
 * function below takes a `userId` and filters by it in the query, and the
 * result is request-scoped.
 *
 * The option set is ALSO the authorisation boundary (K.20: "browser cannot
 * forge victim account/owner IDs"). The submitted value is validated
 * against the set this module RE-DERIVES at decision time — never against
 * a set echoed back from the client, and never against the set that was
 * recorded in `evidence_ref` when the item was raised (that record is an
 * audit of what was offered, not a live permission).
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { mapRelationshipToOwner } from '@/lib/services/investment-intelligence/publicationLogic';
import type { HouseholdMemberRelationship } from '@/lib/services/investment-intelligence/types';
import { OWNER_VALUES, type Owner } from '@/lib/constants';
import type { Pc5ChoiceOption, Pc5OptionSource } from './types';

export interface Pc5OwnerOption extends Pc5ChoiceOption {
  /** The canonical FHIP owner role this choice resolves to. Always one of
   * `OWNER_VALUES` — PC5 introduces no ninth value. */
  ownerRole: Owner;
  kind: 'household_member' | 'business_entity' | 'joint';
}

/** The synthetic option value meaning "more than one of the above, with a
 * split". Not a member id, so it can never collide with one. */
export const PC5_JOINT_OPTION_VALUE = 'joint';

/** Human-readable entity kind, shown as the option's `detail` line.
 *  Exported so a test reads the real map rather than a copy. */
export const BUSINESS_ENTITY_TYPE_DETAIL: Record<string, string> = {
  company: 'Company',
  family_trust: 'Family trust',
  huf: 'Hindu Undivided Family (HUF)',
};

/**
 * M4B — the register-level owner ROLE for an entity-held position.
 *
 * `'huf'` resolves to `'other'`, NOT to a ninth `OWNER_VALUES` value and NOT
 * to `'family_trust'`. Both of those alternatives were considered and
 * rejected on evidence:
 *
 *   * A ninth value would mean widening the `owner` CHECK on all seven
 *     financial-data-grid registers plus `ii_fhip_publications.
 *     published_owner`, minting an ownership tag with no valuation or
 *     consolidation semantics behind it. That is exactly what `'company'`
 *     and `'family_trust'` already are — cosmetic tags that backed nothing
 *     and had to be RETIRED from new rows by LR-11B. Migration 0136, the
 *     Family Trust precedent the Product Owner asked HUF to follow, added
 *     its value to `business_entities.entity_type` ONLY and to nothing else.
 *
 *   * `'family_trust'` would be a factual falsehood. A Hindu Undivided
 *     Family is not a trust: different formation, different governing law,
 *     different tax treatment under the Income Tax Act. Filing an HUF's
 *     position under the trust role in exactly the jurisdiction where the
 *     distinction is legally operative is worse than filing it under a
 *     deliberately unspecific one.
 *
 * `'other'` is the honest coarse bucket, and — critically — it is NOT where
 * the HUF's identity lives. This role is a register-level tag with no
 * financial behaviour attached (nothing in `lib/engines/householdContext.ts`
 * or any valuation engine branches on it; only `'smsf'` is ever
 * discriminated). The HUF's real identity travels as
 * `owner_business_entity_id` -> `business_entities.entity_type = 'huf'`,
 * which is what the UI displays and what consolidation actually reads. PC5's
 * own objection to mapping HUF onto `'other'` was raised when HUF had NO
 * entity representation at all, so `'other'` would have been the whole
 * record; migration 0154 removes that premise.
 */
export function businessEntityOwnerRole(entityType: string): Owner {
  if (entityType === 'family_trust') return 'family_trust';
  if (entityType === 'huf') return 'other';
  return 'company';
}

/**
 * K.10's three answers, verbatim from the dispatch: *"same economic event;
 * both genuine separate events; wrong statement/source."* A closed
 * three-value set, so a `choose_value` submission for a duplicate candidate
 * is validated against literals rather than against anything user-supplied.
 */
export const PC5_DUPLICATE_RESOLUTION_OPTIONS: readonly Pc5ChoiceOption[] = [
  {
    value: 'same_economic_event',
    label: 'Yes — this is the same activity I have already imported',
    detail: 'We will keep the version already recorded and will not import this one again, so nothing is double-counted.',
  },
  {
    value: 'separate_genuine_events',
    label: 'No — these are genuinely separate transactions that happen to look alike',
    detail: 'We will re-run the duplicate check treating them as distinct. Anything that is still an exact match on its own evidence will still be caught.',
  },
  {
    value: 'wrong_statement_or_source',
    label: 'Neither — this statement is for the wrong account or the wrong person',
    detail: 'We will discard this statement rather than import it. Nothing already recorded is affected.',
  },
];

/**
 * K.9's permitted answers to a summary mismatch. Note what is NOT here: an
 * input box. K.9 is explicit — *"Do not let the user simply type an
 * arbitrary balancing number into canonical truth"* — so the option set
 * contains no free-form value at all. Every choice either reprocesses,
 * discards, or records which of the two ALREADY-EXTRACTED figures the user
 * asserts is correct; none of them invents a third number.
 */
export const PC5_SUMMARY_MISMATCH_OPTIONS: readonly Pc5ChoiceOption[] = [
  {
    value: 'trust_statement_summary',
    label: 'The summary printed on the statement is correct',
    detail: 'The transaction list is treated as incomplete. We will not import a reconstructed balance that contradicts the document.',
  },
  {
    value: 'trust_reconstructed_transactions',
    label: 'The transaction list is correct and the printed summary is wrong',
    detail: 'We re-run reconciliation against the transactions. If they still do not reconcile on their own evidence, the exception stays open.',
  },
  {
    value: 'wrong_statement_or_source',
    label: 'Neither — this statement is for the wrong account or the wrong person',
    detail: 'We will discard this statement rather than import it.',
  },
];

interface HouseholdMemberRow {
  id: string;
  full_name: string;
  relationship: string;
  is_active: boolean;
}

interface BusinessEntityRow {
  id: string;
  name: string;
  entity_type: string;
  is_active: boolean;
}

/**
 * The owner option set for one user. Ordered deterministically — `self`
 * first, then other members in creation order, then entities, then the
 * joint option last — so the UI's option order is stable across requests
 * and a test can assert it.
 *
 * INACTIVE MEMBERS AND ENTITIES ARE EXCLUDED. Filing a new statement
 * against a deactivated member would resurrect them implicitly; a user who
 * wants that should reactivate the member first, where the consequence is
 * visible.
 */
export async function resolveOwnerOptions(userId: string): Promise<Pc5OwnerOption[]> {
  const admin = createAdminClient();

  const [{ data: memberRows }, { data: entityRows }] = await Promise.all([
    admin
      .from('household_members')
      .select('id, full_name, relationship, is_active')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .returns<HouseholdMemberRow[]>(),
    admin
      .from('business_entities')
      .select('id, name, entity_type, is_active')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .returns<BusinessEntityRow[]>(),
  ]);

  const members = (memberRows ?? []).filter((m) => m.is_active !== false);
  const entities = (entityRows ?? []).filter((e) => e.is_active !== false);

  const memberOptions: Pc5OwnerOption[] = members.map((m) => {
    // `mapRelationshipToOwner` is the EXISTING R3 mapping (including its
    // documented decision that `'partner'` resolves to the owner role
    // `'spouse'`, the closest existing enum value). PC5 reuses it rather
    // than restating it, so the role a statement is filed under here and
    // the role a publication is created under later cannot diverge.
    const ownerRole = mapRelationshipToOwner(m.relationship as HouseholdMemberRelationship);
    return {
      value: m.id,
      label: m.full_name || '(unnamed household member)',
      detail: relationshipLabel(m.relationship),
      ownerRole: ownerRole as Owner,
      kind: 'household_member' as const,
    };
  });

  // Stable ordering: 'self' first.
  memberOptions.sort((a, b) => {
    const aSelf = a.ownerRole === 'self' ? 0 : 1;
    const bSelf = b.ownerRole === 'self' ? 0 : 1;
    return aSelf - bSelf;
  });

  const entityOptions: Pc5OwnerOption[] = entities.map((e) => ({
    value: e.id,
    label: e.name,
    detail: BUSINESS_ENTITY_TYPE_DETAIL[e.entity_type] ?? 'Company',
    // The register-level owner role for an entity-held position. `company`
    // and `family_trust` are the two LEGACY tags — see this module's header.
    // They are used here because they are the ONLY existing enum values that
    // describe an entity-held position, and because the real entity identity
    // travels separately as `owner_business_entity_id`, which is what
    // actually drives consolidation.
    ownerRole: businessEntityOwnerRole(e.entity_type),
    kind: 'business_entity' as const,
  }));

  const jointOption: Pc5OwnerOption[] =
    memberOptions.length + entityOptions.length >= 2
      ? [
          {
            value: PC5_JOINT_OPTION_VALUE,
            label: 'Jointly owned',
            detail: 'Choose two or more owners and their shares. The holdings are still counted once.',
            requiresAllocation: true,
            ownerRole: 'joint' as Owner,
            kind: 'joint' as const,
          },
        ]
      : [];

  return [...memberOptions, ...entityOptions, ...jointOption];
}

function relationshipLabel(relationship: string): string {
  switch (relationship) {
    case 'self':
      return 'You';
    case 'spouse':
      return 'Spouse';
    case 'partner':
      return 'Partner';
    case 'child':
      return 'Child';
    case 'parent':
      return 'Parent';
    case 'other_dependant':
      return 'Dependant';
    default:
      return 'Household member';
  }
}

/**
 * The account-disambiguation option set. Resolved from the user's OWN
 * accounts, intersected with the candidate ids AIE recorded when it raised
 * the item.
 *
 * THE INTERSECTION IS THE POINT, and the order of the two filters matters.
 * `.eq('user_id', userId)` is applied in the QUERY, so a candidate id that
 * belongs to another tenant simply does not come back — a caller who
 * tampered with `evidence_ref` (which they cannot, it is service-role
 * write-only, but the check does not depend on that) still gets nothing.
 * The candidate list then narrows further to what AIE itself judged
 * plausible, so a user cannot resolve an ambiguous folio onto an unrelated
 * account of their own either.
 */
export async function resolveAccountCandidateOptions(userId: string, candidateAccountIds: readonly string[]): Promise<Pc5ChoiceOption[]> {
  if (candidateAccountIds.length === 0) return [];
  const admin = createAdminClient();
  const { data } = await admin
    .from('ii_accounts')
    .select('id, folio_number, institution_name, account_number_masked, status')
    .eq('user_id', userId)
    .in('id', candidateAccountIds as string[])
    .order('created_at', { ascending: true });
  return (data ?? []).map((a) => ({
    value: a.id as string,
    label: `${(a.folio_number as string | null) ?? (a.account_number_masked as string | null) ?? '(no folio number)'}`,
    detail: `${a.institution_name as string}${a.status === 'active' ? '' : ` · ${a.status as string}`}`,
  }));
}

/** Dispatch by declared source. Kept as one function so a new option source
 * cannot be added to the type without this switch failing to compile (the
 * `never` check below). */
export async function resolveOptionsForSource(params: {
  source: Pc5OptionSource;
  userId: string;
  candidateIds: readonly string[];
}): Promise<Pc5ChoiceOption[]> {
  switch (params.source) {
    case 'household_owner':
      return resolveOwnerOptions(params.userId);
    case 'account_match_candidates':
      return resolveAccountCandidateOptions(params.userId, params.candidateIds);
    case 'instrument_match_candidates':
      // Deliberately empty — see `unresolvedItems.ts`'s note on why an
      // ambiguous INSTRUMENT is not user-resolvable: the choice is between
      // near-identical scheme variants (Direct vs Regular, Growth vs IDCW)
      // where a wrong answer silently corrupts cost base and tax lots, and
      // the user has no better information than the parser had. Returning
      // an empty set makes the UI say "this cannot be resolved by choosing"
      // and offer reprocess/discard, which is the truthful answer.
      return [];
    case 'duplicate_resolution':
      return [...PC5_DUPLICATE_RESOLUTION_OPTIONS];
    case 'summary_mismatch_resolution':
      return [...PC5_SUMMARY_MISMATCH_OPTIONS];
    default: {
      const exhaustive: never = params.source;
      throw new Error(`resolveOptionsForSource: unhandled source ${String(exhaustive)}`);
    }
  }
}

/** Guard used by the decision service. Exported so the same predicate can
 * be unit-tested directly against a fabricated option set. */
export function isPermittedChoice(options: readonly Pc5ChoiceOption[], submittedValue: string): boolean {
  return options.some((o) => o.value === submittedValue);
}

/** Asserted by a unit test: PC5 never introduces an ownership value outside
 * the canonical eight. Exported so the assertion reads against the real
 * constant rather than a copy. */
export const PC5_PERMITTED_OWNER_ROLES: readonly string[] = OWNER_VALUES;
