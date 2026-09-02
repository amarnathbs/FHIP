// Investment Intelligence R12 — the manual entry orchestration for the
// frozen wider-asset scope (direct listed Indian equity + equity-oriented
// ETF). See R12_WIDER_INDIA_ASSETS_ARCHITECTURE_DISCOVERY.md section 2.6
// and R12_CANONICAL_INSTRUMENT_MODEL.md.
//
// Deliberately thin: reuses importManualFixture() (manualImporter.ts)
// unchanged for the entire document/account/instrument/transaction/
// holding-snapshot chain — R12 does not build a parallel ingestion
// pipeline. The only R12-specific orchestration here is:
//   1. Frozen-scope validation (equity/etf only, India only).
//   2. Reading the CURRENT position (if any) to compute the new
//      units/value after this action, and to reject an impossible sale
//      (spec section 32 — "do not silently accept impossible
//      combinations").
//   3. Seeding ii_scheme_tax_classification with a rule-based
//      classification for a brand-new instrument (classifyDirectListedSecurity,
//      schemeClassification.ts) — extends R6's existing cache table and
//      read path, never a new tax calculator (spec section 53).
import { createHash } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import type { IiManualDirectPositionInput } from '@/lib/validation/investment-intelligence';
import type { IiManualFixture } from '@/lib/validation/investment-intelligence';
import { importManualFixture, findExistingManualImportByFixtureKey, resolveManualImportReplay, type ManualImportResult } from './manualImporter';
import { classifyDirectListedSecurity } from '@/lib/engines/investment-intelligence/tax/schemeClassification';
import { validateIsin } from './isinValidation';
import { validateIsoDateStrict } from './dateNormalisation';

export interface ManualDirectPositionResult extends ManualImportResult {
  taxClassificationSeeded: boolean;
  unitsAfter: number | null;
  valueAfter: number | null;
  validationError: string | null;
  // PC1-D2/D4 — stable, machine-readable error code alongside
  // `validationError`'s human-readable message (e.g. 'INVALID_ISIN',
  // 'INVALID_TRANSACTION_DATE'). null for every pre-existing validation
  // path (frozen-scope, oversell) — unchanged contract for those.
  validationErrorCode: string | null;
}

const ENGINE_VERSION = 'ii-r12-direct-security-classification-1.0.0';

function stableFixtureKey(userId: string, input: IiManualDirectPositionInput, normalisedIsin: string): string {
  // Deterministic, content-derived key so a genuine double-submit (same
  // user, same action, same instrument, same date, same amounts) resolves
  // idempotently via importManualFixture's own checksum de-dup, while a
  // materially different action always gets a different key. Keyed off
  // the NORMALISED ISIN (PC1-D2) so "same investment, different case"
  // (e.g. a copy-pasted lowercase ISIN) is recognised as the same
  // idempotency identity rather than spuriously treated as distinct
  // (PC1-D3's fingerprint must not be case-sensitive on an identifier
  // whose own validator normalises case).
  const parts: (string | number)[] = [userId, input.action, input.instrumentClass, normalisedIsin, input.accountInstitutionName];
  if (input.action === 'buy' || input.action === 'sale') {
    parts.push(input.transactionDate, input.units, input.pricePerUnit, input.fees ?? 0, input.taxes ?? 0);
  } else if (input.action === 'dividend') {
    parts.push(input.transactionDate, input.amount);
  } else {
    parts.push(input.asOfDate, input.currentValue);
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/**
 * Reads the latest known position (units/value) for this user+ISIN,
 * regardless of which account it lives under — used only to validate a
 * sale does not exceed known holdings and to compute the running
 * position for buy/sale. Read-only; never writes.
 */
async function readCurrentPosition(
  userId: string,
  isin: string
): Promise<{ instrumentId: string | null; accountId: string | null; units: number; value: number }> {
  const admin = createAdminClient();
  const { data: idRow } = await admin
    .from('ii_instrument_identifiers')
    .select('instrument_id')
    .eq('identifier_scheme', 'isin')
    .eq('identifier_value', isin)
    .maybeSingle();
  const instrumentId = (idRow?.instrument_id as string | undefined) ?? null;
  if (!instrumentId) return { instrumentId: null, accountId: null, units: 0, value: 0 };

  const { data: snap } = await admin
    .from('ii_holding_snapshots')
    .select('account_id, units, value')
    .eq('user_id', userId)
    .eq('instrument_id', instrumentId)
    .order('as_of_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    instrumentId,
    accountId: (snap?.account_id as string | undefined) ?? null,
    units: snap ? Number(snap.units) : 0,
    value: snap ? Number(snap.value) : 0,
  };
}

async function ensureDirectSecurityTaxClassification(
  instrumentId: string,
  instrumentClass: 'equity' | 'etf',
  isEquityOriented: boolean | undefined
): Promise<boolean> {
  const admin = createAdminClient();
  const { data: existing } = await admin.from('ii_scheme_tax_classification').select('id').eq('instrument_id', instrumentId).maybeSingle();
  if (existing) return false; // never overwrite an existing classification (could be admin-curated)

  const result = classifyDirectListedSecurity({ instrumentKey: instrumentId, instrumentClass, isEquityOriented });
  const { error } = await admin.from('ii_scheme_tax_classification').insert({
    instrument_id: instrumentId,
    classification: result.classification,
    domestic_equity_pct: result.domesticEquityPct,
    basis: result.basis,
    disclosure_date: result.disclosureDate,
    engine_version: ENGINE_VERSION,
    note: result.note,
  });
  return !error;
}

export async function submitManualDirectPosition(userId: string, input: IiManualDirectPositionInput): Promise<ManualDirectPositionResult> {
  const empty: ManualDirectPositionResult = {
    sourceDocumentId: null,
    accountId: null,
    instrumentId: null,
    transactionIds: [],
    holdingSnapshotId: null,
    reconciliationCaseId: null,
    wasNewDocument: false,
    error: null,
    taxClassificationSeeded: false,
    unitsAfter: null,
    valueAfter: null,
    validationError: null,
    validationErrorCode: null,
  };

  if (input.instrumentClass === 'etf' && input.action !== 'reprice' && input.isEquityOriented !== true) {
    return { ...empty, validationError: 'ETF positions must be explicitly declared equity-oriented to enter R12 scope — non-equity ETFs are deferred (R12_ASSET_CLASS_SCOPE_MATRIX.md).' };
  }

  // PC1-D2 — server-side ISIN syntax/check-digit validation. A
  // syntactically valid ISIN is a SEPARATE concern from asset-class scope
  // (the ETF check above) — validating it here, after the scope check but
  // before any DB read/write, means an invalid identifier is rejected
  // regardless of asset class, and a valid-but-out-of-scope ISIN is still
  // correctly blocked by the scope check rather than bypassing it.
  const isinResult = validateIsin(input.isin);
  if (!isinResult.ok || !isinResult.normalised) {
    return { ...empty, validationError: isinResult.error ?? 'Enter a valid 12-character ISIN.', validationErrorCode: 'INVALID_ISIN' };
  }
  const normalisedIsin = isinResult.normalised;

  // PC1-D4 — strict manual-entry date boundary, validated before any DB
  // read/write touches this value (the malformed-date reproduction showed
  // Postgres' own cast/constraint error reaching the client otherwise).
  const dateToValidate = input.action === 'reprice' ? input.asOfDate : input.transactionDate;
  const dateResult = validateIsoDateStrict(dateToValidate);
  if (!dateResult.ok) {
    return { ...empty, validationError: dateResult.error, validationErrorCode: 'INVALID_TRANSACTION_DATE' };
  }

  // PC1-D3 — idempotency pre-check using the RAW INPUT's own stable
  // content-derived identity, computed BEFORE readCurrentPosition/
  // unitsAfter (root-cause fix — see manualImporter.ts's
  // findExistingManualImportByFixtureKey doc comment for the full defect
  // history: hashing the DERIVED unitsAfter/valueAfter for de-dup silently
  // broke idempotency for a sequential exact-duplicate resubmit, because
  // the second call's "current position" already reflects the first
  // call's effect, live-DEV-reproduced as a doubled cumulative holding).
  const fixtureKey = `r12-manual-${stableFixtureKey(userId, input, normalisedIsin)}`;
  const existingByFixtureKey = await findExistingManualImportByFixtureKey(userId, fixtureKey);
  if (existingByFixtureKey) {
    const replay = await resolveManualImportReplay(userId, input.accountInstitutionName, existingByFixtureKey.id);
    let replayUnitsAfter: number | null = null;
    let replayValueAfter: number | null = null;
    if (replay.holdingSnapshotId) {
      const admin = createAdminClient();
      const { data: snap } = await admin.from('ii_holding_snapshots').select('units, value').eq('id', replay.holdingSnapshotId).maybeSingle();
      replayUnitsAfter = snap ? Number(snap.units) : null;
      replayValueAfter = snap ? Number(snap.value) : null;
    }
    return {
      ...replay,
      taxClassificationSeeded: false, // never re-seed an existing classification on replay
      unitsAfter: replayUnitsAfter,
      valueAfter: replayValueAfter,
      validationError: null,
      validationErrorCode: null,
    };
  }

  const current = await readCurrentPosition(userId, normalisedIsin);

  if ((input.action === 'sale' || input.action === 'dividend' || input.action === 'reprice') && current.units <= 0 && !current.instrumentId) {
    return { ...empty, validationError: `No existing position found for ISIN ${normalisedIsin} — a ${input.action} action requires a prior 'buy'.` };
  }
  if (input.action === 'sale' && input.units > current.units) {
    return { ...empty, validationError: `Cannot sell ${input.units} units — only ${current.units} units are currently held (ISIN ${normalisedIsin}).` };
  }

  let unitsAfter: number;
  let valueAfter: number;
  let transactions: IiManualFixture['transactions'] = [];
  let holdingSnapshot: IiManualFixture['holdingSnapshot'];

  if (input.action === 'buy') {
    unitsAfter = current.units + input.units;
    valueAfter = unitsAfter * input.pricePerUnit;
    transactions = [
      {
        transactionType: 'purchase',
        transactionDate: input.transactionDate,
        units: input.units,
        pricePerUnit: input.pricePerUnit,
        grossAmount: input.units * input.pricePerUnit,
        fees: input.fees ?? null,
        taxes: input.taxes ?? null,
      },
    ];
    holdingSnapshot = { asOfDate: input.transactionDate, units: unitsAfter, value: valueAfter, qualityStatus: 'warning', priceSource: 'manual_entry' };
  } else if (input.action === 'sale') {
    unitsAfter = current.units - input.units;
    valueAfter = unitsAfter * input.pricePerUnit;
    transactions = [
      {
        transactionType: 'sale',
        transactionDate: input.transactionDate,
        units: input.units,
        pricePerUnit: input.pricePerUnit,
        grossAmount: input.units * input.pricePerUnit,
        fees: input.fees ?? null,
        taxes: input.taxes ?? null,
      },
    ];
    holdingSnapshot = { asOfDate: input.transactionDate, units: unitsAfter, value: valueAfter, qualityStatus: 'warning', priceSource: 'manual_entry' };
  } else if (input.action === 'dividend') {
    unitsAfter = current.units;
    valueAfter = current.value;
    transactions = [
      {
        transactionType: 'dividend',
        transactionDate: input.transactionDate,
        units: null,
        pricePerUnit: null,
        grossAmount: input.amount,
      },
    ];
    holdingSnapshot = { asOfDate: input.transactionDate, units: unitsAfter, value: valueAfter, qualityStatus: 'warning', priceSource: 'manual_entry' };
  } else {
    // reprice — no new transaction, only an updated valuation snapshot.
    unitsAfter = current.units;
    valueAfter = input.currentValue;
    transactions = [];
    holdingSnapshot = { asOfDate: input.asOfDate, units: unitsAfter, value: valueAfter, qualityStatus: 'warning', priceSource: 'manual_entry' };
  }

  const fixture: IiManualFixture = {
    fixtureKey,
    sourceKey: 'manual',
    countryCode: 'IN',
    currencyCode: 'INR',
    documentType: 'manual_entry_record',
    originalFilename: `Manual entry — ${input.instrumentName} (${input.action})`,
    account: {
      accountType: 'demat',
      institutionName: input.accountInstitutionName,
      folioNumber: null,
      accountNumberMasked: input.accountNumberMasked ?? null,
    },
    instrument: {
      instrumentName: input.instrumentName,
      instrumentClass: input.instrumentClass,
      countryOfDomicile: 'IN',
      baseCurrency: 'INR',
      identifiers: [
        { scheme: 'isin' as const, value: normalisedIsin, countryCode: 'IN' as const },
        ...(input.exchange && input.exchangeSymbol
          ? [{ scheme: (input.exchange === 'NSE' ? 'nse_symbol' : 'bse_code') as 'nse_symbol' | 'bse_code', value: input.exchangeSymbol, countryCode: 'IN' as const }]
          : []),
      ],
    },
    transactions,
    holdingSnapshot,
    supersedesFixtureKey: null,
    reconciliation: null,
  };

  const importResult = await importManualFixture(userId, fixture);
  if (importResult.error || !importResult.instrumentId) {
    return { ...empty, ...importResult, validationError: null, validationErrorCode: null };
  }

  const taxClassificationSeeded = await ensureDirectSecurityTaxClassification(importResult.instrumentId, input.instrumentClass, input.isEquityOriented);

  return {
    ...importResult,
    taxClassificationSeeded,
    unitsAfter,
    valueAfter,
    validationError: null,
    validationErrorCode: null,
  };
}
