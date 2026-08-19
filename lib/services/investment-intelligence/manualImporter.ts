import { createHash } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';
import { findOrCreateIiAccountServiceRole } from './accounts';
import { resolveOrCreateInstrument } from './identifiers';
import type { IiManualFixture } from '@/lib/validation/investment-intelligence';

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
    const { data: account } = await admin
      .from('ii_accounts')
      .select('id')
      .eq('user_id', userId)
      .eq('institution_name', fixture.account.institutionName)
      .maybeSingle();
    const { data: snapshot } = await admin
      .from('ii_holding_snapshots')
      .select('id')
      .eq('user_id', userId)
      .eq('source_document_id', existingDoc.id)
      .maybeSingle();
    return {
      ...empty,
      sourceDocumentId: existingDoc.id as string,
      accountId: (account?.id as string) ?? null,
      holdingSnapshotId: (snapshot?.id as string) ?? null,
      wasNewDocument: false,
    };
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
  if (docErr || !doc) return { ...empty, error: docErr?.message ?? 'Source document creation failed' };

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
  for (const tx of fixture.transactions) {
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
    };
    const { data: created, error: txErr } = tx.sourceReference
      ? await admin
          .from('ii_transactions')
          .upsert(txPayload, { onConflict: 'account_id,source_document_id,source_reference', ignoreDuplicates: true })
          .select('id')
          .maybeSingle()
      : await admin.from('ii_transactions').insert(txPayload).select('id').single();
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
