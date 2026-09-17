/**
 * M3 (Phase 4) — the READ-ONLY canonical-state loader that makes AIE-1.2's
 * reconciliation rule usable from a real HTTP request.
 *
 * WHY THIS FILE DID NOT EXIST BEFORE, AND WHY THAT MATTERED.
 * `reconciliationRule.ts` is written against an already-fetched
 * `InvestmentReconciliationContext`, deliberately, so it can be unit-tested
 * with zero database access. That was the right call — but nothing in the
 * application ever built one. The context was assembled only inside test
 * files, which is why `buildInvestmentReconciliationRule` had, as of M2,
 * exactly zero production callers and Investment Intelligence had no real
 * AIE dispatch path at all (M0 open item 4; master dispatch I.1).
 *
 * This module is that missing half. It is the ONLY new database access M3
 * adds on the Investment Intelligence side, and every query in it is a
 * SELECT. Nothing here writes, and nothing here creates a provisional
 * account or instrument — those are canonical writes and belong solely to
 * `processSourceDocument`, reached later through the governed acceptance
 * path (`lib/aie/review/accept.ts` -> `write.ts`).
 *
 * REUSE, NOT REBUILD. Every projection below mirrors the exact query
 * `lib/services/investment-intelligence/documentProcessing.ts` already runs
 * for the same purpose, including its use of `fetchAllRows` rather than a
 * bare `.select()`. That is not stylistic: documentProcessing.ts's own
 * comment records that an unbounded select here was silently truncated at
 * 1,000 rows, and that resolution which cannot SEE an existing instrument
 * does not fail loudly — it mints a duplicate one. Repeating the bare select
 * here would reintroduce that defect on a new code path.
 *
 * TENANT SCOPING. Every user-owned table is filtered by `user_id` in the
 * query itself rather than relying on the caller. `ii_instruments`,
 * `ii_instrument_identifiers` and `ii_scheme_alias_map` are deliberately NOT
 * user-scoped — they are shared reference data, exactly as
 * `documentProcessing.ts` reads them.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';
import { loadActiveReconciliationConfig } from '@/lib/services/investment-intelligence/reconciliationConfig';
import { normaliseSchemeName } from '@/lib/services/investment-intelligence/parsers/textUtils';
import { parseExactDecimal, ZERO } from '@/lib/services/investment-intelligence/decimal';
import type { AliasMapRow, ExistingInstrumentForResolution } from '@/lib/services/investment-intelligence/schemeResolution';
import type { IiOptionType, IiPlanType, IiTransactionType } from '@/lib/services/investment-intelligence/types';
import type { ParsedDocumentOutput } from '@/lib/services/investment-intelligence/parsers/types';
import { matchAccountsReadOnly, type ExistingAccountForMatching } from './accountMatching';
import { matchInstrumentsReadOnly, schemeKey } from './instrumentMatching';
import type { ExistingSnapshotForRollForward, InvestmentReconciliationContext } from './reconciliationRule';

function toScaledOrZero(value: unknown): bigint {
  if (value === null || value === undefined) return ZERO;
  const parsed = parseExactDecimal(String(value));
  return parsed.ok ? parsed.scaled : ZERO;
}

function toScaledOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  const parsed = parseExactDecimal(String(value));
  return parsed.ok ? parsed.scaled : null;
}

export interface BuildContextParams {
  userId: string;
  countryCode: string;
  /** `ii_sources.source_key` for the detected parser — part of the
   * transaction fingerprint, so it must be the SAME value the real write
   * path will use, not a label invented here. */
  sourceKey: string;
  parsed: ParsedDocumentOutput;
}

/**
 * Builds the full read-only snapshot AIE-1.2's reconciliation rule needs.
 *
 * ORDERING NOTE. Accounts and instruments are matched FIRST because the
 * later queries (existing snapshots, existing transactions per position) are
 * scoped to the account ids that matching actually resolved. Loading every
 * transaction the user has ever had and filtering in memory would work but
 * would scale with the whole portfolio rather than with this statement.
 */
export async function buildInvestmentReconciliationContext(params: BuildContextParams): Promise<InvestmentReconciliationContext> {
  const admin = createAdminClient();
  const { userId, countryCode, sourceKey, parsed } = params;

  // --- 1. Existing accounts for this user, and conservative matching -------
  const accountRows = await fetchAllRows<{ id: string; folio_number: string | null; institution_name: string; currency_code: string }>(() =>
    admin.from('ii_accounts').select('id, folio_number, institution_name, currency_code').eq('user_id', userId).order('id', { ascending: true }),
  );
  const existingAccounts: ExistingAccountForMatching[] = (accountRows ?? []).map((r) => ({
    id: r.id,
    folioNumber: r.folio_number,
    institutionName: r.institution_name,
  }));
  const accountMatches = matchAccountsReadOnly(parsed, existingAccounts);

  const existingAccountCurrency = new Map<string, string>();
  for (const r of accountRows ?? []) existingAccountCurrency.set(r.id, r.currency_code);

  // --- 2. Instruments — shared reference data, paginated -------------------
  // `fetchAllRows`, not `.select()`: see this module's header.
  const identifierRows = await fetchAllRows<{ instrument_id: string; identifier_scheme: string; identifier_value: string; country_code: string }>(() =>
    admin.from('ii_instrument_identifiers').select('instrument_id, identifier_scheme, identifier_value, country_code').eq('is_active', true).order('id', { ascending: true }),
  );
  const instrumentRows = await fetchAllRows<{
    id: string;
    instrument_name: string;
    amc_name: string | null;
    plan_type: string | null;
    option_type: string | null;
    country_of_domicile: string;
  }>(() =>
    admin
      .from('ii_instruments')
      .select('id, instrument_name, amc_name, plan_type, option_type, country_of_domicile')
      .eq('is_active', true)
      .order('id', { ascending: true }),
  );
  const aliasRowsRaw = await fetchAllRows<Record<string, unknown>>(() =>
    admin.from('ii_scheme_alias_map').select('*').eq('is_active', true).order('id', { ascending: true }),
  );

  const identifierFor = (instrumentId: string, scheme: string): string | null =>
    (identifierRows ?? []).find((i) => i.instrument_id === instrumentId && i.identifier_scheme === scheme)?.identifier_value ?? null;

  const existingForResolution: ExistingInstrumentForResolution[] = (instrumentRows ?? []).map((r) => ({
    instrumentId: r.id,
    isin: identifierFor(r.id, 'isin'),
    amfiSchemeCode: identifierFor(r.id, 'amfi_scheme_code'),
    internalProvisionalCode: identifierFor(r.id, 'internal_provisional'),
    normalisedSchemeName: normaliseSchemeName(r.instrument_name),
    amcName: r.amc_name,
    planType: (r.plan_type as IiPlanType) ?? null,
    optionType: (r.option_type as IiOptionType) ?? null,
    countryCode: r.country_of_domicile,
  }));

  const aliasRows: AliasMapRow[] = (aliasRowsRaw ?? []).map((a) => ({
    rawSchemeNameNormalised: a.raw_scheme_name_normalised as string,
    amcName: (a.amc_name as string) ?? null,
    planType: (a.plan_type as IiPlanType) ?? null,
    optionType: (a.option_type as IiOptionType) ?? null,
    countryCode: (a.country_code as string) ?? null,
    resolvedInstrumentId: a.resolved_instrument_id as string,
  }));

  // `ParsedDocumentOutput` has no top-level `instruments` array — a scheme is
  // carried on each transaction and each holding row. This is the SAME union
  // `documentProcessing.ts` builds for the real write path (its own
  // `uniqueSchemes` map), reproduced exactly: holdings must be included, not
  // just transactions, or a closing-balance-only position would never be
  // matched and would then reconcile as `indeterminate`.
  const schemeUnion = new Map<string, (typeof parsed.transactions)[number]['scheme']>();
  for (const t of parsed.transactions) schemeUnion.set(schemeKey(t.scheme), t.scheme);
  for (const h of parsed.holdings) schemeUnion.set(schemeKey(h.scheme), h.scheme);

  const instrumentMatches = matchInstrumentsReadOnly([...schemeUnion.values()], countryCode, existingForResolution, aliasRows);

  // --- 3. Existing transaction fingerprints, scoped to matched accounts ----
  const resolvedAccountIds = [...new Set(accountMatches.outcomes.filter((o) => o.kind === 'resolved').map((o) => (o as { accountId: string }).accountId))];

  const existingFingerprints = new Set<string>();
  const existingSnapshots = new Map<string, ExistingSnapshotForRollForward>();
  const existingTransactionsForPosition = new Map<string, { canonicalType: IiTransactionType; unitsScaled: bigint | null; sourceReference: string | null }[]>();

  if (resolvedAccountIds.length > 0) {
    const fingerprintRows = await fetchAllRows<{ account_id: string; transaction_fingerprint: string | null }>(() =>
      admin.from('ii_transactions').select('account_id, transaction_fingerprint').eq('user_id', userId).in('account_id', resolvedAccountIds).order('id', { ascending: true }),
    );
    for (const r of fingerprintRows ?? []) {
      if (r.transaction_fingerprint) existingFingerprints.add(`${r.account_id}:${r.transaction_fingerprint}`);
    }

    // Latest closing snapshot per (account, instrument). Ordered ascending by
    // as_of_date and overwritten as we go, so the LAST write per position
    // wins — the same "newest snapshot is the opening balance to roll
    // forward from" rule `documentProcessing.ts` applies.
    const snapshotRows = await fetchAllRows<{ account_id: string; instrument_id: string; as_of_date: string; units: string }>(() =>
      admin
        .from('ii_holding_snapshots')
        .select('account_id, instrument_id, as_of_date, units')
        .eq('user_id', userId)
        .in('account_id', resolvedAccountIds)
        .order('as_of_date', { ascending: true }),
    );
    for (const r of snapshotRows ?? []) {
      existingSnapshots.set(`${r.account_id}:${r.instrument_id}`, { unitsScaled: toScaledOrZero(r.units), asOfDateIso: r.as_of_date });
    }

    // Existing transactions STRICTLY AFTER each position's snapshot date.
    // The snapshot is the opening balance; a transaction dated on or before
    // it is already baked into that balance and counting it again would
    // double-apply it — which would surface as a phantom unit variance and
    // block an otherwise-clean document.
    const txnRows = await fetchAllRows<{
      account_id: string;
      instrument_id: string;
      transaction_type: string;
      units: string | null;
      transaction_date: string;
      source_reference: string | null;
    }>(() =>
      admin
        .from('ii_transactions')
        .select('account_id, instrument_id, transaction_type, units, transaction_date, source_reference')
        .eq('user_id', userId)
        .in('account_id', resolvedAccountIds)
        .order('transaction_date', { ascending: true }),
    );
    for (const r of txnRows ?? []) {
      const positionKey = `${r.account_id}:${r.instrument_id}`;
      const snapshot = existingSnapshots.get(positionKey);
      if (snapshot && r.transaction_date <= snapshot.asOfDateIso) continue;
      const list = existingTransactionsForPosition.get(positionKey) ?? [];
      list.push({
        canonicalType: r.transaction_type as IiTransactionType,
        unitsScaled: toScaledOrNull(r.units),
        sourceReference: r.source_reference,
      });
      existingTransactionsForPosition.set(positionKey, list);
    }
  }

  const config = await loadActiveReconciliationConfig();

  return {
    sourceKey,
    countryCode,
    accountMatches,
    instrumentMatches,
    existingFingerprints,
    existingSnapshots,
    existingTransactionsForPosition,
    existingAccountCurrency,
    config,
  };
}

/** Re-exported so a caller building unresolved items does not have to
 * duplicate the key derivation the context itself used. */
export { schemeKey };
