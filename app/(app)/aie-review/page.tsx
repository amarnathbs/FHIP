import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ReviewInbox } from '@/components/aie/review/ReviewInbox';

/**
 * AIE-1.5 — the ONE dashboard/inbox entry point (AIE15-IA-09) over the
 * authoritative `aie_extraction_run`/`aie_unresolved_item` lifecycle. Every
 * upload processed through an AIE-fronted route (today: the Insurance
 * adapter's `POST /api/aie/insurance/intake`) lands here for review and
 * acceptance — this page never renders anything itself, it delegates to
 * `ReviewInbox`, which calls `GET /api/aie/review/inbox`.
 *
 * Gated behind `AIE_REVIEW_UI_ENABLED` (default OFF) at the API layer —
 * this page itself always renders, but every fetch from it will report the
 * feature as unavailable until that flag is explicitly turned on (no
 * production authority is granted by this pass).
 */
export default async function AieReviewInboxPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Document review</h1>
        <p className="mt-1 text-sm text-muted">
          Documents we could process automatically are ready for a quick confirmation. Anything that needs a decision from you is shown separately, with exactly what to check — never every field.
        </p>
      </div>
      <ReviewInbox />
    </div>
  );
}
