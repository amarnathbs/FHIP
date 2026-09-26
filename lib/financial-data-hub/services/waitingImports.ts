/**
 * Statement imports waiting for the user (2026-09-25).
 *
 * Every statement panel lost its place the moment it was closed or the page
 * reloaded: an AI reading awaiting confirmation, statement evidence awaiting
 * approval, or an approved statement whose comparison was never applied could
 * not be reached again from the screen -- nothing listed them, and
 * re-uploading the file only reached the duplicate guard. The payslip panel
 * fixed this for payslips by listing its waiting proposals; this is the same
 * idea for the statement types, one function so the panels cannot drift.
 *
 * READ ONLY, through the caller's own RLS-scoped client (every table read here
 * has an owner-read policy), and always filtered by `user_id` as well.
 */

import { createClient } from '@/lib/supabase/server';
import type { DraftDocumentType } from './aiFallbackDrafts';

export type WaitingImportKind = 'liability' | 'retirement' | 'investment' | 'bank' | 'payslip';

/** Where the user left off. */
export type WaitingImportStage =
  /** An AI reading of the statement awaits the user's check; nothing is saved yet. */
  | 'ai_draft'
  /** Statement evidence was saved and awaits the user's approval. */
  | 'review'
  /** Approved, and the comparison with the user's records was never decided. */
  | 'compare'
  /** Approved, with lines not yet applied (investment statements). */
  | 'apply';

export interface WaitingImport {
  document_id: string;
  stage: WaitingImportStage;
  document_type: string | null;
  country_code: string | null;
  currency_code: string | null;
  uploaded_at: string | null;
  /** Institution / fund name, when known. */
  label: string | null;
  period_end: string | null;
  /** The AI reading itself, for `ai_draft` items, so the panel can show it
   * again without reading the file (it may already have been purged). */
  ai_fallback_draft?: unknown;
}

const DRAFT_TYPE: Record<WaitingImportKind, DraftDocumentType> = {
  liability: 'liability_statement',
  retirement: 'retirement_statement',
  investment: 'investment_statement',
  bank: 'bank_statement',
  payslip: 'payslip',
};

/** Upload states a document can hold while its draft still awaits review --
 * a draft on a rejected or failed upload can no longer be confirmed. */
const DRAFT_UPLOAD_STATES = ['queued', 'uploaded', 'processing'];

const MAX_ITEMS = 10;

type Client = Awaited<ReturnType<typeof createClient>>;

interface UploadRow {
  id: string;
  document_type: string | null;
  country_code: string | null;
  currency_code: string | null;
  processing_status: string;
  created_at: string | null;
}

async function uploadsById(supabase: Client, userId: string, ids: string[]): Promise<Map<string, UploadRow>> {
  if (ids.length === 0) return new Map();
  const { data } = await supabase
    .from('fdh_statement_uploads')
    .select('id, document_type, country_code, currency_code, processing_status, created_at')
    .eq('user_id', userId)
    .in('id', ids);
  return new Map(((data ?? []) as UploadRow[]).map((u) => [u.id, u]));
}

function draftLabel(kind: WaitingImportKind, payload: unknown): { label: string | null; periodEnd: string | null } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const header = (p.header ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  switch (kind) {
    case 'liability':
      return { label: str(header.institutionName), periodEnd: str(header.statementPeriodEnd) };
    case 'retirement':
      return { label: str(p.fundName), periodEnd: str(p.statementEndDate) };
    case 'payslip':
      return { label: str(p.employerName), periodEnd: str(p.payPeriodEnd) };
    default:
      return { label: str(p.institutionName), periodEnd: str(p.statementPeriodEnd) };
  }
}

async function waitingDrafts(supabase: Client, userId: string, kind: WaitingImportKind): Promise<WaitingImport[]> {
  const { data, error } = await supabase
    .from('fdh_ai_fallback_drafts')
    .select('statement_upload_id, payload, created_at')
    .eq('user_id', userId)
    .eq('document_type', DRAFT_TYPE[kind])
    .eq('status', 'pending_review')
    .order('created_at', { ascending: false })
    .limit(MAX_ITEMS);
  // 0197 not applied, or any read error: nothing to resume (never an error screen).
  if (error) return [];
  const drafts = (data ?? []) as Array<{ statement_upload_id: string; payload: unknown; created_at: string }>;
  const uploads = await uploadsById(supabase, userId, drafts.map((d) => d.statement_upload_id));
  return drafts
    .filter((d) => DRAFT_UPLOAD_STATES.includes(uploads.get(d.statement_upload_id)?.processing_status ?? ''))
    .map((d) => {
      const u = uploads.get(d.statement_upload_id)!;
      const { label, periodEnd } = draftLabel(kind, d.payload);
      return {
        document_id: d.statement_upload_id,
        stage: 'ai_draft' as const,
        document_type: u.document_type,
        country_code: u.country_code,
        currency_code: u.currency_code,
        uploaded_at: u.created_at,
        label,
        period_end: periodEnd,
        ai_fallback_draft: d.payload,
      };
    });
}

/** Statement ids (from the given set) whose import proposal was decided --
 * applied, or dismissed by "keep my existing" -- and so are finished. */
async function decidedStatementIds(supabase: Client, userId: string, sourceColumn: string, statementIds: string[]): Promise<Set<string>> {
  if (statementIds.length === 0) return new Set();
  const { data } = await supabase
    .from('fhip_import_proposals')
    .select(sourceColumn)
    .eq('user_id', userId)
    .in(sourceColumn, statementIds)
    .in('status', ['applied', 'dismissed']);
  return new Set(((data ?? []) as unknown as Array<Record<string, string>>).map((r) => r[sourceColumn]));
}

interface StatementRow {
  id: string;
  statement_upload_id: string | null;
  approval_status: string;
  label: string | null;
  period_end: string | null;
}

async function waitingEvidence(supabase: Client, userId: string, kind: Exclude<WaitingImportKind, 'bank' | 'payslip'>): Promise<WaitingImport[]> {
  let rows: StatementRow[] = [];
  if (kind === 'liability') {
    const { data } = await supabase
      .from('fdh_liability_statements')
      .select('id, statement_upload_id, approval_status, institution_name, statement_period_end')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string, statement_upload_id: r.statement_upload_id as string | null, approval_status: r.approval_status as string,
      label: (r.institution_name as string | null) ?? null, period_end: (r.statement_period_end as string | null) ?? null,
    }));
  } else if (kind === 'retirement') {
    const { data } = await supabase
      .from('fdh_retirement_statements')
      .select('id, statement_upload_id, approval_status, fund_name, statement_end_date, smsf_classification')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    rows = ((data ?? []) as Array<Record<string, unknown>>)
      // An SMSF statement is routed to the SMSF section and can never be
      // approved here, so it is not "waiting" in this panel.
      .filter((r) => r.smsf_classification === 'not_smsf')
      .map((r) => ({
        id: r.id as string, statement_upload_id: r.statement_upload_id as string | null, approval_status: r.approval_status as string,
        label: (r.fund_name as string | null) ?? null, period_end: (r.statement_end_date as string | null) ?? null,
      }));
  } else {
    const { data } = await supabase
      .from('fdh_investment_statements')
      .select('id, statement_upload_id, approval_status, institution_name, statement_end_date')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string, statement_upload_id: r.statement_upload_id as string | null, approval_status: r.approval_status as string,
      label: (r.institution_name as string | null) ?? null, period_end: (r.statement_end_date as string | null) ?? null,
    }));
  }
  rows = rows.filter((r) => r.statement_upload_id);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  let finished: Set<string>;
  const pendingApply = new Set<string>();
  if (kind === 'investment') {
    // Applied line by line: an approved statement is finished once no line is
    // still pending.
    const [acts, pos] = await Promise.all([
      supabase.from('fdh_investment_statement_activities').select('statement_id').eq('user_id', userId).in('statement_id', ids).eq('apply_status', 'pending'),
      supabase.from('fdh_investment_statement_positions').select('statement_id').eq('user_id', userId).in('statement_id', ids).eq('apply_status', 'pending'),
    ]);
    for (const r of [...((acts.data ?? []) as Array<{ statement_id: string }>), ...((pos.data ?? []) as Array<{ statement_id: string }>)]) pendingApply.add(r.statement_id);
    finished = new Set(rows.filter((r) => r.approval_status === 'approved' && !pendingApply.has(r.id)).map((r) => r.id));
  } else {
    finished = await decidedStatementIds(supabase, userId, kind === 'liability' ? 'source_liability_statement_id' : 'source_retirement_statement_id', ids);
  }

  const waiting = rows.filter((r) => !finished.has(r.id)).slice(0, MAX_ITEMS);
  const uploads = await uploadsById(supabase, userId, waiting.map((r) => r.statement_upload_id!));
  return waiting.map((r) => {
    const u = uploads.get(r.statement_upload_id!);
    const stage: WaitingImportStage = r.approval_status !== 'approved' ? 'review' : kind === 'investment' ? 'apply' : 'compare';
    return {
      document_id: r.statement_upload_id!,
      stage,
      document_type: u?.document_type ?? null,
      country_code: u?.country_code ?? null,
      currency_code: u?.currency_code ?? null,
      uploaded_at: u?.created_at ?? null,
      label: r.label,
      period_end: r.period_end,
    };
  });
}

/**
 * WP-09 (GAP-11): payslips left part-way. Before this only a 'ready' proposal
 * could be resumed (GET /income-proposals), so a payslip that was read but
 * never approved -- or approved but never compared -- was stranded: a
 * re-upload only reached the duplicate guard. Stages:
 *   review   payroll evidence saved, not yet approved;
 *   compare  approved, and never applied to Income or dismissed.
 * A superseded (revised) payslip is not waiting; its revision is.
 */
async function waitingPayslips(supabase: Client, userId: string): Promise<WaitingImport[]> {
  const { data, error } = await supabase
    .from('fdh_payroll_events')
    .select('id, statement_upload_id, approval_status, employer_name, pay_period_end, currency_code, country_code, created_at')
    .eq('user_id', userId)
    .is('superseded_by_payroll_event_id', null)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return [];
  const events = ((data ?? []) as Array<{ id: string; statement_upload_id: string | null; approval_status: string; employer_name: string | null; pay_period_end: string | null; currency_code: string | null; country_code: string | null; created_at: string | null }>)
    .filter((e) => e.statement_upload_id);
  if (events.length === 0) return [];
  const ids = events.map((e) => e.id);
  const [decided, applied] = await Promise.all([
    decidedStatementIds(supabase, userId, 'source_payroll_event_id', ids),
    supabase.from('fhip_import_applications').select('source_payroll_event_id').eq('user_id', userId).eq('target_domain', 'income').in('source_payroll_event_id', ids),
  ]);
  const done = new Set<string>([...decided, ...((applied.data ?? []) as Array<{ source_payroll_event_id: string }>).map((r) => r.source_payroll_event_id)]);
  const waiting = events.filter((e) => !done.has(e.id)).slice(0, MAX_ITEMS);
  const uploads = await uploadsById(supabase, userId, waiting.map((e) => e.statement_upload_id!));
  return waiting.map((e) => {
    const u = uploads.get(e.statement_upload_id!);
    return {
      document_id: e.statement_upload_id!,
      stage: e.approval_status === 'approved' ? ('compare' as const) : ('review' as const),
      document_type: u?.document_type ?? 'payslip',
      country_code: u?.country_code ?? e.country_code,
      currency_code: u?.currency_code ?? e.currency_code,
      uploaded_at: u?.created_at ?? e.created_at,
      label: e.employer_name,
      period_end: e.pay_period_end,
    };
  });
}

/** Everything of this kind the user left part-way through, newest first:
 * AI readings awaiting a check, then saved statements awaiting a decision.
 * Bank statements list only AI readings -- their saved transactions are
 * reviewed on the dedicated review page, which already lists them. */
export async function listWaitingImports(userId: string, kind: WaitingImportKind): Promise<WaitingImport[]> {
  const supabase = await createClient();
  const drafts = await waitingDrafts(supabase, userId, kind);
  if (kind === 'bank') return drafts;
  if (kind === 'payslip') return [...drafts, ...(await waitingPayslips(supabase, userId))];
  const evidence = await waitingEvidence(supabase, userId, kind);
  return [...drafts, ...evidence];
}
