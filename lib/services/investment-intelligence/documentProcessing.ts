// Investment Intelligence R2 — the document-processing orchestrator. This
// is the "glue" layer wiring together every pure module (pdfExtraction,
// parsers/registry, schemeResolution, fingerprint, reconciliation,
// certification) into the real, DB-touching pipeline spec section 1
// describes end-to-end:
//
//   SOURCE DOCUMENT -> SOURCE IDENTIFICATION -> SAFE DOCUMENT EXTRACTION ->
//   SOURCE-SPECIFIC PARSER -> NORMALISED PARSED RECORDS -> FOLIO/ACCOUNT
//   RESOLUTION -> SCHEME/INSTRUMENT RESOLUTION -> TRANSACTION
//   NORMALISATION -> HOLDING RECONCILIATION -> EXCEPTION/RECONCILIATION
//   QUEUE -> CERTIFIED CANONICAL PORTFOLIO
//
// Every DB write in here uses the service-role client, matching R1's
// established pattern for trusted, already-authenticated server-side
// pipelines (accounts.ts's findOrCreateIiAccountServiceRole,
// manualImporter.ts) — the CALLER (the API route) is responsible for
// requireUser() + confirming the target ii_source_documents row belongs to
// that user BEFORE calling processSourceDocument. This function never
// accepts an unauthenticated or cross-user document id.
//
// ATOMICITY (spec section 54): canonical writes are staged in-memory as
// the full ParsedDocumentOutput BEFORE any row is written (parsing is 100%
// pure/in-memory — see parsers/registry.ts's parseExtractedDocument), so a
// parse-time failure never leaves partial canonical rows. Once writing
// begins, transactions/holdings are inserted idempotently (fingerprint/
// unique-index guarded) — a write-time failure partway through leaves
// already-written rows valid (each one individually idempotent and
// re-derivable on retry) rather than a torn, inconsistent half-state; the
// run is marked 'failed' and is safely retryable (spec section 53).

import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';
import { downloadSourceDocumentObject } from './storage';
import { extractPdfText } from './pdfExtraction';
import { parseExtractedDocument } from './parsers/registry';
import type { ParsedDocumentOutput, ParsedInstrumentRecord, ParsedTransactionRecord } from './parsers/types';
import { resolveOrCreateAccount } from './accountResolution';
import { resolveScheme, type AliasMapRow, type ExistingInstrumentForResolution } from './schemeResolution';
import { computeTransactionFingerprint } from './fingerprint';
import { reconcilePosition, determineHistoryCompleteness, type ReconciliationTransactionInput } from './reconciliation';
import { evaluateCertification } from './certification';
import { loadActiveReconciliationConfig } from './reconciliationConfig';
import { scaledToDecimalString, ZERO } from './decimal';
import { isoDateDaysBetween } from './dateNormalisation';
import { normaliseSchemeName, detectPlanType, detectOptionType } from './parsers/textUtils';
import { randomUUID } from 'crypto';
import type { IiPlanType, IiOptionType, IiPortfolioTruthStatus } from './types';

export interface ProcessSourceDocumentInput {
  userId: string;
  sourceDocumentId: string;
  password?: string;
  forceReparse?: boolean;
}

export interface ProcessSourceDocumentResult {
  ok: boolean;
  status: string; // resulting ii_source_documents.status
  parseRunId: string | null;
  summary?: {
    sourceDetected: string | null;
    sourceConfidence: number;
    accountsFound: number;
    schemesFound: number;
    transactionsFound: number;
    holdingsFound: number;
    duplicateTransactionsLinked: number;
    reconciliationCasesOpened: number;
  };
  error: string | null;
  reconciliationCaseId?: string | null; // set when the failure IS a reconciliation case (password/unsupported/corrupt)
}

async function openReconciliationCase(
  userId: string,
  input: {
    subjectType: 'holding_snapshot' | 'transaction' | 'account';
    subjectId: string;
    discrepancyType: string;
    severity: 'info' | 'low' | 'medium' | 'high' | 'blocking';
    sourceDocumentId: string | null;
    details: Record<string, unknown>;
    evidence?: Record<string, unknown>;
  }
): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ii_reconciliation_cases')
    .insert({
      user_id: userId,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      discrepancy_type: input.discrepancyType,
      severity: input.severity,
      source_document_id: input.sourceDocumentId,
      discrepancy_details: input.details,
      evidence: input.evidence ?? null,
    })
    .select('id')
    .single();
  if (error || !data) return null;
  await emitAuditEvent({
    userId,
    eventType: 'reconciliation_case_created',
    subjectType: 'ii_reconciliation_cases',
    subjectId: data.id as string,
    actorType: 'system',
    metadata: { discrepancyType: input.discrepancyType, severity: input.severity, subjectType: input.subjectType, subjectId: input.subjectId },
  });
  return data.id as string;
}

export async function processSourceDocument(input: ProcessSourceDocumentInput): Promise<ProcessSourceDocumentResult> {
  const admin = createAdminClient();
  const { userId, sourceDocumentId } = input;

  const { data: doc, error: docErr } = await admin.from('ii_source_documents').select('*').eq('id', sourceDocumentId).eq('user_id', userId).maybeSingle();
  if (docErr || !doc) return { ok: false, status: 'not_found', parseRunId: null, error: 'Source document not found.' };

  // Idempotency: at most one active run at a time (DB constraint
  // enforces this too; checked here first for a clean error message).
  const { data: activeRun } = await admin
    .from('ii_document_parse_runs')
    .select('id')
    .eq('source_document_id', sourceDocumentId)
    .in('run_status', ['queued', 'running'])
    .maybeSingle();
  if (activeRun) return { ok: false, status: doc.status as string, parseRunId: activeRun.id as string, error: 'This document is already being processed.' };

  // Idempotency: a prior SUCCEEDED run with the same parser code/version
  // is not silently re-run unless forced (spec section 52).
  if (!input.forceReparse) {
    const { data: priorSucceeded } = await admin
      .from('ii_document_parse_runs')
      .select('*')
      .eq('source_document_id', sourceDocumentId)
      .eq('run_status', 'succeeded')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (priorSucceeded) {
      return {
        ok: true,
        status: doc.status as string,
        parseRunId: priorSucceeded.id as string,
        summary: {
          sourceDetected: priorSucceeded.source_detected as string | null,
          sourceConfidence: (priorSucceeded.source_confidence as number) ?? 0,
          accountsFound: priorSucceeded.accounts_found as number,
          schemesFound: priorSucceeded.schemes_found as number,
          transactionsFound: priorSucceeded.transactions_found as number,
          holdingsFound: priorSucceeded.holdings_found as number,
          duplicateTransactionsLinked: 0,
          reconciliationCasesOpened: 0,
        },
        error: null,
      };
    }
  }

  const parserCode = 'r2-orchestrator'; // resolved to a real per-parser code once detection succeeds; placeholder until then
  const idempotencyKey = `${sourceDocumentId}:${parserCode}:${randomUUID()}`;
  const { data: run, error: runErr } = await admin
    .from('ii_document_parse_runs')
    .insert({
      user_id: userId,
      source_document_id: sourceDocumentId,
      parser_code: parserCode,
      parser_version: 'pending',
      run_status: 'running',
      idempotency_key: idempotencyKey,
    })
    .select('id')
    .single();
  if (runErr || !run) return { ok: false, status: doc.status as string, parseRunId: null, error: runErr?.message ?? 'Could not start a processing run.' };
  const parseRunId = run.id as string;

  await emitAuditEvent({ userId, eventType: 'parse_started', subjectType: 'ii_source_documents', subjectId: sourceDocumentId, actorType: 'user', actorId: userId, metadata: { parseRunId } });

  // --- 1. Safe document extraction --------------------------------------
  const { bytes, error: dlErr } = await downloadSourceDocumentObject(doc.storage_path as string);
  if (dlErr || !bytes) {
    await failRun(admin, parseRunId, 'Could not retrieve the stored document.');
    await admin.from('ii_source_documents').update({ status: 'parse_failed', parse_error: 'storage_download_failed' }).eq('id', sourceDocumentId);
    return { ok: false, status: 'parse_failed', parseRunId, error: 'Could not retrieve the stored document.' };
  }

  let text: string;
  let extractionMethod: string;
  if (doc.mime_type === 'application/pdf') {
    const extraction = await extractPdfText(bytes, input.password);
    if (!extraction.ok) {
      return handleExtractionFailure(admin, userId, sourceDocumentId, parseRunId, extraction.kind, extraction.error);
    }
    text = extraction.text;
    extractionMethod = 'pdf_text_native';
  } else {
    text = Buffer.from(bytes).toString('utf8');
    extractionMethod = 'csv_text';
  }

  // --- 2. Source identification + parser run ------------------------------
  const { detection, parsed } = parseExtractedDocument(text);
  await emitAuditEvent({
    userId,
    eventType: 'source_detected',
    subjectType: 'ii_source_documents',
    subjectId: sourceDocumentId,
    actorType: 'system',
    metadata: { sourceDetected: detection.detection.sourceKey, confidence: detection.detection.confidence, candidates: detection.allCandidates.map((c) => ({ parserCode: c.parserCode, confidence: c.detection.confidence })) },
  });

  if (!detection.parser || !parsed) {
    const status = detection.detection.confidence > 0 ? 'reconciliation_required' : 'unsupported';
    await admin
      .from('ii_source_documents')
      .update({
        status,
        source_detected: detection.detection.sourceKey,
        source_confidence: detection.detection.confidence,
        extraction_method: extractionMethod,
      })
      .eq('id', sourceDocumentId);
    const caseId = await openReconciliationCase(userId, {
      subjectType: 'account',
      subjectId: sourceDocumentId, // no account exists yet — the document itself is the subject
      discrepancyType: 'unsupported_document',
      severity: 'blocking',
      sourceDocumentId,
      details: { sourceConfidence: detection.detection.confidence, candidates: detection.allCandidates },
    });
    await admin.from('ii_document_parse_runs').update({ run_status: 'failed', completed_at: new Date().toISOString(), source_detected: detection.detection.sourceKey, source_confidence: detection.detection.confidence }).eq('id', parseRunId);
    await emitAuditEvent({ userId, eventType: 'parse_failed', subjectType: 'ii_source_documents', subjectId: sourceDocumentId, actorType: 'system', metadata: { reason: 'source_undetected_or_unsupported', parseRunId } });
    return { ok: false, status, parseRunId, error: 'Statement source/format could not be confidently identified.', reconciliationCaseId: caseId };
  }

  await emitAuditEvent({
    userId,
    eventType: 'parser_version_used',
    subjectType: 'ii_source_documents',
    subjectId: sourceDocumentId,
    actorType: 'system',
    metadata: { parserCode: parsed.parserCode, parserVersion: parsed.parserVersion, parseRunId },
  });

  const validation = detection.parser.validateParsedOutput(parsed);
  if (!validation.ok) {
    await admin
      .from('ii_source_documents')
      .update({ status: 'parse_failed', parse_error: validation.errors.join('; '), source_detected: detection.detection.sourceKey, source_confidence: detection.detection.confidence, extraction_method: extractionMethod })
      .eq('id', sourceDocumentId);
    const caseId = await openReconciliationCase(userId, {
      subjectType: 'account',
      subjectId: sourceDocumentId,
      discrepancyType: 'parse_incomplete',
      severity: 'blocking',
      sourceDocumentId,
      details: { errors: validation.errors },
    });
    await admin.from('ii_document_parse_runs').update({ run_status: 'failed', completed_at: new Date().toISOString(), errors: validation.errors }).eq('id', parseRunId);
    await emitAuditEvent({ userId, eventType: 'parse_failed', subjectType: 'ii_source_documents', subjectId: sourceDocumentId, actorType: 'system', metadata: { reason: 'validation_failed', errors: validation.errors, parseRunId } });
    return { ok: false, status: 'parse_failed', parseRunId, error: validation.errors.join('; '), reconciliationCaseId: caseId };
  }

  // --- 3. Folio/account resolution ---------------------------------------
  const countryCode = doc.country_code as string;
  const currencyCode = countryCode === 'IN' ? 'INR' : 'AUD';
  const accountIdByFolio = new Map<string, string>();
  let reconciliationCasesOpened = 0;

  for (const acc of parsed.accounts) {
    const folioKey = acc.folioNumber ?? '__no_folio__';
    if (accountIdByFolio.has(folioKey)) continue;
    const resolved = await resolveOrCreateAccount(userId, {
      accountType: 'mf_folio',
      institutionName: acc.amcName || (parsed.transactions[0]?.scheme.amcName ?? 'Unknown AMC'),
      countryCode,
      currencyCode,
      folioNumber: acc.folioNumber,
      accountNumberMasked: acc.accountNumberMasked,
      ownerMemberId: (doc.owner_member_id as string | null) ?? null,
      sourceDocumentId,
    });
    if (resolved.accountId) {
      accountIdByFolio.set(folioKey, resolved.accountId);
      await emitAuditEvent({ userId, eventType: 'account_resolved', subjectType: 'ii_accounts', subjectId: resolved.accountId, actorType: 'system', metadata: { folioNumber: acc.folioNumber, created: resolved.created, parseRunId } });
    }
  }

  const ownerUnresolved = !doc.owner_member_id;
  if (ownerUnresolved) {
    for (const [, accountId] of accountIdByFolio) {
      const caseId = await openReconciliationCase(userId, {
        subjectType: 'account',
        subjectId: accountId,
        discrepancyType: 'owner_unmatched',
        severity: 'blocking',
        sourceDocumentId,
        details: { reason: 'No household member was specified for this statement at upload time.' },
      });
      if (caseId) reconciliationCasesOpened++;
    }
  }

  // --- 4. Scheme/instrument resolution ------------------------------------
  const instrumentIdByKey = new Map<string, string>(); // key = normalisedSchemeName|plan|option|amc
  const instrumentUnresolvedKeys = new Set<string>();

  const uniqueSchemes = new Map<string, ParsedInstrumentRecord>();
  for (const t of parsed.transactions) uniqueSchemes.set(schemeKey(t.scheme), t.scheme);
  for (const h of parsed.holdings) uniqueSchemes.set(schemeKey(h.scheme), h.scheme);

  const { data: existingIdentifierRows } = await admin.from('ii_instrument_identifiers').select('instrument_id, identifier_scheme, identifier_value, country_code').eq('is_active', true);
  const { data: existingInstrumentRows } = await admin.from('ii_instruments').select('id, instrument_name, amc_name, plan_type, option_type, country_of_domicile').eq('is_active', true);
  const { data: aliasRowsRaw } = await admin.from('ii_scheme_alias_map').select('*').eq('is_active', true);

  const existingForResolution: ExistingInstrumentForResolution[] = (existingInstrumentRows ?? []).map((r) => {
    const isin = (existingIdentifierRows ?? []).find((i) => i.instrument_id === r.id && i.identifier_scheme === 'isin')?.identifier_value ?? null;
    const amfi = (existingIdentifierRows ?? []).find((i) => i.instrument_id === r.id && i.identifier_scheme === 'amfi_scheme_code')?.identifier_value ?? null;
    const internalCode = (existingIdentifierRows ?? []).find((i) => i.instrument_id === r.id && i.identifier_scheme === 'internal_provisional')?.identifier_value ?? null;
    return {
      instrumentId: r.id as string,
      isin,
      amfiSchemeCode: amfi,
      internalProvisionalCode: internalCode,
      normalisedSchemeName: normaliseSchemeName(r.instrument_name as string),
      amcName: (r.amc_name as string) ?? null,
      planType: (r.plan_type as IiPlanType) ?? null,
      optionType: (r.option_type as IiOptionType) ?? null,
      countryCode: r.country_of_domicile as string,
    };
  });
  const aliasRows: AliasMapRow[] = (aliasRowsRaw ?? []).map((a) => ({
    rawSchemeNameNormalised: a.raw_scheme_name_normalised as string,
    amcName: (a.amc_name as string) ?? null,
    planType: (a.plan_type as IiPlanType) ?? null,
    optionType: (a.option_type as IiOptionType) ?? null,
    countryCode: (a.country_code as string) ?? null,
    resolvedInstrumentId: a.resolved_instrument_id as string,
  }));

  for (const [key, scheme] of uniqueSchemes) {
    const outcome = resolveScheme(
      { isin: scheme.isin, amfiSchemeCode: scheme.amfiSchemeCode, internalProvisionalCode: null, normalisedSchemeName: scheme.normalisedSchemeName, amcName: scheme.amcName, planType: scheme.planType, optionType: scheme.optionType, countryCode },
      existingForResolution,
      aliasRows
    );
    if (outcome.kind === 'resolved') {
      instrumentIdByKey.set(key, outcome.instrumentId);
      await emitAuditEvent({ userId, eventType: 'instrument_resolved', subjectType: 'ii_instruments', subjectId: outcome.instrumentId, actorType: 'system', metadata: { matchedVia: outcome.matchedVia, confidence: outcome.confidence, scheme: scheme.rawSchemeName, parseRunId } });
      continue;
    }
    if (outcome.kind === 'ambiguous') {
      instrumentUnresolvedKeys.add(key);
      const caseId = await openReconciliationCase(userId, {
        subjectType: 'account',
        subjectId: sourceDocumentId,
        discrepancyType: 'ambiguous_instrument',
        severity: 'high',
        sourceDocumentId,
        details: { scheme: scheme.rawSchemeName, matchedVia: outcome.matchedVia, candidateInstrumentIds: outcome.candidateInstrumentIds, reason: outcome.reason },
      });
      if (caseId) reconciliationCasesOpened++;
      continue;
    }
    // unresolved — create a new provisional instrument (ADR-002 pattern),
    // NOT a blocker (a genuinely first-seen scheme is expected, not an
    // error).
    const { data: created, error: createErr } = await admin
      .from('ii_instruments')
      .insert({
        instrument_name: scheme.rawSchemeName,
        instrument_class: 'mutual_fund',
        country_of_domicile: countryCode,
        base_currency: currencyCode,
        isin: scheme.isin,
        status: 'provisional',
        plan_type: scheme.planType,
        option_type: scheme.optionType,
        amc_name: scheme.amcName,
      })
      .select('id')
      .single();
    if (created && !createErr) {
      instrumentIdByKey.set(key, created.id as string);
      const identifierRows: { instrument_id: string; identifier_scheme: string; identifier_value: string; country_code: string }[] = [];
      if (scheme.isin) identifierRows.push({ instrument_id: created.id as string, identifier_scheme: 'isin', identifier_value: scheme.isin, country_code: countryCode });
      if (scheme.amfiSchemeCode) identifierRows.push({ instrument_id: created.id as string, identifier_scheme: 'amfi_scheme_code', identifier_value: scheme.amfiSchemeCode, country_code: countryCode });
      if (identifierRows.length > 0) await admin.from('ii_instrument_identifiers').insert(identifierRows);
      await emitAuditEvent({ userId, eventType: 'instrument_resolved', subjectType: 'ii_instruments', subjectId: created.id as string, actorType: 'system', metadata: { matchedVia: 'created_provisional', scheme: scheme.rawSchemeName, parseRunId } });
    } else {
      instrumentUnresolvedKeys.add(key);
    }
  }

  // --- 5. Transaction normalisation + fingerprint dedup -------------------
  let duplicateTransactionsLinked = 0;
  const config = await loadActiveReconciliationConfig();

  for (const t of parsed.transactions) {
    const folioKey = t.folioNumber ?? '__no_folio__';
    const accountId = accountIdByFolio.get(folioKey);
    const instrumentId = instrumentIdByKey.get(schemeKey(t.scheme));
    if (!accountId || !instrumentId) continue; // account/instrument unresolved — already logged as a reconciliation case above; skip writing an orphaned transaction

    const fingerprint = computeTransactionFingerprint({
      sourceKey: parsed.metadata.sourceKey,
      accountId,
      instrumentId,
      transactionDateIso: t.transactionDateIso,
      transactionType: t.canonicalType,
      amountScaled: t.amountScaled,
      unitsScaled: t.unitsScaled,
      navScaled: t.navScaled,
      sourceReference: t.sourceReference,
    });

    const { data: existingTxn } = await admin.from('ii_transactions').select('id').eq('account_id', accountId).eq('transaction_fingerprint', fingerprint).maybeSingle();
    if (existingTxn) {
      await admin.from('ii_transaction_source_links').upsert(
        { user_id: userId, transaction_id: existingTxn.id, source_document_id: sourceDocumentId, parse_run_id: parseRunId, is_originating: false },
        { onConflict: 'transaction_id,source_document_id', ignoreDuplicates: true }
      );
      duplicateTransactionsLinked++;
      continue;
    }

    if (t.canonicalType === 'unclassified') {
      const material = t.amountScaled !== ZERO;
      const caseId = await openReconciliationCase(userId, {
        subjectType: 'account',
        subjectId: accountId,
        discrepancyType: 'transaction_unclassified',
        severity: material ? 'high' : 'low',
        sourceDocumentId,
        details: { description: t.rawTransactionTypeText, date: t.transactionDateIso, amount: scaledToDecimalString(t.amountScaled), material },
      });
      if (caseId) reconciliationCasesOpened++;
    }

    const { data: createdTxn, error: txnErr } = await admin
      .from('ii_transactions')
      .insert({
        user_id: userId,
        account_id: accountId,
        instrument_id: instrumentId,
        source_document_id: sourceDocumentId,
        currency_code: currencyCode,
        transaction_type: t.canonicalType,
        transaction_date: t.transactionDateIso,
        units: t.unitsScaled === null ? null : scaledToDecimalString(t.unitsScaled),
        price_per_unit: t.navScaled === null ? null : scaledToDecimalString(t.navScaled),
        gross_amount: scaledToDecimalString(t.amountScaled, 2),
        source_reference: t.sourceReference,
        parse_run_id: parseRunId,
        parser_code: parsed.parserCode,
        parser_version_used: parsed.parserVersion,
        source_description: t.sourceDescription,
        confidence: t.classificationConfidence,
        transaction_fingerprint: fingerprint,
      })
      .select('id')
      .single();
    if (createdTxn && !txnErr) {
      await admin.from('ii_transaction_source_links').insert({ user_id: userId, transaction_id: createdTxn.id, source_document_id: sourceDocumentId, parse_run_id: parseRunId, is_originating: true });
    }
  }

  // --- 6. Holding snapshots -------------------------------------------------
  for (const h of parsed.holdings) {
    const folioKey = h.folioNumber ?? '__no_folio__';
    const accountId = accountIdByFolio.get(folioKey);
    const instrumentId = instrumentIdByKey.get(schemeKey(h.scheme));
    if (!accountId || !instrumentId) continue;

    await admin
      .from('ii_holding_snapshots')
      .upsert(
        {
          user_id: userId,
          account_id: accountId,
          instrument_id: instrumentId,
          source_document_id: sourceDocumentId,
          currency_code: currencyCode,
          quality_status: 'warning', // upgraded to 'certified' once ii_portfolio_truth_status reaches certified/certified_with_warnings, below
          as_of_date: h.asOfDateIso,
          units: scaledToDecimalString(h.unitsScaled),
          value: h.valueScaled === null ? '0' : scaledToDecimalString(h.valueScaled, 2),
          parse_run_id: parseRunId,
          parser_code: parsed.parserCode,
          parser_version_used: parsed.parserVersion,
          source_nav: h.navScaled === null ? null : scaledToDecimalString(h.navScaled),
        },
        { onConflict: 'account_id,instrument_id,as_of_date', ignoreDuplicates: true }
      );
  }

  // --- 7. Reconciliation + certification, per position ----------------------
  for (const [key, instrumentId] of instrumentIdByKey) {
    void key;
    for (const [, accountId] of accountIdByFolio) {
      await evaluatePositionAndCertify(admin, userId, accountId, instrumentId, sourceDocumentId, config, ownerUnresolved, instrumentUnresolvedKeys.size > 0);
    }
  }

  // --- 8. Finalise document + run -------------------------------------------
  await admin
    .from('ii_source_documents')
    .update({
      status: 'parsed',
      parser_version: parsed.parserVersion,
      parse_completed_at: new Date().toISOString(),
      source_detected: detection.detection.sourceKey,
      source_confidence: detection.detection.confidence,
      document_type_detected: parsed.metadata.documentTypeDetected,
      format_version_detected: parsed.metadata.formatVersionDetected,
      extraction_method: extractionMethod,
      statement_period_start: parsed.metadata.statementPeriodStartIso,
      statement_period_end: parsed.metadata.statementPeriodEndIso,
      statement_as_of_date: parsed.metadata.statementAsOfDateIso,
    })
    .eq('id', sourceDocumentId);

  await admin
    .from('ii_document_parse_runs')
    .update({
      run_status: 'succeeded',
      completed_at: new Date().toISOString(),
      parser_code: parsed.parserCode,
      parser_version: parsed.parserVersion,
      source_detected: detection.detection.sourceKey,
      source_confidence: detection.detection.confidence,
      document_type_detected: parsed.metadata.documentTypeDetected,
      format_version_detected: parsed.metadata.formatVersionDetected,
      extraction_method: extractionMethod,
      accounts_found: accountIdByFolio.size,
      schemes_found: uniqueSchemes.size,
      transactions_found: parsed.transactions.length,
      holdings_found: parsed.holdings.length,
      warnings: parsed.warnings,
      errors: parsed.errors,
    })
    .eq('id', parseRunId);

  await emitAuditEvent({
    userId,
    eventType: 'parse_completed',
    subjectType: 'ii_source_documents',
    subjectId: sourceDocumentId,
    actorType: 'user',
    actorId: userId,
    metadata: { parseRunId, parserCode: parsed.parserCode, parserVersion: parsed.parserVersion, transactionsCreated: parsed.transactions.length, status: 'parsed' },
  });

  return {
    ok: true,
    status: 'parsed',
    parseRunId,
    summary: {
      sourceDetected: detection.detection.sourceKey,
      sourceConfidence: detection.detection.confidence,
      accountsFound: accountIdByFolio.size,
      schemesFound: uniqueSchemes.size,
      transactionsFound: parsed.transactions.length,
      holdingsFound: parsed.holdings.length,
      duplicateTransactionsLinked,
      reconciliationCasesOpened,
    },
    error: null,
  };
}

function schemeKey(s: ParsedInstrumentRecord): string {
  return `${s.normalisedSchemeName}|${s.planType}|${s.optionType}|${s.amcName}`;
}

async function failRun(admin: ReturnType<typeof createAdminClient>, parseRunId: string, message: string) {
  await admin.from('ii_document_parse_runs').update({ run_status: 'failed', completed_at: new Date().toISOString(), errors: [{ code: 'orchestration_error', message, severity: 'error' }] }).eq('id', parseRunId);
}

async function handleExtractionFailure(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  sourceDocumentId: string,
  parseRunId: string,
  kind: 'password_required' | 'wrong_password' | 'corrupt' | 'insufficient_text' | 'unknown_error',
  errorMessage: string
): Promise<ProcessSourceDocumentResult> {
  const statusByKind: Record<typeof kind, string> = {
    password_required: 'password_required',
    wrong_password: 'password_required',
    corrupt: 'parse_failed',
    insufficient_text: 'unsupported',
    unknown_error: 'parse_failed',
  };
  const discrepancyByKind: Record<typeof kind, string> = {
    password_required: 'document_password_required',
    wrong_password: 'document_password_required',
    corrupt: 'document_corrupt',
    insufficient_text: 'unsupported_document',
    unknown_error: 'document_corrupt',
  };
  const status = statusByKind[kind];
  await admin.from('ii_source_documents').update({ status, parse_error: null }).eq('id', sourceDocumentId); // NEVER store errorMessage verbatim if it could echo a password — it never does (see pdfExtraction.ts messages), but parse_error is left null here defensively for the password-shaped statuses
  await admin
    .from('ii_document_parse_runs')
    .update({
      run_status: 'failed',
      completed_at: new Date().toISOString(),
      password_required: kind === 'password_required' || kind === 'wrong_password',
      password_supplied: kind === 'wrong_password',
      errors: [{ code: kind, message: errorMessage, severity: 'error' }],
    })
    .eq('id', parseRunId);

  const caseId = await openReconciliationCase(userId, {
    subjectType: 'account',
    subjectId: sourceDocumentId,
    discrepancyType: discrepancyByKind[kind],
    severity: 'blocking',
    sourceDocumentId,
    // The password itself is NEVER included here (spec section 10,
    // critical failure condition list) — only the outcome kind.
    details: { kind },
  });

  await emitAuditEvent({
    userId,
    eventType: 'document_processing_failed',
    subjectType: 'ii_source_documents',
    subjectId: sourceDocumentId,
    actorType: 'system',
    // Deliberately NOT including errorMessage's raw text as a blanket
    // policy would risk future messages leaking something sensitive —
    // only the classified `kind` is audited, matching the "password must
    // NEVER appear" requirement with margin.
    metadata: { kind, parseRunId },
  });

  return { ok: false, status, parseRunId, error: errorMessage, reconciliationCaseId: caseId };
}

async function evaluatePositionAndCertify(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  accountId: string,
  instrumentId: string,
  sourceDocumentId: string,
  config: Awaited<ReturnType<typeof loadActiveReconciliationConfig>>,
  ownerUnresolved: boolean,
  anyInstrumentUnresolved: boolean
) {
  const { data: latestSnapshot } = await admin
    .from('ii_holding_snapshots')
    .select('*')
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .order('as_of_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestSnapshot) return; // no certified closing balance for this position yet — nothing to certify

  const { data: allTxns } = await admin
    .from('ii_transactions')
    .select('transaction_type, units, transaction_date')
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .lte('transaction_date', latestSnapshot.as_of_date as string)
    .order('transaction_date', { ascending: true });

  const { data: earlierSnapshot } = await admin
    .from('ii_holding_snapshots')
    .select('units, as_of_date')
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .lt('as_of_date', latestSnapshot.as_of_date as string)
    .order('as_of_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { parseExactDecimal } = await import('./decimal');
  const openingScaled = earlierSnapshot ? (parseExactDecimal(String(earlierSnapshot.units)).ok ? (parseExactDecimal(String(earlierSnapshot.units)) as { ok: true; scaled: bigint }).scaled : null) : null;

  const txnInputs: ReconciliationTransactionInput[] = (allTxns ?? [])
    .filter((t) => (earlierSnapshot ? (t.transaction_date as string) > (earlierSnapshot.as_of_date as string) : true))
    .map((t) => {
      const parsedUnits = t.units === null ? null : parseExactDecimal(String(t.units));
      return { canonicalType: t.transaction_type as ReconciliationTransactionInput['canonicalType'], unitsScaled: parsedUnits && parsedUnits.ok ? parsedUnits.scaled : null };
    });

  const historyCompleteness = determineHistoryCompleteness({
    hasExplicitOpeningBalanceTransaction: false,
    hasAnyTransactionHistory: txnInputs.length > 0,
    hasClosingHoldingSnapshot: true,
    statementCoversFromInception: !earlierSnapshot && txnInputs.length > 0,
  });

  const statementClosingParsed = parseExactDecimal(String(latestSnapshot.units));
  const statementClosingUnitsScaled = statementClosingParsed.ok ? statementClosingParsed.scaled : ZERO;

  const reconciliation = reconcilePosition({
    openingUnitsScaled: openingScaled,
    transactions: txnInputs,
    statementClosingUnitsScaled,
    historyCompleteness,
    config,
  });

  const { data: openBlockingCases } = await admin
    .from('ii_reconciliation_cases')
    .select('id, discrepancy_type, severity')
    .eq('user_id', userId)
    .eq('status', 'open')
    .in('severity', ['blocking', 'high'])
    .or(`subject_id.eq.${accountId},subject_id.eq.${sourceDocumentId}`);

  const asOfDate = latestSnapshot.as_of_date as string;
  const today = new Date().toISOString().slice(0, 10);
  const staleDays = isoDateDaysBetween(asOfDate, today);

  const certification = evaluateCertification({
    sourceDetected: true,
    parserFatalError: false,
    documentCorrupt: false,
    ownerUnresolved,
    instrumentUnresolved: anyInstrumentUnresolved,
    crossHouseholdConflict: false,
    invalidCanonicalRecord: false,
    hasOpenBlockingReconciliationCase: (openBlockingCases ?? []).length > 0,
    hasMaterialUnclassifiedTransaction: (openBlockingCases ?? []).some((c) => c.discrepancy_type === 'transaction_unclassified' && c.severity === 'high'),
    hasNonMaterialUnclassifiedTransaction: (openBlockingCases ?? []).some((c) => c.discrepancy_type === 'transaction_unclassified' && c.severity === 'low'),
    reconciliation,
    historyCompleteness,
    staleStatementDays: staleDays,
    staleThresholdDays: config.statementFreshnessWarningDays,
  });

  const nowIso = new Date().toISOString();
  await admin.from('ii_portfolio_truth_status').upsert(
    {
      user_id: userId,
      account_id: accountId,
      instrument_id: instrumentId,
      status: certification.status,
      history_completeness: historyCompleteness,
      latest_holding_snapshot_id: latestSnapshot.id,
      latest_source_document_id: sourceDocumentId,
      reconciled_opening_units: reconciliation.reconciledOpeningUnitsScaled === null ? null : scaledToDecimalString(reconciliation.reconciledOpeningUnitsScaled),
      reconciled_closing_units: reconciliation.reconciledClosingUnitsScaled === null ? null : scaledToDecimalString(reconciliation.reconciledClosingUnitsScaled),
      statement_closing_units: scaledToDecimalString(reconciliation.statementClosingUnitsScaled),
      unit_variance: reconciliation.unitVarianceScaled === null ? null : scaledToDecimalString(reconciliation.unitVarianceScaled),
      unit_variance_within_tolerance: reconciliation.withinTolerance,
      statement_freshness_days: staleDays,
      blocking_reasons: certification.blockingReasons,
      warning_reasons: certification.warningReasons,
      certified_at: certification.status === 'certified' || certification.status === 'certified_with_warnings' ? nowIso : null,
      last_evaluated_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: 'account_id,instrument_id' }
  );

  if (certification.status === 'certified') {
    await admin.from('ii_holding_snapshots').update({ quality_status: 'certified' }).eq('id', latestSnapshot.id);
    await emitAuditEvent({ userId, eventType: 'portfolio_certified', subjectType: 'ii_portfolio_truth_status', subjectId: `${accountId}:${instrumentId}`, actorType: 'system', metadata: { accountId, instrumentId, sourceDocumentId } });
  } else if (certification.status === 'certified_with_warnings') {
    await admin.from('ii_holding_snapshots').update({ quality_status: 'certified' }).eq('id', latestSnapshot.id);
    await emitAuditEvent({ userId, eventType: 'portfolio_certified_with_warnings', subjectType: 'ii_portfolio_truth_status', subjectId: `${accountId}:${instrumentId}`, actorType: 'system', metadata: { accountId, instrumentId, sourceDocumentId, warnings: certification.warningReasons } });
  } else if (certification.status === 'failed') {
    await emitAuditEvent({ userId, eventType: 'portfolio_failed', subjectType: 'ii_portfolio_truth_status', subjectId: `${accountId}:${instrumentId}`, actorType: 'system', metadata: { accountId, instrumentId, sourceDocumentId, blockers: certification.blockingReasons } });
  }
}
