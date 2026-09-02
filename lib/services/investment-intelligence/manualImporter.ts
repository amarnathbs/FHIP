import { createHash } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';
import { findOrCreateIiAccountServiceRole } from './accounts';
import { resolveOrCreateInstrument } from './identifiers';
import type { IiManualFixture } from '@/lib/validation/investment-intelligence';
import { resolveCrossSourceTransactionMatch, type CrossSourceExistingTransaction } from './crossSourceIdentity';
import { loadActiveReconciliationConfig } from './reconciliationConfig';
import { openReconciliationCase } from './documentProcessing';
import { fetchAllRows } from './pagination';

// The controlled, deterministic manual/test importer (R1_IMPLEMENTATION_SPEC.md
// section 8) — NOT the production CAS parser (explicit non-goal). Proves the
// full architecture end-to-end from a fixture JSON rather than a real
// parsed statement:
//
//   Validated deterministic input -> ii_source_documents -> ii_accounts ->
//   ii_instruments (+ ii_instrument_identifiers) -> ii_transactions ->
//   ii_holding_snapshots -> provenance -> audit -> secure retrieval
//
// Idempotency (PROV-008, ADR-003): the fixture's own content is hashed into
// a deterministic checksum; re-running the identical fixture for the same
// user resolves to the SAME ii_source_documents row rather than creating a
// duplicate chain — this is exactly the "same file uploaded twice" behaviour
// the spec requires to be deterministic and explainable.
export function computeFixtureChecksum(fixture: IiManualFixture): string {
  return createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
}

export interface ManualImportResult {
  sourceDocumentId: string | null;
  accountId: string | null;
  instrumentId: string | null;
  transactionIds: string[];
  holdingSnapshotId: string | null;
  reconciliationCaseId: string | null;
  wasNewDocument: boolean;
  error: string | null;
}

// PC1-D3 — idempotent-replay result builder. Shared by (a) the up-front
// checksum lookup below and (b) the race-losing branch of the insert
// itself (two concurrent identical submissions can both pass the up-front
// SELECT before either INSERTs — see the 23505 handling below). Populates
// EVERY field from the already-committed chain, including instrumentId and
// transactionIds, which the previous implementation left null/empty on
// replay — that made a perfectly safe idempotent replay look like a
// failure to submitManualDirectPosition's `!importResult.instrumentId`
// error branch, discarding unitsAfter/valueAfter on a harmless resubmit.
async function buildReplayResult(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  institutionName: string,
  sourceDocumentId: string
): Promise<ManualImportResult> {
  const { data: account } = await admin
    .from('ii_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('institution_name', institutionName)
    .maybeSingle();
  const { data: snapshot } = await admin
    .from('ii_holding_snapshots')
    .select('id, instrument_id')
    .eq('user_id', userId)
    .eq('source_document_id', sourceDocumentId)
    .maybeSingle();
  const { data: txnRows } = await admin
    .from('ii_transactions')
    .select('id, instrument_id')
    .eq('user_id', userId)
    .eq('source_document_id', sourceDocumentId)
    .order('id', { ascending: true });
  const instrumentId = (snapshot?.instrument_id as string | undefined) ?? (txnRows?.[0]?.instrument_id as string | undefined) ?? null;

  return {
    sourceDocumentId,
    accountId: (account?.id as string) ?? null,
    instrumentId,
    transactionIds: (txnRows ?? []).map((r) => r.id as string),
    holdingSnapshotId: (snapshot?.id as string) ?? null,
    reconciliationCaseId: null,
    wasNewDocument: false,
    error: null,
  };
}

// PC1-D3 — deterministic storage_path this importer always writes a
// fixture's ii_source_documents row under (see the INSERT below). Exported
// so a caller that knows its own stable `fixtureKey` BEFORE building the
// full fixture object (manualDirectPositionService.ts) can check for an
// existing submission by that key alone, without needing content-derived
// fields that depend on current DB state (see findExistingManualImportByFixtureKey's
// doc comment for why that distinction is the actual D3 fix).
export function manualFixtureStoragePath(userId: string, fixtureKey: string): string {
  return `${userId}/fixtures/${fixtureKey}.json`;
}

// PC1-D3 — the ROOT CAUSE this closes: computeFixtureChecksum hashes the
// ENTIRE fixture, including manualDirectPositionService.ts's `holdingSnapshot`
// (unitsAfter/valueAfter), which are DERIVED from the CURRENT position read
// fresh from the DB at call time. Resubmitting the exact same raw user
// input a second time — AFTER the first submission has already
// committed — makes readCurrentPosition() see a DIFFERENT "current"
// position than the first call did, so the derived holdingSnapshot (and
// therefore the whole-fixture checksum) differs even though the user
// submitted nothing new. That silently defeated import-level idempotency
// for buy/sale actions specifically (live-DEV-reproduced: a sequential
// exact-duplicate 'buy' created a SECOND ii_source_documents/transaction
// with a doubled cumulative unitsAfter, instead of replaying the first).
//
// Fix: check for an existing submission using ONLY the caller's stable,
// content-derived `fixtureKey` (deterministic from the RAW input alone —
// stableFixtureKey() in manualDirectPositionService.ts never depends on
// current position) — BEFORE any derived/current-state-dependent value is
// computed. `storage_path` is where that key already deterministically
// lives once the first submission wrote it.
export async function findExistingManualImportByFixtureKey(userId: string, fixtureKey: string): Promise<{ id: string } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('ii_source_documents')
    .select('id')
    .eq('user_id', userId)
    .eq('storage_path', manualFixtureStoragePath(userId, fixtureKey))
    .maybeSingle();
  return (data as { id: string } | null) ?? null;
}

/** Public wrapper around buildReplayResult for a caller (manualDirectPositionService.ts) that found an existing submission via findExistingManualImportByFixtureKey. */
export async function resolveManualImportReplay(userId: string, institutionName: string, sourceDocumentId: string): Promise<ManualImportResult> {
  const admin = createAdminClient();
  return buildReplayResult(admin, userId, institutionName, sourceDocumentId);
}

export async function importManualFixture(userId: string, fixture: IiManualFixture): Promise<ManualImportResult> {
  const admin = createAdminClient();
  const empty: ManualImportResult = {
    sourceDocumentId: null,
    accountId: null,
    instrumentId: null,
    transactionIds: [],
    holdingSnapshotId: null,
    reconciliationCaseId: null,
    wasNewDocument: false,
    error: null,
  };

  const checksum = computeFixtureChecksum(fixture);

  // Idempotency check — re-importing the identical fixture for the same
  // user must be a no-op that returns the already-created chain, never a
  // silent duplicate (DB-006, PROV-008).
  const { data: existingDoc } = await admin
    .from('ii_source_documents')
    .select('id, status')
    .eq('user_id', userId)
    .eq('checksum', checksum)
    .maybeSingle();

  if (existingDoc) {
    return buildReplayResult(admin, userId, fixture.account.institutionName, existingDoc.id as string);
  }

  // Resolve the superseded document, if this fixture represents a refreshed
  // statement (R0_NET_WORTH_DEDUP_CONTRACT.md scenario 11). ii_instrument
  // fixture-shaped "document_type" is a fixed enum with no room for a raw
  // fixtureKey tag, so the lookup instead takes the user's most recently
  // parsed document — sufficient for the deterministic single-user test
  // fixtures this importer exists to serve (real supersession matching
  // is a parser-pipeline concern, out of scope for R1's manual importer).
  let supersededDocId: string | null = null;
  if (fixture.supersedesFixtureKey) {
    const { data: prior } = await admin
      .from('ii_source_documents')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'parsed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    supersededDocId = (prior?.id as string) ?? null;
  }

  // 1. ii_source_documents — the provenance root. storage_path is a
  // deterministic placeholder key for fixture-driven test data (no real
  // file bytes exist for a manual-importer fixture); real uploads go
  // through app/api/investment-intelligence/source-documents/route.ts
  // instead, which calls lib/services/investment-intelligence/storage.ts.
  const { data: doc, error: docErr } = await admin
    .from('ii_source_documents')
    .insert({
      user_id: userId,
      country_code: fixture.countryCode,
      status: 'uploaded',
      checksum,
      storage_path: `${userId}/fixtures/${fixture.fixtureKey}.json`,
      original_filename: fixture.originalFilename,
      mime_type: 'application/json',
      file_size: JSON.stringify(fixture).length,
      document_type: fixture.documentType,
    })
    .select('id')
    .single();
  if (docErr?.code === '23505') {
    // PC1-D3 concurrency — the up-front SELECT above found nothing, but a
    // concurrent duplicate submission won the race and committed first;
    // `uidx_ii_source_documents_user_checksum` (migration 0032) rejected
    // this INSERT. This is NOT a real error — it is exactly the
    // idempotent-replay case, just discovered one step later than usual —
    // so re-look-up the winner and return the same safe replay result a
    // sequential resubmission would have gotten, never the raw
    // unique-constraint text (no internal schema/constraint detail must
    // reach the client).
    const { data: winner } = await admin.from('ii_source_documents').select('id').eq('user_id', userId).eq('checksum', checksum).maybeSingle();
    if (winner) return buildReplayResult(admin, userId, fixture.account.institutionName, winner.id as string);
    return { ...empty, error: 'This submission could not be recorded — please retry.' };
  }
  if (docErr || !doc) return { ...empty, error: docErr ? 'This submission could not be recorded — please retry.' : 'Source document creation failed' };

  await emitAuditEvent({
    userId,
    eventType: 'upload',
    subjectType: 'ii_source_documents',
    subjectId: doc.id as string,
    actorType: 'system',
    metadata: { sourceDocumentId: doc.id, originalFilename: fixture.originalFilename, fileSize: JSON.stringify(fixture).length },
  });

  await admin.from('ii_source_documents').update({ status: 'parsing' }).eq('id', doc.id);
  await emitAuditEvent({
    userId,
    eventType: 'parse',
    subjectType: 'ii_source_documents',
    subjectId: doc.id as string,
    actorType: 'system',
    metadata: { sourceDocumentId: doc.id, parserVersion: 'manual-test-importer-1.0.0' },
  });

  // 2. ii_accounts — find-or-create.
  const accountResult = await findOrCreateIiAccountServiceRole(userId, {
    accountType: fixture.account.accountType,
    institutionName: fixture.account.institutionName,
    countryCode: fixture.countryCode,
    currencyCode: fixture.currencyCode,
    folioNumber: fixture.account.folioNumber,
    accountNumberMasked: fixture.account.accountNumberMasked,
    sourceDocumentId: doc.id as string,
  });
  if (accountResult.error || !accountResult.accountId) {
    await admin.from('ii_source_documents').update({ status: 'parse_failed', parse_error: accountResult.error }).eq('id', doc.id);
    return { ...empty, sourceDocumentId: doc.id as string, error: accountResult.error };
  }

  // 3. ii_instruments (+ identifiers) — alias resolution (ADR-002).
  const instrumentResult = await resolveOrCreateInstrument({
    candidates: fixture.instrument.identifiers.map((i) => ({ scheme: i.scheme, value: i.value, countryCode: i.countryCode })),
    instrumentName: fixture.instrument.instrumentName,
    instrumentClass: fixture.instrument.instrumentClass,
    countryOfDomicile: fixture.instrument.countryOfDomicile,
    baseCurrency: fixture.instrument.baseCurrency,
  });
  if (instrumentResult.error || !instrumentResult.instrumentId) {
    await admin.from('ii_source_documents').update({ status: 'parse_failed', parse_error: instrumentResult.error }).eq('id', doc.id);
    return { ...empty, sourceDocumentId: doc.id as string, accountId: accountResult.accountId, error: instrumentResult.error };
  }

  // 4. ii_transactions — immutable ledger. A source_reference collision
  // (the same provider transaction re-appearing in a re-parse) is an
  // idempotent no-op (ignoreDuplicates:true), never an overwrite of an
  // existing immutable row (ADR-003 testing implications).
  const transactionIds: string[] = [];
  const reconciliationConfig = await loadActiveReconciliationConfig();
  for (const tx of fixture.transactions) {
    // R11 — cross-source identity resolution (spec sections 24-41), same
    // check documentProcessing.ts's CAMS/KFintech pipeline performs before
    // inserting a transaction. Manual import is itself an in-scope R11
    // source (R11_SCOPE_AND_ARCHITECTURE_RECONCILIATION.md line 32): a
    // transaction manually imported AFTER a CAMS/KFintech statement already
    // evidenced the same real-world transaction must be linked as
    // corroborating evidence, never inserted as a second canonical row —
    // otherwise cross-source dedup would only work in the CAMS/KFintech-
    // arrives-second direction, breaking the import-order-independence
    // invariant (spec section 74's "import order changes canonical truth").
    // fetchAllRows, not a bare .select() — the same silent-1000-row-cap
    // hazard pagination.ts documents applies here exactly as it does to
    // documentProcessing.ts's loadCrossSourceCandidates: a position with
    // more than 1000 existing transactions must not have its later rows
    // silently invisible to this match, which would wrongly insert a
    // duplicate canonical row instead of linking (R6-P0 pagination class).
    const existingRows = await fetchAllRows<{
      id: string;
      account_id: string;
      instrument_id: string;
      transaction_date: string;
      transaction_type: string;
      gross_amount: string;
      units: string | null;
      source_reference: string | null;
      source_document_id: string | null;
      status: string;
    }>(() =>
      admin
        .from('ii_transactions')
        .select('id, account_id, instrument_id, transaction_date, transaction_type, gross_amount, units, source_reference, source_document_id, status')
        .eq('user_id', userId)
        .eq('account_id', accountResult.accountId)
        .eq('instrument_id', instrumentResult.instrumentId)
        .order('id', { ascending: true })
    );
    const crossSourceCandidates: CrossSourceExistingTransaction[] = existingRows
      .filter((r) => r.source_document_id !== null && r.source_document_id !== doc.id)
      .map((r) => ({
        id: r.id as string,
        sourceKey: '',
        sourceDocumentId: r.source_document_id as string,
        accountId: r.account_id as string,
        instrumentId: r.instrument_id as string,
        transactionDate: r.transaction_date as string,
        transactionType: r.transaction_type as string,
        grossAmount: String(r.gross_amount),
        units: r.units === null ? null : String(r.units),
        sourceReference: r.source_reference as string | null,
        status: r.status as string,
      }));

    let crossSourceStatus: 'parsed' | 'review_required' = 'parsed';
    if (crossSourceCandidates.length > 0) {
      const match = resolveCrossSourceTransactionMatch(
        {
          sourceKey: 'manual',
          sourceDocumentId: doc.id as string,
          accountId: accountResult.accountId as string,
          instrumentId: instrumentResult.instrumentId as string,
          transactionDate: tx.transactionDate,
          transactionType: tx.transactionType,
          grossAmount: String(tx.grossAmount),
          units: tx.units === undefined || tx.units === null ? null : String(tx.units),
          sourceReference: tx.sourceReference ?? null,
        },
        crossSourceCandidates,
        reconciliationConfig
      );

      if ((match.state === 'exact' || match.state === 'high_confidence') && match.matchedExistingId) {
        // Same real-world transaction, corroborated by manual evidence —
        // link, do not duplicate.
        await admin.from('ii_transaction_source_links').upsert(
          {
            user_id: userId,
            transaction_id: match.matchedExistingId,
            source_document_id: doc.id,
            parse_run_id: null,
            is_originating: false,
            match_basis: match.state === 'exact' ? 'cross_source_exact' : 'cross_source_high_confidence',
          },
          { onConflict: 'transaction_id,source_document_id', ignoreDuplicates: true }
        );
        const caseId = await openReconciliationCase(userId, {
          subjectType: 'transaction',
          subjectId: match.matchedExistingId,
          discrepancyType: match.state === 'exact' ? 'cross_source_exact_duplicate' : 'cross_source_high_confidence_duplicate',
          severity: 'info',
          sourceDocumentId: doc.id as string,
          details: { matchedFields: match.matchedFields, differingFields: match.differingFields, rationale: match.rationale },
          evidence: { comparedTransactionIds: [match.matchedExistingId], engineVersion: match.engineVersion, newSourceDocumentId: doc.id },
        });
        if (caseId) {
          await admin
            .from('ii_reconciliation_cases')
            .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_by_actor_type: 'system', resolution_method: 'auto_resolved_cross_source_precedence' })
            .eq('id', caseId);
        }
        transactionIds.push(match.matchedExistingId);
        continue; // no new canonical row — the loop moves to the next fixture transaction
      }

      if (match.state === 'conflict' || match.state === 'ambiguous') {
        // Never silently merge — insert this row too (both pieces of
        // evidence preserved), but excluded from analytical aggregation
        // until a human resolves the case (same contract as
        // documentProcessing.ts).
        await openReconciliationCase(userId, {
          subjectType: 'transaction',
          subjectId: accountResult.accountId as string,
          discrepancyType: match.state === 'conflict' ? 'cross_source_conflict' : 'cross_source_review_required',
          severity: 'high',
          sourceDocumentId: doc.id as string,
          details: { matchedFields: match.matchedFields, differingFields: match.differingFields, rationale: match.rationale, transactionDate: tx.transactionDate },
          evidence: { comparedTransactionIds: match.ambiguousCandidateIds.length > 0 ? match.ambiguousCandidateIds : match.matchedExistingId ? [match.matchedExistingId] : [], engineVersion: match.engineVersion, newSourceDocumentId: doc.id },
        });
        crossSourceStatus = 'review_required';
      }
    }

    const txPayload = {
      user_id: userId,
      account_id: accountResult.accountId,
      instrument_id: instrumentResult.instrumentId,
      source_document_id: doc.id,
      currency_code: fixture.currencyCode,
      transaction_type: tx.transactionType,
      transaction_date: tx.transactionDate,
      units: tx.units ?? null,
      price_per_unit: tx.pricePerUnit ?? null,
      gross_amount: tx.grossAmount,
      source_reference: tx.sourceReference ?? null,
      status: crossSourceStatus,
      // R12 addition -- explicit-only, never inferred (spec section 33).
      fees: tx.fees ?? null,
      taxes: tx.taxes ?? null,
    };
    // R3 closure-pass fix: uidx_ii_transactions_dedup (migration 0033) is a
    // PARTIAL unique index (`where source_document_id is not null and
    // source_reference is not null`). Postgres/PostgREST will only use a
    // partial index as an ON CONFLICT arbiter when the request's ON
    // CONFLICT target itself carries a matching WHERE clause — a bare
    // column-list upsert (what Supabase-js's `.upsert(payload, {onConflict})`
    // sends) does NOT match it and fails with 42P10 ("no unique or
    // exclusion constraint matching the ON CONFLICT specification"). This
    // was a real, live-verified defect (first ever live execution of this
    // code path — see R2_ACCEPTANCE_REPORT.md's closure-pass addendum) in
    // this test-only helper (never in the production parser path, which
    // already uses the safe select-then-insert pattern below —
    // documentProcessing.ts lines ~418-442). Fixed the same way here:
    // select-then-insert instead of upsert-against-a-partial-index.
    let created: { id: string } | null = null;
    let txErr: { message: string } | null = null;
    if (tx.sourceReference) {
      const { data: existing } = await admin
        .from('ii_transactions')
        .select('id')
        .eq('account_id', accountResult.accountId)
        .eq('source_document_id', doc.id)
        .eq('source_reference', tx.sourceReference)
        .maybeSingle();
      if (existing) {
        created = existing as { id: string };
      } else {
        const { data: inserted, error } = await admin.from('ii_transactions').insert(txPayload).select('id').single();
        created = inserted as { id: string } | null;
        txErr = error;
      }
    } else {
      const { data: inserted, error } = await admin.from('ii_transactions').insert(txPayload).select('id').single();
      created = inserted as { id: string } | null;
      txErr = error;
    }
    if (txErr) {
      await admin.from('ii_source_documents').update({ status: 'parse_failed', parse_error: txErr.message }).eq('id', doc.id);
      return {
        ...empty,
        sourceDocumentId: doc.id as string,
        accountId: accountResult.accountId,
        instrumentId: instrumentResult.instrumentId,
        transactionIds,
        error: txErr.message,
      };
    }
    let txId = (created?.id as string) ?? null;
    if (!txId && tx.sourceReference) {
      const { data: existingTx } = await admin
        .from('ii_transactions')
        .select('id')
        .eq('account_id', accountResult.accountId)
        .eq('source_document_id', doc.id)
        .eq('source_reference', tx.sourceReference)
        .maybeSingle();
      txId = (existingTx?.id as string) ?? null;
    }
    if (txId) transactionIds.push(txId);
  }

  // 5. ii_holding_snapshots — immutable, one per (account, instrument, date).
  const { data: snapshot, error: snapErr } = await admin
    .from('ii_holding_snapshots')
    .upsert(
      {
        user_id: userId,
        account_id: accountResult.accountId,
        instrument_id: instrumentResult.instrumentId,
        source_document_id: doc.id,
        currency_code: fixture.currencyCode,
        quality_status: fixture.holdingSnapshot.qualityStatus,
        as_of_date: fixture.holdingSnapshot.asOfDate,
        units: fixture.holdingSnapshot.units,
        value: fixture.holdingSnapshot.value,
        // R12 addition -- price provenance. null for pre-R12 fixtures.
        price_source: fixture.holdingSnapshot.priceSource ?? null,
      },
      { onConflict: 'account_id,instrument_id,as_of_date', ignoreDuplicates: true }
    )
    .select('id')
    .maybeSingle();
  if (snapErr) {
    await admin.from('ii_source_documents').update({ status: 'parse_failed', parse_error: snapErr.message }).eq('id', doc.id);
    return {
      ...empty,
      sourceDocumentId: doc.id as string,
      accountId: accountResult.accountId,
      instrumentId: instrumentResult.instrumentId,
      transactionIds,
      error: snapErr.message,
    };
  }
  // ignoreDuplicates:true returns no row on a pre-existing conflict — look
  // it up explicitly so callers always get a real snapshot id back.
  let holdingSnapshotId = (snapshot?.id as string) ?? null;
  if (!holdingSnapshotId) {
    const { data: existingSnap } = await admin
      .from('ii_holding_snapshots')
      .select('id')
      .eq('account_id', accountResult.accountId)
      .eq('instrument_id', instrumentResult.instrumentId)
      .eq('as_of_date', fixture.holdingSnapshot.asOfDate)
      .maybeSingle();
    holdingSnapshotId = (existingSnap?.id as string) ?? null;
  }

  // 6. Supersession chain, if this fixture represents a refreshed statement.
  if (supersededDocId) {
    await admin.from('ii_source_documents').update({ status: 'superseded', superseded_by_document_id: doc.id }).eq('id', supersededDocId);
    await emitAuditEvent({
      userId,
      eventType: 'archive',
      subjectType: 'ii_source_documents',
      subjectId: supersededDocId,
      actorType: 'system',
      metadata: { reason: 'superseded_by_new_document', supersededByDocumentId: doc.id },
    });
  }

  // 7. Reconciliation case, if this fixture represents a discrepancy
  // (R0_SOURCE_PROVENANCE_CONTRACT.md section 2 — a discrepancy opens a
  // case rather than silently certifying a disputed value).
  let reconciliationCaseId: string | null = null;
  if (fixture.reconciliation && holdingSnapshotId) {
    const { data: caseRow, error: caseErr } = await admin
      .from('ii_reconciliation_cases')
      .insert({
        user_id: userId,
        subject_type: 'holding_snapshot',
        subject_id: holdingSnapshotId,
        discrepancy_type: fixture.reconciliation.discrepancyType,
        discrepancy_details: fixture.reconciliation.discrepancyDetails ?? {},
      })
      .select('id')
      .single();
    if (!caseErr && caseRow) {
      reconciliationCaseId = caseRow.id as string;
      await emitAuditEvent({
        userId,
        eventType: 'reconciliation_opened',
        subjectType: 'ii_reconciliation_cases',
        subjectId: reconciliationCaseId,
        actorType: 'system',
        metadata: { subjectType: 'holding_snapshot', subjectId: holdingSnapshotId, discrepancyType: fixture.reconciliation.discrepancyType },
      });
    }
  }

  // 8. Finalize document lifecycle.
  await admin
    .from('ii_source_documents')
    .update({ status: 'parsed', parser_version: 'manual-test-importer-1.0.0', parse_completed_at: new Date().toISOString() })
    .eq('id', doc.id);
  await emitAuditEvent({
    userId,
    eventType: 'parse_completed',
    subjectType: 'ii_source_documents',
    subjectId: doc.id as string,
    actorType: 'system',
    metadata: {
      sourceDocumentId: doc.id,
      parserVersion: 'manual-test-importer-1.0.0',
      status: 'parsed',
      transactionsCreated: transactionIds.length,
    },
  });

  return {
    sourceDocumentId: doc.id as string,
    accountId: accountResult.accountId,
    instrumentId: instrumentResult.instrumentId,
    transactionIds,
    holdingSnapshotId,
    reconciliationCaseId,
    wasNewDocument: true,
    error: null,
  };
}
