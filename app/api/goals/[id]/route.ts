import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { goalSchema } from '@/lib/validation/goal';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase.from('user_goals').select('*').eq('id', id).eq('user_id', user.id).single();
  return error ? bad(error.message) : ok(data);
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = goalSchema.partial().safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('user_goals')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();
  return error ? bad(error.message) : ok(data);
}

// LR-7 WP-07 — genuine permanent delete, gated on the goal being truly
// unused. Before this phase, DELETE was byte-identical to the archive
// route (a soft status flip) regardless of any dependency — not unsafe
// (no data was ever destroyed), but it did not deliver the "permanent
// delete" capability the spec asks for, and gave no signal at all about
// whether a goal actually had history. Checks funding-source links
// (active OR inactive — a since-unlinked source is still real history),
// contribution history (any status — a reversed contribution is still a
// past event) and persisted forecast snapshots (forecast_results rows
// keyed by this goal, entity_type='goal'). Milestones alone do not block a
// delete — an empty milestone list a user set up and abandoned is not
// "meaningful history" in the same sense as real money movement or a
// funding link, so a goal with only unmet milestones can still be
// permanently removed (its milestones cascade-delete with it, matching
// migration 0009's own on-delete-cascade FKs). Fails closed with a
// specific, itemised reason otherwise — never a silent partial delete.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();

  const { data: goal, error: findError } = await supabase.from('user_goals').select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (findError) return bad(findError.message);
  if (!goal) return bad('Goal not found', 404);

  const [fundingSourcesResult, contributionsResult, forecastSnapshotsResult] = await Promise.all([
    supabase.from('goal_funding_sources').select('id', { count: 'exact', head: true }).eq('goal_id', id).eq('user_id', user.id),
    supabase.from('goal_contributions').select('id', { count: 'exact', head: true }).eq('goal_id', id).eq('user_id', user.id),
    supabase.from('forecast_results').select('id', { count: 'exact', head: true }).eq('entity_id', id).eq('entity_type', 'goal').eq('user_id', user.id),
  ]);
  if (fundingSourcesResult.error) return bad(fundingSourcesResult.error.message);
  if (contributionsResult.error) return bad(contributionsResult.error.message);
  if (forecastSnapshotsResult.error) return bad(forecastSnapshotsResult.error.message);

  const blockers: string[] = [];
  if ((fundingSourcesResult.count ?? 0) > 0) blockers.push(`${fundingSourcesResult.count} funding source${fundingSourcesResult.count === 1 ? '' : 's'}`);
  if ((contributionsResult.count ?? 0) > 0) blockers.push(`${contributionsResult.count} contribution${contributionsResult.count === 1 ? '' : 's'}`);
  if ((forecastSnapshotsResult.count ?? 0) > 0) blockers.push('saved forecast history');

  if (blockers.length > 0) {
    return bad(
      `This goal can't be permanently deleted because it has ${blockers.join(' and ')}. Archive it instead, or remove those first.`,
      409
    );
  }

  const { error: deleteError } = await supabase.from('user_goals').delete().eq('id', id).eq('user_id', user.id);
  return deleteError ? bad(deleteError.message) : ok({ deleted: true });
}
