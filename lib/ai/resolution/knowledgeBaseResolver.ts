// Module 11.2 — KnowledgeBaseAnswerResolver (spec sections 21-26, 65-67, 82).
//
// Reuses the EXISTING Resources / Financial Knowledge Hub content
// infrastructure (`resource_posts`, content_type='glossary') rather than
// building a parallel knowledge base (spec section 23). No new content table
// is created; this file is exactly the "narrow mapping/index layer" spec
// section 23 anticipates — intent code -> canonical term(s) -> one governed
// query against the existing table.
//
// GOVERNANCE (spec section 22). The Resources module's PUBLIC-facing
// visibility gate (`visibility='public' AND published_at<=now()`) is a
// marketing-site rendering concern, not a compliance-approval concept, and at
// the time this was written almost no glossary content had been flipped
// public yet even though most of it is fully compliance-approved (see
// docs/resources/... R1.7D closure report). This resolver therefore applies
// its OWN governance predicate, built from the compliance/workflow columns
// directly: `status IN ('approved','published')`, never 'red' compliance,
// 'amber' only with a recorded compliance approval, not scheduled in the
// future, not expired. It deliberately does NOT gate on `visibility` — an
// AI answer citing already-compliance-approved content is not the same
// question as "should this appear on the public marketing site today". It
// reads via the service-role client for exactly this reason (the public RLS
// policy would hide this content) and returns ONLY backend-auditable
// metadata plus the approved text — never a raw row to the caller.

import { createAdminClient } from '@/lib/supabase/admin';
import type { CountryCode } from '@/lib/services/jurisdiction';
import { getIntentDefinition } from '@/lib/ai/resolution/intentTaxonomy';
import type { ResolvedAnswerEnvelope, ResolverAttempt } from '@/lib/ai/resolution/types';

export const KB_RESOLVER_VERSION = 'kb-resolver-1.0.0';

type ResourceJurisdiction = 'global' | 'australia' | 'india' | 'australia_india_cross_border';

interface KnowledgeTermMapping {
  /** Exact glossary title to match (case-insensitive). */
  term: string;
  /** Alternate terms/aliases to also try if the exact title match misses. */
  aliases?: string[];
  /** Jurisdiction the term is inherently scoped to, if any. */
  jurisdiction?: ResourceJurisdiction;
}

// Spec section 65's initial catalogue. One entry per KNOWLEDGE_INTENTS code
// in lib/ai/resolution/intentTaxonomy.ts.
const TERM_MAP: Record<string, KnowledgeTermMapping> = {
  NET_WORTH_DEFINITION: { term: 'net worth' },
  CASH_FLOW_DEFINITION: { term: 'cash flow' },
  SAVINGS_RATE_DEFINITION: { term: 'savings rate' },
  DEBT_TO_INCOME_DEFINITION: { term: 'debt-to-income ratio', aliases: ['debt to income', 'debt-to-income'] },
  DEBT_SERVICE_RATIO_DEFINITION: { term: 'debt service ratio', aliases: ['debt-service ratio'] },
  EMERGENCY_FUND_DEFINITION: { term: 'emergency fund' },
  FINANCIAL_HEALTH_SCORE_DEFINITION: { term: 'financial health score' },
  FINANCIAL_DNA_DEFINITION: { term: 'financial dna' },
  FINANCIAL_RESILIENCE_DEFINITION: { term: 'financial resilience' },
  DIVERSIFICATION_DEFINITION: { term: 'diversification' },
  INVESTMENT_CONCENTRATION_DEFINITION: { term: 'investment concentration', aliases: ['asset concentration'] },
  FINANCIAL_GOAL_DEFINITION: { term: 'financial goal' },
  FORECASTING_DEFINITION: { term: 'forecasting', aliases: ['financial forecast'] },
  FINANCIAL_TWIN_DEFINITION: { term: 'financial twin' },
  BENCHMARK_DEFINITION: { term: 'benchmark' },
  REPORTING_CURRENCY_DEFINITION: { term: 'reporting currency' },
  CROSS_BORDER_EXPOSURE_DEFINITION: { term: 'cross-border currency exposure', aliases: ['cross border currency exposure'] },
  SUPERANNUATION_DEFINITION: { term: 'superannuation', jurisdiction: 'australia' },
  SMSF_DEFINITION: { term: 'smsf', jurisdiction: 'australia' },
  EPF_DEFINITION: { term: 'epf', jurisdiction: 'india' },
  PPF_DEFINITION: { term: 'ppf', jurisdiction: 'india' },
  NPS_DEFINITION: { term: 'nps', jurisdiction: 'india' },
};

interface GlossaryRow {
  id: string;
  title: string;
  slug: string | null;
  excerpt: string | null;
  jurisdiction: ResourceJurisdiction;
  status: string;
  compliance_classification: string;
  compliance_approved_at: string | null;
  scheduled_at: string | null;
  expires_at: string | null;
  updated_at: string;
  aliases: string[] | null;
}

function isGovernanceApproved(row: GlossaryRow, nowIso: string): boolean {
  if (!['approved', 'published'].includes(row.status)) return false;
  if (row.compliance_classification === 'red') return false;
  if (row.compliance_classification === 'amber' && !row.compliance_approved_at) return false;
  if (row.scheduled_at && row.scheduled_at > nowIso) return false;
  if (row.expires_at && row.expires_at <= nowIso) return false;
  return true;
}

function countryToResourceJurisdictions(country: CountryCode | null): ResourceJurisdiction[] {
  // Only used to decide whether a LIMITATION note is needed (spec section
  // 82) — never to withhold an explicitly-requested term (spec section 26:
  // an explicit term question is answered regardless of home country).
  if (country === 'AU') return ['global', 'australia'];
  if (country === 'IN') return ['global', 'india'];
  return ['global'];
}

async function findApprovedGlossaryRow(mapping: KnowledgeTermMapping): Promise<GlossaryRow | null> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const candidates = [mapping.term, ...(mapping.aliases ?? [])];

  const { data, error } = await admin
    .from('resource_posts')
    .select('id, title, slug, excerpt, jurisdiction, status, compliance_classification, compliance_approved_at, scheduled_at, expires_at, updated_at, aliases')
    .eq('content_type', 'glossary')
    .in('status', ['approved', 'published']);
  if (error || !data) return null;

  const rows = data as GlossaryRow[];
  const lowerCandidates = candidates.map((c) => c.toLowerCase());

  // Prefer an exact title match; fall back to an alias match.
  const titleMatch = rows.find((r) => lowerCandidates.includes(r.title.trim().toLowerCase()));
  const chosen = titleMatch ?? rows.find((r) => (r.aliases ?? []).some((a) => lowerCandidates.includes(a.trim().toLowerCase())));

  if (!chosen || !isGovernanceApproved(chosen, nowIso)) return null;
  return chosen;
}

function envelope(intentCode: string, row: GlossaryRow, limitations: string[]): ResolvedAnswerEnvelope {
  return {
    resolution_type: 'KNOWLEDGE_BASE',
    intent_code: intentCode,
    answer_type: 'knowledge_answer',
    headline: row.title,
    summary: row.excerpt ?? '',
    key_points: [],
    source_refs: [{ source_type: 'knowledge_article', source_id: row.id, model_version: null, data_as_of: row.updated_at }],
    confidence: 'HIGH',
    data_as_of: row.updated_at,
    limitations,
    related_module: 'resources',
    action_route: row.slug ? `/resources/${row.slug}` : null,
    requires_live_ai: false,
    consumes_custom_quota: false,
    template_version: `${KB_RESOLVER_VERSION}/glossary`,
  };
}

export interface KnowledgeResolveInput {
  intentCode: string;
  userCountry: CountryCode | null;
}

export async function resolveKnowledgeBase(input: KnowledgeResolveInput): Promise<ResolverAttempt> {
  const def = getIntentDefinition(input.intentCode);
  if (!def || !def.allowed_resolvers.includes('KNOWLEDGE_BASE')) {
    return { resolver: 'KNOWLEDGE_BASE', hit: false, answer: null, miss_reason: 'intent_not_knowledge_base' };
  }

  const mapping = TERM_MAP[input.intentCode];
  if (!mapping) return { resolver: 'KNOWLEDGE_BASE', hit: false, answer: null, miss_reason: 'no_term_mapping_registered' };

  let row: GlossaryRow | null;
  try {
    row = await findApprovedGlossaryRow(mapping);
  } catch {
    // A knowledge-source read failure must never fabricate content (spec
    // section 76) — treat exactly like "no approved content found".
    return { resolver: 'KNOWLEDGE_BASE', hit: false, answer: null, miss_reason: 'knowledge_source_read_failed' };
  }

  if (!row) return { resolver: 'KNOWLEDGE_BASE', hit: false, answer: null, miss_reason: 'KNOWLEDGE_NOT_AVAILABLE' };

  const limitations: string[] = [];
  if (row.jurisdiction !== 'global' && row.jurisdiction !== 'australia_india_cross_border') {
    const allowed = countryToResourceJurisdictions(input.userCountry);
    if (!allowed.includes(row.jurisdiction)) {
      const label = row.jurisdiction === 'australia' ? 'an Australian' : 'an Indian';
      limitations.push(`This is ${label} financial concept and may not apply directly in your own country.`);
    }
  }

  return { resolver: 'KNOWLEDGE_BASE', hit: true, answer: envelope(input.intentCode, row, limitations), miss_reason: null };
}
