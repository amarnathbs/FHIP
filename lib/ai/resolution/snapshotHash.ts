// Module 11.2 — snapshot-hash derivation for stored/cached personalised
// answers (spec sections 29-30, 80).
//
// A stored or cached answer is only reusable while the underlying certified
// facts it was generated from have not changed. This hashes exactly the
// domain section(s) an intent depends on (never the whole context object —
// an unrelated domain changing must not invalidate an answer that never
// read it) plus each certified domain's own `data_as_of`, so both a value
// change AND a re-certification with the same numbers but a new "as of"
// date invalidate a stale hash.

import { createHash } from 'node:crypto';
import type { ContextDomain, FinancialContextObject } from '@/lib/ai/context/types';

export function computeSnapshotHash(ctx: FinancialContextObject, domains: ContextDomain[]): string {
  const sortedDomains = [...domains].sort();
  const payload = sortedDomains.map((d) => ({
    domain: d,
    certification: ctx.domain_certification[d],
    section: (ctx as unknown as Record<ContextDomain, unknown>)[d],
  }));
  const canonical = JSON.stringify(payload);
  return createHash('sha256').update(canonical).digest('hex');
}
