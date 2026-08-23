import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import { resolveReportSourceData, buildEligibilityInput, isEligibleForOfficialMonthlyReport } from '@/lib/services/reportSnapshotResolver';
import { buildReportSections, type BuiltSection } from '@/lib/engines/reportSections';

// II-R10 security hardening (migration 0070_ii_r10_reports_authoritative_write_hardening.sql):
// the `reports` table family now grants the `authenticated` role SELECT-own
// only — every insert/update/delete on reports/report_sections/
// report_snapshots/report_generation_runs must go through the service-role
// admin client. Authorization for every write below still comes from the
// caller-supplied userId, which every API route in app/api/reports/**
// derives from requireUser()'s validated session before calling into this
// module — never from unauthenticated input. Reads (listReports, getReport)
// deliberately stay on the RLS-scoped per-request client for
// defense-in-depth: a bug in the caller's own auth check would still be
// stopped by RLS on the read path.
function writeClient() {
  return createAdminClient();
}

const TEMPLATE_VERSION = 'report-1.0.0';
const DISCLAIMER_VERSION = 'disclaimer-1.0.0';

export type ReportTypeCode = 'monthly_financial_health' | 'financial_health_score' | 'goal_progress' | 'net_worth';

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function monthEnd(month: string): string {
  const d = new Date(month);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

function reportTitle(type: ReportTypeCode, month: string): string {
  const label = new Date(month).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  const typeTitles: Record<ReportTypeCode, string> = {
    monthly_financial_health: 'Monthly Financial Health Report',
    financial_health_score: 'Financial Health Score Report',
    goal_progress: 'Goal Progress Report',
    net_worth: 'Net Worth Report',
  };
  return `${typeTitles[type]} — ${label}`;
}

export interface ReportRow {
  id: string;
  user_id: string;
  report_type_code: ReportTypeCode;
  report_month: string;
  as_of_date: string;
  title: string;
  status: string;
  version_number: number;
  revises_report_id: string | null;
  reporting_currency: string;
  data_completeness_pct: number | null;
  generated_at: string | null;
  published_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
}

export interface GenerateReportResult {
  report: ReportRow;
  sections: BuiltSection[];
  alreadyExisted: boolean;
}

export interface GenerateReportParams {
  userId: string;
  reportType?: ReportTypeCode;
  reportMonth?: string;
  triggerType?: 'manual' | 'scheduled';
  reviseReportId?: string;
  revisionReason?: string;
  // Optional pre-built client (a service-role client for the scheduled job,
  // which has no per-request cookie session to build one from).
  client?: SupabaseServerClient;
}

// Orchestrates report generation end to end (spec section 12): resolves
// source snapshots, builds sections, checks eligibility, enforces
// idempotency for original (non-revision) reports, and writes an audit run.
export async function generateReport(params: GenerateReportParams): Promise<GenerateReportResult> {
  // Defaults to the service-role admin client now (II-R10 hardening) — the
  // scheduled cron job already always passed one explicitly (see
  // GenerateReportParams.client's original comment); manual/API-triggered
  // generation previously fell back to the per-request session client,
  // which is what let migration 0070's forgery gap exist in the first place
  // once combined with a permissive RLS policy. params.userId is always
  // caller-validated (every app/api/reports/** route derives it from
  // requireUser() before calling in), so trusting it here — the same way
  // the cron path always has — is safe.
  const supabase = params.client ?? createAdminClient();
  const reportType = params.reportType ?? 'monthly_financial_health';
  const reportMonth = params.reportMonth ?? monthStart();
  const triggerType = params.triggerType ?? 'manual';

  const { data: runRow } = await supabase
    .from('report_generation_runs')
    .insert({ user_id: params.userId, trigger_type: triggerType, output_status: 'started' })
    .select('id')
    .single();

  try {
    // Idempotency: an existing ready/published report for this user+type+month
    // is returned as-is rather than duplicated. This must match on ANY active
    // report for the period, not just an original (revises_report_id is null) —
    // otherwise a period whose active report is itself a revision (the normal
    // state after /revise) would fail to be recognised as already generated,
    // producing a second, independent report lineage for the same period.
    if (!params.reviseReportId) {
      const { data: existing } = await supabase
        .from('reports')
        .select('*')
        .eq('user_id', params.userId)
        .eq('report_type_code', reportType)
        .eq('report_month', reportMonth)
        .in('status', ['ready', 'published'])
        .maybeSingle();
      if (existing) {
        await finishRun(supabase, runRow?.id, existing.id, 'already_exists');
        const { data: sections } = await supabase.from('report_sections').select('*').eq('report_id', existing.id).order('display_order');
        return { report: existing as ReportRow, sections: (sections ?? []).map(fromSectionRow), alreadyExisted: true };
      }
    }

    const source = await resolveReportSourceData(params.userId, reportMonth, supabase);
    const eligibilityInput = buildEligibilityInput(source);

    if (reportType === 'monthly_financial_health') {
      const official = isEligibleForOfficialMonthlyReport(eligibilityInput);
      if (!official.eligible) {
        const { data: failedReport } = await supabase
          .from('reports')
          .insert({
            user_id: params.userId,
            report_type_code: reportType,
            report_period_start: reportMonth,
            report_period_end: monthEnd(reportMonth),
            report_month: reportMonth,
            as_of_date: source.asOfDate,
            title: reportTitle(reportType, reportMonth),
            status: 'failed',
            reporting_currency: source.currency,
            template_version: TEMPLATE_VERSION,
            disclaimer_version: DISCLAIMER_VERSION,
            failure_code: 'not_eligible',
            failure_message: official.reason,
          })
          .select('*')
          .single();
        await finishRun(supabase, runRow?.id, failedReport?.id, 'failed');
        return { report: failedReport as ReportRow, sections: [], alreadyExisted: false };
      }
    }

    // Determine if this is genuinely the user's first reporting period, not
    // just the first row — a /revise call inserts a new row and marks the
    // previous one 'superseded', so counting all rows would flip a
    // household's very first month out of "first report" status every time
    // that same month's report is revised, with no real prior-period
    // comparison behind it. Count distinct earlier report_months instead.
    const { data: earlierMonths } = await supabase
      .from('reports')
      .select('report_month')
      .eq('user_id', params.userId)
      .eq('report_type_code', reportType)
      .in('status', ['ready', 'published', 'superseded'])
      .lt('report_month', reportMonth)
      .limit(1);
    const isFirstReport = (earlierMonths?.length ?? 0) === 0;

    const sections = buildReportSections(source, eligibilityInput, isFirstReport);
    const dataQuality = sections.find((s) => s.sectionCode === 'data_quality');
    const dataCompletenessPct = (dataQuality?.sectionData.dataCompletenessPct as number) ?? null;

    let revisesReportId: string | null = null;
    let versionNumber = 1;
    if (params.reviseReportId) {
      const { data: original } = await supabase.from('reports').select('*').eq('id', params.reviseReportId).eq('user_id', params.userId).single();
      if (!original) throw new Error('Original report not found');
      revisesReportId = original.id;
      versionNumber = original.version_number + 1;
    }

    const { data: report, error: reportError } = await supabase
      .from('reports')
      .insert({
        user_id: params.userId,
        report_type_code: reportType,
        report_period_start: reportMonth,
        report_period_end: monthEnd(reportMonth),
        report_month: reportMonth,
        as_of_date: source.asOfDate,
        title: reportTitle(reportType, reportMonth),
        status: 'ready',
        version_number: versionNumber,
        revises_report_id: revisesReportId,
        revision_reason: params.revisionReason ?? null,
        reporting_currency: source.currency,
        country_scope: 'household',
        financial_snapshot_id: null,
        health_score_snapshot_id: null,
        resilience_snapshot_id: null,
        dna_snapshot_id: null,
        financial_twin_id: source.financialTwin?.id ?? null,
        template_version: TEMPLATE_VERSION,
        disclaimer_version: DISCLAIMER_VERSION,
        data_completeness_pct: dataCompletenessPct,
        generated_at: new Date().toISOString(),
      })
      .select('*')
      .single();
    if (reportError || !report) throw new Error(reportError?.message ?? 'Could not create report');

    await supabase.from('report_sections').insert(
      sections.map((s) => ({
        report_id: report.id,
        user_id: params.userId,
        section_code: s.sectionCode,
        section_title: s.sectionTitle,
        display_order: s.displayOrder,
        section_status: s.sectionStatus,
        section_data_json: s.sectionData,
        narrative_text: s.narrativeText,
        chart_data_json: s.chartData,
        source_references_json: s.sourceReferences,
        confidence_level: s.confidenceLevel,
        limitation_text: s.limitationText,
      }))
    );

    await supabase.from('report_snapshots').insert([
      {
        report_id: report.id,
        user_id: params.userId,
        snapshot_type: 'financial',
        source_version: 'dashboard-1.0.0',
        source_as_of_date: source.asOfDate,
        snapshot_metadata_json: { reportMonth },
      },
      ...(source.healthScore
        ? [
            {
              report_id: report.id,
              user_id: params.userId,
              snapshot_type: 'score',
              source_version: source.healthScore.modelVersion,
              source_as_of_date: source.asOfDate,
            },
          ]
        : []),
      ...(source.resilience
        ? [
            {
              report_id: report.id,
              user_id: params.userId,
              snapshot_type: 'resilience',
              source_version: source.resilience.modelVersion,
              source_as_of_date: source.asOfDate,
            },
          ]
        : []),
      ...(source.dna
        ? [
            {
              report_id: report.id,
              user_id: params.userId,
              snapshot_type: 'dna',
              source_version: source.dna.modelVersion,
              source_as_of_date: source.asOfDate,
            },
          ]
        : []),
    ]);

    if (revisesReportId) {
      await supabase.from('reports').update({ status: 'superseded' }).eq('id', revisesReportId);
    }

    await finishRun(supabase, runRow?.id, report.id, 'succeeded');
    return { report: report as ReportRow, sections, alreadyExisted: false };
  } catch (e) {
    await finishRun(supabase, runRow?.id, null, 'failed', e instanceof Error ? e.message : 'Unknown error');
    throw e;
  }
}

async function finishRun(
  supabase: Awaited<ReturnType<typeof createClient>>,
  runId: string | undefined,
  reportId: string | null | undefined,
  status: string,
  failureDetails?: string
) {
  if (!runId) return;
  await supabase
    .from('report_generation_runs')
    .update({ report_id: reportId ?? null, completed_at: new Date().toISOString(), output_status: status, failure_details: failureDetails ?? null })
    .eq('id', runId);
}

export function fromSectionRow(row: Record<string, unknown>): BuiltSection {
  return {
    sectionCode: row.section_code as BuiltSection['sectionCode'],
    sectionTitle: row.section_title as string,
    displayOrder: row.display_order as number,
    sectionStatus: row.section_status as BuiltSection['sectionStatus'],
    sectionData: (row.section_data_json as Record<string, unknown>) ?? {},
    narrativeText: (row.narrative_text as string) ?? null,
    chartData: (row.chart_data_json as Record<string, unknown>) ?? null,
    sourceReferences: (row.source_references_json as Record<string, unknown>) ?? {},
    confidenceLevel: (row.confidence_level as string) ?? null,
    limitationText: (row.limitation_text as string) ?? null,
  };
}

export async function listReports(userId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'archived')
    .order('report_month', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as ReportRow[];
}

export async function getReport(userId: string, reportId: string) {
  const supabase = await createClient();
  const { data: report, error } = await supabase.from('reports').select('*').eq('id', reportId).eq('user_id', userId).single();
  if (error || !report) return null;
  const { data: sections } = await supabase.from('report_sections').select('*').eq('report_id', reportId).order('display_order');
  return { report: report as ReportRow, sections: (sections ?? []).map(fromSectionRow) };
}

// For the headless PDF renderer's print route, which has no user session to
// authenticate with — authorizes via a short-lived render_token instead (see
// lib/services/reportPdfRenderer.ts). Uses the service-role client since
// there's no auth.uid() to satisfy RLS; the token match against this exact
// report_id IS the authorization check.
export async function getReportByRenderToken(reportId: string, token: string) {
  const { createAdminClient } = await import('@/lib/supabase/admin');
  const admin = createAdminClient();
  const { data: matchingExport } = await admin
    .from('report_exports')
    .select('report_id, render_token_expires_at')
    .eq('report_id', reportId)
    .eq('render_token', token)
    .maybeSingle();
  if (!matchingExport) return null;
  if (!matchingExport.render_token_expires_at || new Date(matchingExport.render_token_expires_at as string) < new Date()) return null;

  const { data: report, error } = await admin.from('reports').select('*').eq('id', reportId).single();
  if (error || !report) return null;
  const { data: sections } = await admin.from('report_sections').select('*').eq('report_id', reportId).order('display_order');
  return { report: report as ReportRow, sections: (sections ?? []).map(fromSectionRow) };
}

export async function publishReport(userId: string, reportId: string) {
  const supabase = writeClient();
  const { data, error } = await supabase
    .from('reports')
    .update({ status: 'published', published_at: new Date().toISOString() })
    .eq('id', reportId)
    .eq('user_id', userId)
    .eq('status', 'ready')
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as ReportRow;
}

export async function archiveReport(userId: string, reportId: string) {
  const supabase = writeClient();
  const { data, error } = await supabase
    .from('reports')
    .update({ status: 'archived' })
    .eq('id', reportId)
    .eq('user_id', userId)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as ReportRow;
}

export async function recordAccessEvent(userId: string, reportId: string, eventType: 'viewed' | 'printed' | 'exported' | 'downloaded') {
  const supabase = writeClient();
  await supabase.from('report_access_events').insert({ report_id: reportId, user_id: userId, event_type: eventType });
}
