// Module 11.5 test support — an in-memory stand-in for every database the
// contextual explanation path touches, plus the shared assertions the closure
// gates depend on.
//
// Deliberately NOT a mock of the service under test: the real
// AIContextualExplanationService, the real Module 11.4
// AIStandardQuestionService, the real Module 11.2 router and the real
// resolvers all execute against this. Only the Supabase clients and the
// session-scoped router dependency factory are substituted, so the logic being
// certified is the production logic.

import { vi } from 'vitest';

export interface HarnessState {
  /** Premium by default. Flip to prove the Free-user path. */
  eligible: boolean;
  /** The custom-question allowance. The quota gate asserts this NEVER moves. */
  customQuestionsUsed: number;
  customQuestionsAllowance: number;
  /** Platform switches. */
  aiGloballyEnabled: boolean;
  contextualExplanationsEnabled: boolean;
  liveProviderEnabled: boolean;
  /** ai_insights rows keyed by metric_code — the stored personalised source. */
  insightsByMetric: Map<string, Record<string, unknown>[]>;
  /** resource_posts glossary rows — the approved Knowledge Base source. */
  glossaryRows: Record<string, unknown>[];
  /** Latest ai_insight_packs status for the subject. */
  packStatus: string | null;
  /** reports rows the subject owns, keyed by report id. */
  reports: Map<string, { id: string; user_id: string; report_month: string; as_of_date: string; financial_snapshot_id: string | null }>;
  /** The household's CURRENT financial snapshot id. */
  currentSnapshotId: string | null;
  /** Every ai_resolution_audit row written. */
  auditRows: Record<string, unknown>[];
  /** Counts every admin-client RPC by name — proves no admission RPC is called. */
  rpcCalls: Map<string, number>;
  /** Counts every table read/write by table name — used by the performance benchmark. */
  tableOps: Map<string, number>;
}

/**
 * Approved glossary content for every Knowledge Base term the Module 11.5
 * contextual estate can compose. Shaped exactly as
 * lib/ai/resolution/knowledgeBaseResolver.ts's governance predicate expects
 * (status approved/published, non-red compliance, not scheduled, not expired).
 */
export function defaultGlossary(): Record<string, unknown>[] {
  const terms = [
    'net worth', 'cash flow', 'savings rate', 'emergency fund', 'financial health score',
    'financial dna', 'financial resilience', 'diversification', 'investment concentration',
    'financial goal', 'forecasting', 'financial twin', 'benchmark', 'reporting currency',
  ];
  return terms.map((term, i) => ({
    id: `glossary-${i}`,
    title: term,
    slug: term.replace(/\s+/g, '-'),
    excerpt: `${term} is an approved, compliance-reviewed FHIP glossary definition used verbatim.`,
    jurisdiction: 'global',
    status: 'approved',
    compliance_classification: 'green',
    compliance_approved_at: '2026-01-01T00:00:00.000Z',
    scheduled_at: null,
    expires_at: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    aliases: null,
  }));
}

export function freshState(overrides: Partial<HarnessState> = {}): HarnessState {
  return {
    eligible: true,
    customQuestionsUsed: 0,
    customQuestionsAllowance: 10,
    aiGloballyEnabled: true,
    contextualExplanationsEnabled: true,
    liveProviderEnabled: true,
    insightsByMetric: new Map(),
    glossaryRows: defaultGlossary(),
    packStatus: 'READY',
    reports: new Map(),
    currentSnapshotId: null,
    auditRows: [],
    rpcCalls: new Map(),
    tableOps: new Map(),
    ...overrides,
  };
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** A chainable PostgREST-ish builder that resolves to a fixed result. */
function chain(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'neq', 'in', 'not', 'lte', 'gte', 'order', 'limit', 'range']) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve(result);
  builder.single = () => Promise.resolve(result);
  builder.insert = () => Promise.resolve({ error: null });
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

/**
 * The service-role client stand-in. Note what is NOT here: no
 * `ai_admit_request`, no `ai_reserve_custom_question`, no
 * `ai_consume_custom_question` handler. If Module 11.5 ever called one, this
 * harness records the attempt in `rpcCalls` and the quota gate fails.
 */
export function makeAdminClient(state: HarnessState) {
  return {
    rpc(name: string) {
      bump(state.rpcCalls, name);
      if (name === 'ai_entitlement_state') {
        return Promise.resolve({
          data: {
            eligible: state.eligible,
            reason: state.eligible ? null : 'not_premium',
            billing_period: '2026-09',
            period_start: '2026-09-01',
            period_end: '2026-09-30',
            custom_questions: {
              allowance: state.customQuestionsAllowance,
              used: state.customQuestionsUsed,
              remaining: state.customQuestionsAllowance - state.customQuestionsUsed,
            },
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
    },
    from(table: string) {
      bump(state.tableOps, table);
      switch (table) {
        case 'ai_platform_controls':
          return chain({
            data: {
              id: 'global',
              ai_globally_enabled: state.aiGloballyEnabled,
              contextual_explanations_enabled: state.contextualExplanationsEnabled,
              live_provider_enabled: state.liveProviderEnabled,
              custom_ai_enabled: true,
              monthly_custom_question_allowance: state.customQuestionsAllowance,
            },
            error: null,
          });

        // Migrations 0124/0126 not applied in unit tests -> code defaults.
        case 'ai_standard_questions':
        case 'ai_contextual_explanation_targets':
          return chain({ data: null, error: { code: '42P01', message: 'not migrated' } });

        case 'ai_resolution_audit':
          return {
            insert: (row: Record<string, unknown>) => {
              state.auditRows.push(row);
              return Promise.resolve({ error: null });
            },
          };

        case 'ai_insight_packs':
          return chain({ data: state.packStatus ? { status: state.packStatus } : null, error: null });

        case 'ai_insights': {
          let metricCode: string | null = null;
          const b: Record<string, unknown> = {};
          for (const m of ['select', 'not', 'lte', 'order']) b[m] = () => b;
          b.eq = (col: string, val: string) => {
            if (col === 'metric_code') metricCode = val;
            return b;
          };
          b.limit = () => Promise.resolve({ data: metricCode ? state.insightsByMetric.get(metricCode) ?? [] : [], error: null });
          return b;
        }

        case 'resource_posts':
          return chain({ data: state.glossaryRows, error: null });

        default:
          return chain({ data: null, error: null });
      }
    },
  };
}

/**
 * The request-scoped (RLS-enforcing) client stand-in, used only by
 * loadReportBinding(). It models the two things that matter for the ownership
 * and snapshot gates: a report is visible ONLY to its owner, and the
 * household's current snapshot id is a separate lookup.
 */
export function makeServerClient(state: HarnessState, sessionUserId: string) {
  return {
    from(table: string) {
      bump(state.tableOps, table);
      if (table === 'reports') {
        const filters: Record<string, string> = {};
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = (col: string, val: string) => {
          filters[col] = val;
          return b;
        };
        b.order = () => b;
        b.limit = () => b;
        b.maybeSingle = () => {
          const row = state.reports.get(filters.id ?? '');
          // Both barriers modelled: the row must exist, must belong to the
          // explicitly-filtered user_id AND to the authenticated session.
          if (!row) return Promise.resolve({ data: null, error: null });
          if (filters.user_id && row.user_id !== filters.user_id) return Promise.resolve({ data: null, error: null });
          if (row.user_id !== sessionUserId) return Promise.resolve({ data: null, error: null });
          return Promise.resolve({ data: row, error: null });
        };
        return b;
      }
      if (table === 'financial_snapshots') {
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
        b.maybeSingle = () => Promise.resolve({ data: state.currentSnapshotId ? { id: state.currentSnapshotId } : null, error: null });
        return b;
      }
      return chain({ data: null, error: null });
    },
  };
}

/** Every stored-personalised block the contextual estate can draw on. */
export function seedStoredInsights(state: HarnessState, intentCodes: string[], currentValue: number | null = null) {
  for (const code of intentCodes) {
    state.insightsByMetric.set(code, [
      {
        metric_code: code,
        headline: `Stored headline for ${code}.`,
        summary: `Stored, grounded, already-validated explanation for ${code}. It was generated by Module 11.3 and validated then.`,
        key_points: [],
        limitations: [],
        confidence: 'HIGH',
        grounding_status: 'GROUNDED',
        current_value: currentValue,
        data_as_of: '2026-09-01',
        source_refs: [],
        valid_until: '2099-01-01',
      },
    ]);
  }
}

/** A fake RouterDependencies factory bound to a supplied context builder. */
export function makeRouterDependencyFactory(buildContext: () => unknown, country: 'AU' | 'IN' = 'AU', eligible = true) {
  return vi.fn(() => ({
    buildContext: vi.fn(async () => buildContext()),
    getUserCountry: vi.fn(async () => country),
    isPersonalisedAiEligible: vi.fn(async () => eligible),
  }));
}
