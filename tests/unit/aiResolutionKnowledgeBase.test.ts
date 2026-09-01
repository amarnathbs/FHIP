// Module 11.2 — KnowledgeBaseAnswerResolver unit tests (spec sections 21-26,
// 65-67, 81-82, 104).
//
// The Supabase admin client is replaced by a minimal in-memory double over
// `resource_posts` rows — real governance predicate logic
// (status/compliance/scheduling/expiry) runs against it exactly as it would
// against Postgres; only the transport is faked.

import { describe, it, expect, vi } from 'vitest';

interface Row {
  id: string;
  title: string;
  slug: string | null;
  excerpt: string | null;
  jurisdiction: string;
  status: string;
  compliance_classification: string;
  compliance_approved_at: string | null;
  scheduled_at: string | null;
  expires_at: string | null;
  updated_at: string;
  aliases: string[] | null;
}

let rows: Row[] = [];

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table !== 'resource_posts') throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        in(_col: string, statuses: string[]) {
          this._filtered = rows.filter((r) => statuses.includes(r.status));
          return this;
        },
        _filtered: [] as Row[],
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          return Promise.resolve(resolve({ data: this._filtered, error: null }));
        },
      };
    },
  }),
}));

const { resolveKnowledgeBase } = await import('@/lib/ai/resolution/knowledgeBaseResolver');

function row(overrides: Partial<Row>): Row {
  return {
    id: 'id-1',
    title: 'Net Worth',
    slug: 'net-worth',
    excerpt: 'Net worth is assets minus liabilities.',
    jurisdiction: 'global',
    status: 'approved',
    compliance_classification: 'green',
    compliance_approved_at: null,
    scheduled_at: null,
    expires_at: null,
    updated_at: '2026-08-01T00:00:00.000Z',
    aliases: null,
    ...overrides,
  };
}

describe('resolveKnowledgeBase', () => {
  it('returns an approved global glossary term with zero personalised context needed (spec section 104)', async () => {
    rows = [row({})];
    const attempt = await resolveKnowledgeBase({ intentCode: 'NET_WORTH_DEFINITION', userCountry: null });
    expect(attempt.hit).toBe(true);
    expect(attempt.answer!.resolution_type).toBe('KNOWLEDGE_BASE');
    expect(attempt.answer!.requires_live_ai).toBe(false);
    expect(attempt.answer!.consumes_custom_quota).toBe(false);
  });

  it('excludes DRAFT content (spec section 81)', async () => {
    rows = [row({ status: 'draft' })];
    const attempt = await resolveKnowledgeBase({ intentCode: 'NET_WORTH_DEFINITION', userCountry: null });
    expect(attempt.hit).toBe(false);
    expect(attempt.miss_reason).toBe('KNOWLEDGE_NOT_AVAILABLE');
  });

  it('excludes RETIRED/archived content (spec section 81)', async () => {
    rows = [row({ status: 'archived' })];
    const attempt = await resolveKnowledgeBase({ intentCode: 'NET_WORTH_DEFINITION', userCountry: null });
    expect(attempt.hit).toBe(false);
  });

  it('excludes a future-effective (scheduled) item (spec section 81)', async () => {
    rows = [row({ scheduled_at: '2099-01-01T00:00:00.000Z' })];
    const attempt = await resolveKnowledgeBase({ intentCode: 'NET_WORTH_DEFINITION', userCountry: null });
    expect(attempt.hit).toBe(false);
  });

  it('excludes an expired item', async () => {
    rows = [row({ expires_at: '2020-01-01T00:00:00.000Z' })];
    const attempt = await resolveKnowledgeBase({ intentCode: 'NET_WORTH_DEFINITION', userCountry: null });
    expect(attempt.hit).toBe(false);
  });

  it('excludes RED compliance content unconditionally', async () => {
    rows = [row({ compliance_classification: 'red' })];
    const attempt = await resolveKnowledgeBase({ intentCode: 'NET_WORTH_DEFINITION', userCountry: null });
    expect(attempt.hit).toBe(false);
  });

  it('excludes AMBER compliance content without a recorded compliance approval', async () => {
    rows = [row({ compliance_classification: 'amber', compliance_approved_at: null })];
    const attempt = await resolveKnowledgeBase({ intentCode: 'NET_WORTH_DEFINITION', userCountry: null });
    expect(attempt.hit).toBe(false);
  });

  it('serves AMBER compliance content once compliance-approved', async () => {
    rows = [row({ compliance_classification: 'amber', compliance_approved_at: '2026-07-01T00:00:00.000Z' })];
    const attempt = await resolveKnowledgeBase({ intentCode: 'NET_WORTH_DEFINITION', userCountry: null });
    expect(attempt.hit).toBe(true);
  });

  // -------------------------------------------------------------------
  // Country-aware knowledge (spec sections 25, 82, 104).
  // -------------------------------------------------------------------
  it('serves India-correct content for NPS to an India-home user with no limitation', async () => {
    rows = [row({ title: 'NPS', jurisdiction: 'india' })];
    const attempt = await resolveKnowledgeBase({ intentCode: 'NPS_DEFINITION', userCountry: 'IN' });
    expect(attempt.hit).toBe(true);
    expect(attempt.answer!.limitations).toHaveLength(0);
  });

  it('still answers an explicit superannuation question for an India-home user, but labels it as an Australian concept (spec section 82)', async () => {
    rows = [row({ title: 'Superannuation', jurisdiction: 'australia' })];
    const attempt = await resolveKnowledgeBase({ intentCode: 'SUPERANNUATION_DEFINITION', userCountry: 'IN' });
    expect(attempt.hit).toBe(true);
    expect(attempt.answer!.limitations.some((l) => /australian/i.test(l))).toBe(true);
  });

  it('does not attach a country limitation for an AU-home user asking about superannuation', async () => {
    rows = [row({ title: 'Superannuation', jurisdiction: 'australia' })];
    const attempt = await resolveKnowledgeBase({ intentCode: 'SUPERANNUATION_DEFINITION', userCountry: 'AU' });
    expect(attempt.hit).toBe(true);
    expect(attempt.answer!.limitations).toHaveLength(0);
  });

  it('reports KNOWLEDGE_NOT_AVAILABLE for a concept with no approved content (content gap)', async () => {
    rows = [];
    const attempt = await resolveKnowledgeBase({ intentCode: 'FINANCIAL_TWIN_DEFINITION', userCountry: 'AU' });
    expect(attempt.hit).toBe(false);
    expect(attempt.miss_reason).toBe('KNOWLEDGE_NOT_AVAILABLE');
  });

  it('matches via an alias when the exact title does not match', async () => {
    rows = [row({ title: 'Debt Service Ratio', aliases: ['debt-service ratio', 'dsr'] })];
    const attempt = await resolveKnowledgeBase({ intentCode: 'DEBT_SERVICE_RATIO_DEFINITION', userCountry: null });
    expect(attempt.hit).toBe(true);
  });
});
