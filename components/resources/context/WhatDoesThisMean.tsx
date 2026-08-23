// R1.6 — spec §59: reusable "What does this mean?" component for ordinary
// server-rendered authenticated FHIP pages (Score, Resilience, Forecasting,
// Goals). Accepts a contextKey, not a Resource ID (spec §59's own example:
// `<WhatDoesThisMean contextKey="dashboard.savings_rate" />`) — the mapping
// layer resolves the Resource, the caller never hands this component a
// slug/id directly.
//
// Async Server Component: creates its own request-scoped Supabase client
// (same helper every other server-rendered Resources surface uses — never
// service-role, spec §63 "Even inside authenticated FHIP: mapped Resources
// must satisfy normal public visibility"). For the one call site that lives
// inside an existing 'use client' tree (Dashboard), use
// resolveContextResources() + <WhatDoesThisMeanLink> directly instead — see
// that component's header comment.

import { createClient } from '@/lib/supabase/server';
import { resolveContextResource } from '@/lib/resources/context/queries';
import { getContextDefinition } from '@/lib/resources/context/registry';
import { WhatDoesThisMeanLink } from './WhatDoesThisMeanLink';

export async function WhatDoesThisMean({ contextKey, compact = true }: { contextKey: string; compact?: boolean }) {
  const def = getContextDefinition(contextKey);
  if (!def) return null; // spec §58/§96 — an unregistered key renders nothing rather than throwing in a live FHIP page
  const supabase = await createClient();
  const resolved = await resolveContextResource(supabase, contextKey);
  return <WhatDoesThisMeanLink resolved={resolved} metricLabel={def.label} compact={compact} />;
}
