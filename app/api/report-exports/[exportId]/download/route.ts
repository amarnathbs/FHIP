import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser, bad } from '@/lib/api';

// Returns a short-lived signed Storage URL for a ready PDF export and
// records the download. Redirects (302) rather than returning JSON so a
// plain <a href> download link works without client-side fetch/blob handling.
export async function GET(_req: Request, { params }: { params: Promise<{ exportId: string }> }) {
  const { exportId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data } = await supabase
    .from('report_exports')
    .select('id, report_id, status, storage_path, expires_at, download_count')
    .eq('id', exportId)
    .eq('requested_by_user_id', user.id)
    .single();
  if (!data) return bad('Export not found', 404);
  if (data.status !== 'ready' || !data.storage_path) {
    return bad('This export is not ready for download yet.', 409);
  }
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return bad('This export has expired. Request a new export.', 410);
  }

  const admin = createAdminClient();
  const { data: signed, error: signError } = await admin.storage.from('report-exports').createSignedUrl(data.storage_path, 60);
  if (signError || !signed) return bad(signError?.message ?? 'Could not generate a download link', 500);

  // II-R10 hardening (migration 0070): report_exports/report_access_events
  // grant the authenticated role SELECT-own only now — both writes below
  // must go through the admin client. Ownership of exportId was already
  // confirmed by the .eq('requested_by_user_id', user.id) read above.
  await admin
    .from('report_exports')
    .update({ download_count: data.download_count + 1 })
    .eq('id', exportId);
  await admin.from('report_access_events').insert({ report_id: data.report_id, user_id: user.id, event_type: 'downloaded' });

  return Response.redirect(signed.signedUrl, 302);
}
