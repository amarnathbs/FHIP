import { PageBackLink } from '@/components/navigation/PageBackLink';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { RunReviewPanel } from '@/components/aie/review/RunReviewPanel';

/**
 * AIE-1.5 — one document's review detail. Ownership is enforced entirely
 * server-side by `GET /api/aie/review/runs/{runId}` (which scopes every
 * read by the authenticated user id, never trusting this URL param as
 * proof of access) — this page performs no ownership check of its own
 * beyond requiring an authenticated session, matching the FDH review
 * page's own established division of labour (page = auth gate, API route
 * = ownership + data).
 */
async function AieReviewRunPageContent({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Review document</h1>
      </div>
      <RunReviewPanel runId={runId} />
    </div>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Document review).
export default function AieReviewRunPage(props: Parameters<typeof AieReviewRunPageContent>[0]) {
  return (
    <>
      <PageBackLink href="/aie-review" label="Document review" />
      <AieReviewRunPageContent {...props} />
    </>
  );
}
