/**
 * PC5 (M4) — K.5: the ownership choices a user may actually make, resolved
 * server-side from canonical data.
 *
 * ================================================================
 * K.5 ASKED FOR SEVEN THINGS. SIX EXIST. ONE DOES NOT. THIS IS WHICH.
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
 *                         (migration 0136). NOTE this is the REAL entity path;
 *                         the `OWNER_VALUES` value `'family_trust'` is a
 *                         LEGACY cosmetic tag (`LEGACY_ENTITY_OWNER_RESTRICTIONS`,
 *                         `lib/constants.ts`) that is no longer offered for new
 *                         rows on any register.                          EXISTS
 *   other existing household entity types -> `business_entities.entity_type =
 *                         'company'`, and `retirement_members` / SMSF for the
 *                         retirement domain.                             EXISTS
 *
 *   HUF                -> **DOES NOT EXIST AS AN OWNERSHIP CONCEPT ANYWHERE IN
 *                         THIS REPOSITORY.** The only HUF in the codebase is
 *                         `RESIDENT_HUF`, a value of `ii_tax_profiles.
 *                         taxpayer_type` (migration 0061) — an India income-tax
 *                         filing status, not an owner, not an entity, and not
 *                         referenced by any register's `owner` column.
 *
 * So PC5 does NOT offer HUF as an owner, and this is a deliberate refusal
 * rather than an oversight. Adding it would mean either (a) widening the
 * `owner` CHECK constraint on all seven registers plus
 * `ii_fhip_publications.published_owner`, inventing a ninth ownership value
 * with no valuation, consolidation or net-worth semantics behind it —
 * exactly the "invent a new entity type" K.5's own second sentence
 * forbids and exactly the mistake `'family_trust'`/`'company'` already are
 * (they were added as cosmetic tags, backed nothing, and had to be
 * retired into `LEGACY_ENTITY_OWNER_RESTRICTIONS`); or (b) quietly mapping
 * HUF onto `'other'`, which would record a Hindu Undivided Family's
 * holdings under a label that carries none of its distinct tax treatment
 * and would be wrong in exactly the jurisdiction where it matters.
 *
 * An Indian user whose folio is genuinely held by an HUF can today record
 * it as a `business_entities` row and attribute the position to it —
 * `ii_ownership_allocation.owner_business_entity_id` supports that — but
 * `entity_type` is CHECK-constrained to `('company','family_trust')`, so
 * that entity would have to be mislabelled. PC5 therefore surfaces
 * business entities as owners and leaves HUF as a NAMED, OPEN product
 * decision for the Product Owner, reported in the certification rather than
 * silently closed. See K.5's verdict there.
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
    detail: e.entity_type === 'family_trust' ? 'Family trust' : 'Company',
    // The register-level owner role for an entity-held position. These are
    // the two LEGACY tags — see this module's header. They are used here
    // because they are the ONLY existing enum values that describe an
    // entity-held position, and because the real entity identity travels
    // separately as `owner_business_entity_id`, which is what actually
    // drives consolidation.
    ownerRole: (e.entity_type === 'family_trust' ? 'family_trust' : 'company') as Owner,
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
