import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';
import type { IiAccountType, IiInstrumentClass, IiPublicationTarget } from './types';

// R0_NET_WORTH_DEDUP_CONTRACT.md section 1, point 2 — single-target-per-
// position routing decided once at publish time from instrument
// classification (NPS/PPF/EPF-classified always -> retirement_accounts; a
// mutual-fund/share/ETF-classified instrument always -> investments; a
// term/fixed deposit always -> assets, scenario 7). Pure function, unit
// tested per R1_IMPLEMENTATION_SPEC.md section 13 ("publication target
// routing"). NPS has no distinct instrument_class value in the R0-frozen
// enum (see migration 0038's comment) — retirement routing is decided from
// the ACCOUNT's account_type='retirement' instead, which already exists
// today and requires no schema change.
export function computePublicationTarget(
  instrumentClass: IiInstrumentClass,
  accountType: IiAccountType
): IiPublicationTarget {
  if (accountType === 'retirement') return 'retirement_accounts';
  if (instrumentClass === 'fixed_deposit' || instrumentClass === 'cash') return 'assets';
  return 'investments';
}

// STRUCTURAL ONLY (spec section 33 / acceptance checklist "no active FHIP
// publication implemented"): this creates/updates the ii_fhip_publications
// row that RECORDS a publish decision, but deliberately never inserts or
// updates a row in assets/investments/retirement_accounts. published_row_id
// stays null for every R1-created row — there is no live financial value
// flow from Investment Intelligence into existing FHIP totals in this
// release. Wiring the actual cross-register INSERT/UPDATE is explicit R2+
// scope (R1_ACCEPTANCE_REPORT.md "Exact prerequisites for R2").
export async function publishPositionStructural(input: {
  userId: string;
  canonicalPositionId: string; // ii_holding_snapshots.id
  publicationTarget: IiPublicationTarget;
  includeInNetWorth?: boolean;
}): Promise<{ publicationId: string | null; error: string | null }> {
  const admin = createAdminClient();

  // ADR-004's dedup guarantee: never a second publication row for the same
  // snapshot. Look for an existing row first (update-in-place semantics).
  const { data: existing } = await admin
    .from('ii_fhip_publications')
    .select('id')
    .eq('canonical_position_id', input.canonicalPositionId)
    .maybeSingle();

  if (existing) {
    const { error } = await admin
      .from('ii_fhip_publications')
      .update({ last_republished_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) return { publicationId: null, error: error.message };
    await emitAuditEvent({
      userId: input.userId,
      eventType: 'republishing',
      subjectType: 'ii_fhip_publications',
      subjectId: existing.id as string,
      actorType: 'user',
      metadata: { previousSnapshotId: input.canonicalPositionId, newSnapshotId: input.canonicalPositionId },
    });
    return { publicationId: existing.id as string, error: null };
  }

  const { data: created, error } = await admin
    .from('ii_fhip_publications')
    .insert({
      user_id: input.userId,
      canonical_position_id: input.canonicalPositionId,
      publication_target: input.publicationTarget,
      published_row_id: null, // structural only — see module comment above
      status: 'published',
      include_in_net_worth: input.includeInNetWorth ?? true,
    })
    .select('id')
    .single();
  if (error || !created) return { publicationId: null, error: error?.message ?? 'Publication failed' };

  await emitAuditEvent({
    userId: input.userId,
    eventType: 'publication',
    subjectType: 'ii_fhip_publications',
    subjectId: created.id as string,
    actorType: 'user',
    metadata: { canonicalPositionId: input.canonicalPositionId, publicationTarget: input.publicationTarget, publishedRowId: null },
  });
  return { publicationId: created.id as string, error: null };
}
