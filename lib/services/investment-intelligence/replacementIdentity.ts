// Investment Intelligence -- is a replacement copy plausibly the SAME logical statement? (Document2 (4) closure, WP-H, F5/F6/F14)
//
// WP-B let a person attach a replacement copy to an old statement whose raw file was deleted by design. It checked the file type, the
// malware gate and that the same bytes were not on another statement, but NOT that the new file is the same statement: a copy for a
// different period, a different fund house or someone else's folios would have been attached to the old row, re-read, and its
// contents attributed to the old statement's owner. This module is the missing check. It is NOT byte identity (a re-downloaded copy
// of the same statement has different bytes); it compares the new copy with the structured provenance the old statement RETAINED
// after its file was deleted:
//
//   provider / source ........ ii_source_documents.source_detected
//   document type ............ ii_source_documents.document_type_detected
//   statement period / as-of . ii_source_documents.statement_period_start / _end / statement_as_of_date
//   account / folio .......... ii_accounts of the holdings and transactions written from that statement (+ fund house)
//   scheme context ........... ISINs of those instruments
//   owner .................... ii_source_documents.owner_member_id against the holder printed on the new copy
//
// The new copy is read with the SAME deterministic parsers the process route uses (pure, in memory, nothing is written), so what is
// compared is exactly what a reprocess would then write.
//
// THE RULES (every threshold is explicit; nothing is scored or fuzzy):
//   REJECT, no override (it is a different statement; upload it as a new one):
//     * the provider differs (for example a KFintech statement offered for a CAMS one);
//     * the document type differs (a consolidated statement offered for a folio statement);
//     * the periods do not overlap at all;
//     * none of the folios in the new copy is a folio of the old statement;
//     * the holder printed on the copy is, exactly, a DIFFERENT household member than the statement's owner (K.7: never re-filed);
//     * the copy cannot be read as a statement at all while the old one was recognised.
//   NEEDS EXPLICIT CONFIRMATION (the person must see the difference and confirm it, per difference):
//     * the periods overlap but their start or end differ by more than PERIOD_TOLERANCE_DAYS;
//     * only the as-of date can be compared and it differs by more than PERIOD_TOLERANCE_DAYS;
//     * the copy prints no period at all, so the period cannot be checked;
//     * some folios of the old statement are missing from the copy, or the copy adds folios;
//     * a shared folio is under a different fund house; no ISIN is shared by the two;
//     * the printed holder name does not match the statement's owner (names are noisy; never a hard stop, never silent);
//     * the old statement kept no record at all (it was never read): there is nothing to compare, so the person confirms what the
//       copy actually is before it is attached.
//   MATCH: nothing above applies. A signal that was not retained is listed as "not compared", never treated as a pass.
//
// WHY 3 DAYS. Statement bounds are calendar dates that registrars roll over weekends and holidays (a period "to 31/03" regenerated
// as "to 28/03" when the 29th to 31st are non-business days, or the as-of line one working day earlier). Three days absorbs that and
// nothing wider: a different month, quarter or financial year is always a different statement. Two statements that overlap but are
// not the same period are NOT rejected outright because a person may legitimately hold only an extended or a trimmed re-download of
// the statement; they are shown the difference and must confirm it.

import { createAdminClient } from '@/lib/supabase/admin';
import { extractPdfText, type PdfExtractionFailureKind } from './pdfExtraction';
import { parseExtractedDocument } from './parsers/registry';
import { normaliseFolioNumber, planFolioAccountResolution, UNKNOWN_AMC_SENTINEL } from './accountResolution';
import { fetchAllRows } from './pagination';
import { matchStatementOwner, type Pc5HouseholdMemberForMatching } from '@/lib/aie/adapters/investment-intelligence/ownerMatching';
import { collapseOwnerEvidence } from '@/lib/aie/adapters/investment-intelligence/householdContext';
import { formatDateShort } from '@/lib/engines/date';

export const PERIOD_TOLERANCE_DAYS = 3;

export type DifferenceSeverity = 'reject' | 'confirm';

export interface IdentityDifference {
  code: string;
  severity: DifferenceSeverity;
  /** Plain words, day-first dates. Says what differs. */
  message: string;
}

export interface RetainedFolio {
  /** normaliseFolioNumber() form: the comparison key. */
  folio: string;
  /** Fund houses the retained accounts for this folio carry. */
  institutions: string[];
}

export type RetainedOwner = { kind: 'member'; memberId: string } | { kind: 'not_a_single_member' } | { kind: 'none' };

export interface RetainedStatementIdentity {
  sourceKey: string | null;
  documentType: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  asOf: string | null;
  folios: RetainedFolio[];
  isins: string[];
  owner: RetainedOwner;
  currency: 'INR' | 'AUD';
}

export interface CandidateStatementIdentity {
  sourceKey: string;
  documentType: string;
  periodStart: string | null;
  periodEnd: string | null;
  asOf: string | null;
  folios: RetainedFolio[];
  isins: string[];
  holder: { holderName: string | null; jointHolders: string[]; holdingModeRaw: string | null };
  transactionCount: number;
  holdingCount: number;
}

export interface IdentityVerdict {
  decision: 'match' | 'needs_confirmation' | 'rejected';
  differences: IdentityDifference[];
  /** Signals that were actually compared, in plain words. */
  comparedOn: string[];
  /** Signals that could not be compared and why. Never counted as agreement. */
  notComparedOn: string[];
  /** One plain sentence on what the copy is (provider, period, folios), for the confirmation screen. */
  candidateSummary: string;
}

// ---------------------------------------------------------------------------
// Pure comparison
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<string, string> = { cams: 'CAMS', kfintech: 'KFintech' };
const providerLabel = (k: string) => PROVIDER_LABELS[k] ?? k;
const DOCUMENT_TYPE_LABELS: Record<string, string> = { cas_statement: 'consolidated account statement', cams_folio_details: 'folio statement' };
const documentTypeLabel = (t: string) => DOCUMENT_TYPE_LABELS[t] ?? t.replace(/_/g, ' ');

const DAY_MS = 86_400_000;
function dayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}
const absDays = (a: string, b: string): number | null => {
  const x = dayNumber(a);
  const y = dayNumber(b);
  return x === null || y === null ? null : Math.abs(x - y);
};

const normaliseInstitution = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Folio numbers are identifiers: show only the last four characters. */
const maskFolio = (f: string) => (f.length <= 4 ? f : `ending ${f.slice(-4)}`);
function folioList(folios: string[]): string {
  const shown = folios.slice(0, 4).map(maskFolio);
  return shown.join(', ') + (folios.length > 4 ? ` and ${folios.length - 4} more` : '');
}

function describePeriod(start: string | null, end: string | null, asOf: string | null, fmt: (d: string) => string): string | null {
  if (start && end) return `${fmt(start)} to ${fmt(end)}`;
  if (asOf) return `as at ${fmt(asOf)}`;
  return null;
}

export function describeCandidate(c: CandidateStatementIdentity, currency: 'INR' | 'AUD'): string {
  const fmt = (d: string) => formatDateShort(d, currency);
  const period = describePeriod(c.periodStart, c.periodEnd, c.asOf, fmt);
  const folios = c.folios.length === 0 ? 'no folio numbers' : c.folios.length === 1 ? `1 folio (${folioList(c.folios.map((f) => f.folio))})` : `${c.folios.length} folios (${folioList(c.folios.map((f) => f.folio))})`;
  return `This file is a ${providerLabel(c.sourceKey)} ${documentTypeLabel(c.documentType)}${period ? ` covering ${period}` : ' that does not print a statement period'}, with ${folios}.`;
}

export function compareStatementIdentity(
  retained: RetainedStatementIdentity,
  candidate: CandidateStatementIdentity,
  members: readonly Pc5HouseholdMemberForMatching[],
): IdentityVerdict {
  const fmt = (d: string) => formatDateShort(d, retained.currency);
  const differences: IdentityDifference[] = [];
  const comparedOn: string[] = [];
  const notComparedOn: string[] = [];
  const add = (d: IdentityDifference) => differences.push(d);

  // 1. Provider and document type.
  if (retained.sourceKey) {
    comparedOn.push('fund house or registrar (provider)');
    if (retained.sourceKey !== candidate.sourceKey) {
      add({
        code: 'provider_differs',
        severity: 'reject',
        message: `This copy is a ${providerLabel(candidate.sourceKey)} statement, but the statement it would replace is a ${providerLabel(retained.sourceKey)} statement. They are different statements, so this copy was not attached.`,
      });
    }
  } else notComparedOn.push('fund house or registrar (the old statement kept no record of it)');

  if (retained.documentType) {
    comparedOn.push('type of statement');
    if (retained.documentType !== candidate.documentType) {
      add({
        code: 'document_type_differs',
        severity: 'reject',
        message: `This copy is a ${documentTypeLabel(candidate.documentType)}, but the statement it would replace is a ${documentTypeLabel(retained.documentType)}. They are different kinds of statement, so this copy was not attached.`,
      });
    }
  } else notComparedOn.push('type of statement (the old statement kept no record of it)');

  // 2. Period. The statement period when both sides have one, otherwise the as-of date, otherwise nothing.
  const retainedPeriod = retained.periodStart && retained.periodEnd ? { start: retained.periodStart, end: retained.periodEnd } : null;
  const candidatePeriod = candidate.periodStart && candidate.periodEnd ? { start: candidate.periodStart, end: candidate.periodEnd } : null;
  if (retainedPeriod && candidatePeriod) {
    comparedOn.push('statement period');
    const startGap = absDays(retainedPeriod.start, candidatePeriod.start);
    const endGap = absDays(retainedPeriod.end, candidatePeriod.end);
    const retainedStart = dayNumber(retainedPeriod.start);
    const retainedEnd = dayNumber(retainedPeriod.end);
    const candidateStart = dayNumber(candidatePeriod.start);
    const candidateEnd = dayNumber(candidatePeriod.end);
    const overlaps = retainedStart !== null && retainedEnd !== null && candidateStart !== null && candidateEnd !== null && candidateStart <= retainedEnd && retainedStart <= candidateEnd;
    const theirs = `${fmt(retainedPeriod.start)} to ${fmt(retainedPeriod.end)}`;
    const ours = `${fmt(candidatePeriod.start)} to ${fmt(candidatePeriod.end)}`;
    if (!overlaps) {
      add({
        code: 'period_no_overlap',
        severity: 'reject',
        message: `This copy covers ${ours}, but the statement it would replace covers ${theirs}. The two periods do not overlap, so this is a different statement. Upload it as a new statement instead. Nothing was changed.`,
      });
    } else if ((startGap ?? Infinity) > PERIOD_TOLERANCE_DAYS || (endGap ?? Infinity) > PERIOD_TOLERANCE_DAYS) {
      add({
        code: 'period_differs',
        severity: 'confirm',
        message: `This copy covers ${ours}, but the statement it would replace covers ${theirs}. The periods overlap but are not the same.`,
      });
    }
  } else {
    // At least one side has no full period: compare the statement dates (a period statement's date is its period end).
    const retainedAsOf = retained.asOf ?? retainedPeriod?.end ?? null;
    const candidateAsOf = candidate.asOf ?? candidatePeriod?.end ?? null;
    if (retainedAsOf && candidateAsOf) {
      comparedOn.push('statement date');
      const gap = absDays(retainedAsOf, candidateAsOf);
      if ((gap ?? Infinity) > PERIOD_TOLERANCE_DAYS) {
        add({
          code: 'as_of_differs',
          severity: 'confirm',
          message: `This copy is dated ${fmt(candidateAsOf)}, but the statement it would replace is dated ${fmt(retainedAsOf)}.`,
        });
      }
    } else if (retainedAsOf && !candidateAsOf) {
      notComparedOn.push('statement period (this copy prints none)');
      add({
        code: 'period_missing_in_copy',
        severity: 'confirm',
        message: `The statement it would replace covers ${describePeriod(retained.periodStart, retained.periodEnd, retained.asOf, fmt)}, but this copy does not print a statement period or date, so the period cannot be checked.`,
      });
    } else {
      notComparedOn.push('statement period (the old statement kept no record of it)');
    }
  }

  // 3. Folios and fund houses.
  if (retained.folios.length > 0 && candidate.folios.length > 0) {
    comparedOn.push('folio numbers');
    const retainedKeys = new Set(retained.folios.map((f) => f.folio));
    const candidateKeys = new Set(candidate.folios.map((f) => f.folio));
    const shared = [...retainedKeys].filter((k) => candidateKeys.has(k));
    if (shared.length === 0) {
      add({
        code: 'no_common_folio',
        severity: 'reject',
        message: `None of the folios in this copy (${folioList([...candidateKeys])}) is a folio of the statement it would replace (${folioList([...retainedKeys])}). This is a different statement, so it was not attached.`,
      });
    } else {
      const missing = [...retainedKeys].filter((k) => !candidateKeys.has(k));
      const extra = [...candidateKeys].filter((k) => !retainedKeys.has(k));
      if (missing.length > 0 || extra.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`${missing.length === 1 ? 'a folio' : `${missing.length} folios`} of the old statement (${folioList(missing)}) ${missing.length === 1 ? 'is' : 'are'} not in this copy`);
        if (extra.length > 0) parts.push(`this copy has ${extra.length === 1 ? 'a folio' : `${extra.length} folios`} the old statement did not (${folioList(extra)})`);
        add({ code: 'folios_differ', severity: 'confirm', message: `The folios do not match exactly: ${parts.join(', and ')}.` });
      }
      // Same folio number under a different fund house is a different account (accountResolution keys on both).
      const mismatchedHouses: string[] = [];
      for (const key of shared) {
        const before = (retained.folios.find((f) => f.folio === key)?.institutions ?? []).filter((i) => i && i !== UNKNOWN_AMC_SENTINEL).map(normaliseInstitution);
        const now = (candidate.folios.find((f) => f.folio === key)?.institutions ?? []).filter((i) => i && i !== UNKNOWN_AMC_SENTINEL).map(normaliseInstitution);
        if (before.length > 0 && now.length > 0 && !now.some((n) => before.includes(n))) mismatchedHouses.push(key);
      }
      if (mismatchedHouses.length > 0) {
        add({
          code: 'institution_differs',
          severity: 'confirm',
          message: `${mismatchedHouses.length === 1 ? 'A folio' : `${mismatchedHouses.length} folios`} (${folioList(mismatchedHouses)}) ${mismatchedHouses.length === 1 ? 'is' : 'are'} under a different fund house in this copy than in the statement it would replace.`,
        });
      }
    }
  } else if (retained.folios.length === 0) {
    notComparedOn.push('folio numbers (the old statement kept no record of them)');
  } else {
    notComparedOn.push('folio numbers (this copy prints none)');
  }

  // 4. Scheme context (ISINs). Only a complete absence of overlap is a signal: statements add and drop schemes between dates.
  if (retained.isins.length > 0 && candidate.isins.length > 0) {
    comparedOn.push('schemes (ISIN)');
    const retainedIsins = new Set(retained.isins.map((i) => i.toUpperCase()));
    if (!candidate.isins.some((i) => retainedIsins.has(i.toUpperCase()))) {
      add({ code: 'schemes_differ', severity: 'confirm', message: 'None of the schemes in this copy is a scheme of the statement it would replace.' });
    }
  } else notComparedOn.push('schemes (ISIN not available on both sides)');

  // 5. Owner. Only a single declared household member can be compared with a printed holder name.
  if (retained.owner.kind === 'member') {
    const outcome = matchStatementOwner(candidate.holder, members);
    if (outcome.kind === 'no_owner_evidence') notComparedOn.push('owner (this copy prints no holder name)');
    else if (outcome.kind === 'joint_holding') notComparedOn.push('owner (this copy prints a joint holding; the usual joint-holding question is asked when it is read)');
    else {
      comparedOn.push('owner');
      if (outcome.kind === 'exact_match') {
        if (outcome.memberId !== retained.owner.memberId) {
          add({
            code: 'owner_belongs_to_other_member',
            severity: 'reject',
            message: `The holder printed on this copy (${outcome.maskedHolderName}) is a different household member from the owner of the statement it would replace. It was not attached. Upload it as a new statement for that person instead.`,
          });
        }
      } else {
        add({
          code: 'owner_name_differs',
          severity: 'confirm',
          message: `The holder printed on this copy (${outcome.maskedHolderName}) does not match the name of the statement's owner in your household.`,
        });
      }
    }
  } else notComparedOn.push(retained.owner.kind === 'none' ? 'owner (the old statement has no owner chosen)' : 'owner (the old statement is held jointly or by an entity)');

  // 6. Nothing retained to compare against at all.
  const hasAnyRetainedSignal = Boolean(retained.sourceKey || retained.documentType || retainedPeriod || retained.asOf || retained.folios.length > 0 || retained.isins.length > 0);
  if (!hasAnyRetainedSignal) {
    add({
      code: 'nothing_retained_to_compare',
      severity: 'confirm',
      message: 'The old statement was never read successfully, so there is no record of what it covered and this copy cannot be checked against it.',
    });
  }

  const candidateSummary = describeCandidate(candidate, retained.currency);
  const decision: IdentityVerdict['decision'] = differences.some((d) => d.severity === 'reject') ? 'rejected' : differences.length > 0 ? 'needs_confirmation' : 'match';
  return { decision, differences, comparedOn, notComparedOn, candidateSummary };
}

/** The set of confirmable differences that a request has not confirmed (empty = may proceed). Rejections are never confirmable. */
export function unconfirmedDifferences(verdict: IdentityVerdict, confirmedCodes: readonly string[]): IdentityDifference[] {
  if (verdict.decision === 'rejected') return verdict.differences.filter((d) => d.severity === 'reject');
  return verdict.differences.filter((d) => d.severity === 'confirm' && !confirmedCodes.includes(d.code));
}

// ---------------------------------------------------------------------------
// Reading the new copy (pure parsing, nothing is written)
// ---------------------------------------------------------------------------

export type CandidateReadResult =
  | { kind: 'ok'; identity: CandidateStatementIdentity }
  | { kind: 'password'; failure: Extract<PdfExtractionFailureKind, 'password_required' | 'wrong_password'> }
  | { kind: 'unreadable'; reason: 'corrupt' | 'insufficient_text' | 'unknown_error' | 'unrecognised_format' };

export async function readCandidateIdentity(input: { bytes: Uint8Array; mimeType: string; password?: string }): Promise<CandidateReadResult> {
  let text: string;
  if (input.mimeType === 'application/pdf') {
    // A COPY: the PDF library may take ownership of (detach) the buffer it is given. The caller still has to store these very bytes, and a
    // detached buffer would be stored empty. (Found by the PGlite oracle, which reads real PDFs: the mocked text layer hid it.)
    const extraction = await extractPdfText(new Uint8Array(input.bytes), input.password);
    if (!extraction.ok) {
      if (extraction.kind === 'password_required' || extraction.kind === 'wrong_password') return { kind: 'password', failure: extraction.kind };
      return { kind: 'unreadable', reason: extraction.kind };
    }
    text = extraction.text;
  } else {
    text = Buffer.from(input.bytes).toString('utf8');
  }
  const { detection, parsed } = parseExtractedDocument(text);
  if (!detection.parser || !parsed) return { kind: 'unreadable', reason: 'unrecognised_format' };

  const plan = planFolioAccountResolution({ accounts: parsed.accounts, transactions: parsed.transactions, holdings: parsed.holdings });
  const byFolio = new Map<string, Set<string>>();
  for (const a of plan.assignments) {
    const key = normaliseFolioNumber(a.folioNumber);
    if (!key) continue;
    const set = byFolio.get(key) ?? new Set<string>();
    if (a.amcName) set.add(a.amcName);
    byFolio.set(key, set);
  }
  const isins = new Set<string>();
  for (const s of [...parsed.transactions.map((t) => t.scheme), ...parsed.holdings.map((h) => h.scheme)]) if (s.isin) isins.add(s.isin.toUpperCase());

  return {
    kind: 'ok',
    identity: {
      sourceKey: parsed.metadata.sourceKey,
      documentType: parsed.metadata.documentTypeDetected,
      periodStart: parsed.metadata.statementPeriodStartIso,
      periodEnd: parsed.metadata.statementPeriodEndIso,
      asOf: parsed.metadata.statementAsOfDateIso,
      folios: [...byFolio.entries()].map(([folio, houses]) => ({ folio, institutions: [...houses] })),
      isins: [...isins],
      holder: collapseOwnerEvidence(parsed.accounts),
      transactionCount: parsed.transactions.length,
      holdingCount: parsed.holdings.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Reading what the old statement retained (read-only, tenant-scoped on every query)
// ---------------------------------------------------------------------------

type Admin = ReturnType<typeof createAdminClient>;
const chunk = <T,>(items: T[], size = 200): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export async function loadRetainedIdentity(admin: Admin, userId: string, doc: Record<string, unknown>): Promise<RetainedStatementIdentity> {
  const docId = doc.id as string;
  const currency: 'INR' | 'AUD' = doc.country_code === 'IN' ? 'INR' : 'AUD';

  // Accounts and instruments the statement's own rows reference (holdings, transactions, and the links that tie a re-confirmed
  // transaction to this statement without re-inserting it).
  const accountIds = new Set<string>();
  const instrumentIds = new Set<string>();
  const holdings = await fetchAllRows<{ id: string; account_id: string; instrument_id: string; as_of_date: string | null }>(() =>
    admin.from('ii_holding_snapshots').select('id, account_id, instrument_id, as_of_date').eq('user_id', userId).eq('source_document_id', docId).order('id', { ascending: true }),
  );
  for (const h of holdings) {
    accountIds.add(h.account_id);
    instrumentIds.add(h.instrument_id);
  }
  const ownTransactions = await fetchAllRows<{ id: string; account_id: string; instrument_id: string }>(() =>
    admin.from('ii_transactions').select('id, account_id, instrument_id').eq('user_id', userId).eq('source_document_id', docId).order('id', { ascending: true }),
  );
  for (const t of ownTransactions) {
    accountIds.add(t.account_id);
    instrumentIds.add(t.instrument_id);
  }
  const links = await fetchAllRows<{ id: string; transaction_id: string }>(() =>
    admin.from('ii_transaction_source_links').select('id, transaction_id').eq('user_id', userId).eq('source_document_id', docId).order('id', { ascending: true }),
  );
  const knownTxn = new Set(ownTransactions.map((t) => t.id));
  const linkedIds = links.map((l) => l.transaction_id).filter((id) => !knownTxn.has(id));
  for (const ids of chunk(linkedIds)) {
    const { data } = await admin.from('ii_transactions').select('id, account_id, instrument_id').eq('user_id', userId).in('id', ids);
    for (const t of (data ?? []) as { account_id: string; instrument_id: string }[]) {
      accountIds.add(t.account_id);
      instrumentIds.add(t.instrument_id);
    }
  }
  const { data: createdAccounts } = await admin.from('ii_accounts').select('id').eq('user_id', userId).eq('source_document_id', docId);
  for (const a of (createdAccounts ?? []) as { id: string }[]) accountIds.add(a.id);

  const foliosByKey = new Map<string, Set<string>>();
  for (const ids of chunk([...accountIds])) {
    const { data } = await admin.from('ii_accounts').select('id, folio_number, institution_name').eq('user_id', userId).in('id', ids);
    for (const a of (data ?? []) as { folio_number: string | null; institution_name: string | null }[]) {
      const key = normaliseFolioNumber(a.folio_number);
      if (!key) continue;
      const set = foliosByKey.get(key) ?? new Set<string>();
      if (a.institution_name) set.add(a.institution_name);
      foliosByKey.set(key, set);
    }
  }

  const isins = new Set<string>();
  for (const ids of chunk([...instrumentIds])) {
    const { data: instruments } = await admin.from('ii_instruments').select('id, isin').in('id', ids);
    for (const i of (instruments ?? []) as { isin: string | null }[]) if (i.isin) isins.add(i.isin.toUpperCase());
    const { data: identifiers } = await admin.from('ii_instrument_identifiers').select('instrument_id, identifier_value').eq('identifier_scheme', 'isin').in('instrument_id', ids);
    for (const i of (identifiers ?? []) as { identifier_value: string | null }[]) if (i.identifier_value) isins.add(i.identifier_value.toUpperCase());
  }

  // The as-of date: the statement's own, else the latest holding line it wrote.
  const holdingDates = holdings.map((h) => h.as_of_date).filter((d): d is string => Boolean(d)).sort();
  const asOf = ((doc.statement_as_of_date as string | null) ?? null) || (holdingDates.length > 0 ? holdingDates[holdingDates.length - 1] : null);

  const ownerMemberId = (doc.owner_member_id as string | null) ?? null;
  const hasEntityOwner = Boolean(doc.owner_business_entity_id) || doc.owner_role === 'joint' || Boolean(doc.owner_allocation);
  const owner: RetainedOwner = ownerMemberId && !hasEntityOwner ? { kind: 'member', memberId: ownerMemberId } : hasEntityOwner ? { kind: 'not_a_single_member' } : { kind: 'none' };

  return {
    sourceKey: ((doc.source_detected as string | null) ?? null) || null,
    documentType: ((doc.document_type_detected as string | null) ?? null) || null,
    periodStart: (doc.statement_period_start as string | null) ?? null,
    periodEnd: (doc.statement_period_end as string | null) ?? null,
    asOf,
    folios: [...foliosByKey.entries()].map(([folio, houses]) => ({ folio, institutions: [...houses] })),
    isins: [...isins],
    owner,
    currency,
  };
}

/** Household members for owner matching, READ ONLY (the matching loader elsewhere creates a Self member as a side effect; a check must not write). */
export async function loadMembersReadOnly(admin: Admin, userId: string): Promise<Pc5HouseholdMemberForMatching[]> {
  const { data } = await admin.from('household_members').select('id, full_name, relationship, is_active').eq('user_id', userId).order('created_at', { ascending: true });
  return ((data ?? []) as { id: string; full_name: string | null; relationship: string | null; is_active: boolean | null }[]).map((r) => ({
    id: r.id,
    fullName: r.full_name ?? '',
    relationship: r.relationship ?? 'other',
    isActive: r.is_active !== false,
  }));
}

/** What a rejected / unconfirmed copy that could not be READ at all means, given what the old statement retained. */
export function unreadableCopyVerdict(retained: RetainedStatementIdentity, reason: 'corrupt' | 'insufficient_text' | 'unknown_error' | 'unrecognised_format'): IdentityVerdict {
  const why =
    reason === 'insufficient_text'
      ? 'it has no readable text (it may be a scan or a picture)'
      : reason === 'corrupt'
        ? 'the file looks damaged'
        : reason === 'unrecognised_format'
          ? 'its layout is not one we can read as a CAMS or KFintech statement'
          : 'it could not be read';
  const recognised = Boolean(retained.sourceKey);
  const difference: IdentityDifference = recognised
    ? {
        code: 'unreadable_copy',
        severity: 'reject',
        message: `This file could not be checked against the statement it would replace because ${why}. That statement was read successfully before, so a file we cannot read cannot replace it. Nothing was changed.`,
      }
    : {
        code: 'unverifiable_copy',
        severity: 'confirm',
        message: `This file could not be checked against the statement it would replace because ${why}. The old statement was never read successfully either, so there is nothing to compare with.`,
      };
  return { decision: difference.severity === 'reject' ? 'rejected' : 'needs_confirmation', differences: [difference], comparedOn: [], notComparedOn: ['everything (the copy could not be read)'], candidateSummary: 'We could not read what this file contains.' };
}
