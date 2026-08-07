// Loads report_content_library (0025/0026 migrations) and exposes it
// through the same shape reportCopy.ts's constants/functions already have,
// so call sites in reportSections.ts / reportSectionsPremium.ts /
// ReportPreview.tsx change from "import a constant" to "call a method on
// source.content" with minimal churn. reportCopy.ts's original exports are
// kept as the fallback/default whenever a DB row is missing (deleted,
// deactivated, or this migration hasn't run yet) — report generation must
// never break because of a missing content row.
import { createClient } from '@/lib/supabase/server';
import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import * as fallback from '@/lib/engines/reportCopy';

interface ContentRow {
  content_key: string;
  content_type: 'fixed' | 'banded' | 'code_label';
  status_band: string | null;
  code_value: string | null;
  body_template: string;
}

export interface ReportContent {
  reportWhatItIs: string;
  reportWhyItExists: string;
  reportHowToRead: string;
  page1Disclaimer: string;
  fullDisclaimer: string;
  scoreGaugeExplanation: string;
  currencyName(code: 'AUD' | 'INR'): string;
  coreFigureDefinition(key: keyof typeof fallback.CORE_FIGURE_DEFINITIONS): string;
  cashflowDefinition(key: keyof typeof fallback.CASHFLOW_DEFINITIONS): string;
  netWorthDefinition(key: keyof typeof fallback.NET_WORTH_DEFINITIONS): string;
  dataQualityDefinition(key: keyof typeof fallback.DATA_QUALITY_DEFINITIONS): string;
  confidenceExplanation(level: 'high' | 'medium' | 'low', limitingArea: string | null): string;
  premiumAnalysisReadinessNote(unavailableAreas: string[]): string | null;
  categoryLabel(code: string): string;
}

export async function loadReportContent(locale = 'en', client?: SupabaseServerClient): Promise<ReportContent> {
  const supabase = client ?? (await createClient());
  const { data } = await supabase
    .from('report_content_library')
    .select('content_key, content_type, status_band, code_value, body_template')
    .eq('locale', locale)
    .eq('is_active', true);
  const rows = (data as ContentRow[]) ?? [];

  const fixedMap = new Map<string, string>();
  const bandedMap = new Map<string, string>(); // key: `${content_key}:${status_band}`
  const codeMap = new Map<string, string>(); // key: `${content_key}:${code_value}`
  for (const r of rows) {
    if (r.content_type === 'fixed') fixedMap.set(r.content_key, r.body_template);
    else if (r.content_type === 'banded' && r.status_band) bandedMap.set(`${r.content_key}:${r.status_band}`, r.body_template);
    else if (r.content_type === 'code_label' && r.code_value) codeMap.set(`${r.content_key}:${r.code_value}`, r.body_template);
  }

  const getFixed = (key: string, def: string) => fixedMap.get(key) ?? def;
  const getCode = (key: string, code: string, def: string) => codeMap.get(`${key}:${code}`) ?? def;
  const getBand = (key: string, band: string, def: string) => bandedMap.get(`${key}:${band}`) ?? def;

  return {
    reportWhatItIs: getFixed('report_what_it_is', fallback.REPORT_WHAT_IT_IS),
    reportWhyItExists: getFixed('report_why_it_exists', fallback.REPORT_WHY_IT_EXISTS),
    reportHowToRead: getFixed('report_how_to_read', fallback.REPORT_HOW_TO_READ),
    page1Disclaimer: getFixed('page1_disclaimer', fallback.PAGE1_DISCLAIMER),
    fullDisclaimer: getFixed('full_disclaimer', fallback.FULL_DISCLAIMER),
    scoreGaugeExplanation: getFixed('score_gauge_explanation', fallback.SCORE_GAUGE_EXPLANATION),
    currencyName: (code) => getCode('currency_name', code, fallback.CURRENCY_NAMES[code]),
    coreFigureDefinition: (key) => getCode('core_figure_definition', key, fallback.CORE_FIGURE_DEFINITIONS[key]),
    cashflowDefinition: (key) => getCode('cashflow_definition', key, fallback.CASHFLOW_DEFINITIONS[key]),
    netWorthDefinition: (key) => getCode('net_worth_definition', key, fallback.NET_WORTH_DEFINITIONS[key]),
    dataQualityDefinition: (key) => getCode('data_quality_definition', key, fallback.DATA_QUALITY_DEFINITIONS[key]),
    confidenceExplanation: (level, limitingArea) => {
      const template = getBand('confidence_explanation', level, '');
      if (!template) return fallback.confidenceExplanation(level, limitingArea);
      const area = limitingArea ?? (level === 'medium' ? 'some sections' : 'this report');
      return template.replace('{limitingArea}', area);
    },
    premiumAnalysisReadinessNote: (unavailableAreas) => {
      if (unavailableAreas.length === 0) return null;
      const template = getFixed('premium_analysis_readiness_note', '');
      if (!template) return fallback.premiumAnalysisReadinessNote(unavailableAreas);
      const verb = unavailableAreas.length === 1 ? 'is' : 'are';
      return template.replace('{unavailableAreas}', unavailableAreas.join(', ')).replace('{verb}', verb);
    },
    categoryLabel: (code) => codeMap.get(`category_label:${code}`) ?? fallback.categoryLabel(code),
  };
}
