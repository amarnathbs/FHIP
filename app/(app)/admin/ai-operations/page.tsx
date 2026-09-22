import { requireAiOperationsViewerPage } from '@/lib/services/aiOperationsAdmin';
import AiOperationsClient from '@/components/admin/AiOperationsClient';

// Module 11 remediation R4 — the Admin AI Operations screen.
//
// Admin Architecture Standard §4 layer 3: the page-layer guard runs BEFORE any
// render, and a caller without can_view_ai_operations is redirected rather
// than shown an empty dashboard. Layers 1, 2 and 4 are migration 0177's
// predicates + zero-policy RLS on every governance table, the API route's
// requireAiOperationsViewer(), and lib/admin/adminNav.ts.
export default async function AiOperationsPage() {
  await requireAiOperationsViewerPage();
  return <AiOperationsClient />;
}
