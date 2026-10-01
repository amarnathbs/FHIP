import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { createUploadSession, FdhUploadLifecycleError } from '@/lib/financial-data-hub/services/uploadLifecycle';
import { fdhCreateUploadSessionSchema } from '@/lib/financial-data-hub/validation/uploadSession';
import { OWNER_FLOW_FOR_DOCUMENT_TYPE, recordDocumentOwner, resolveUploadOwner, type UploadOwnerResult } from '@/lib/financial-data-hub/services/documentOwnerRequest';

// POST /api/financial-data-hub/documents/upload-sessions — createUploadSession()
// (spec section 27). Returns no storage credential — only a session id the
// browser pairs with a later complete-upload call.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Document uploads are not currently enabled in this environment.', 403);
  }

  const body = await req.json().catch(() => null);
  const parsed = fdhCreateUploadSessionSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'Invalid request', 422);

  // Owner-before-upload (Phase 2): a financial document type needs its owner BEFORE a session
  // (and so before any file) exists. Types with no financial canonical effect (tax_document,
  // other) are not asked. The payslip panel, and anything else on this generic route, is held
  // to the same flow policy as the dedicated upload routes.
  const flow = OWNER_FLOW_FOR_DOCUMENT_TYPE[parsed.data.document_type] ?? null;
  let ownerResult: UploadOwnerResult | null = null;
  if (flow) {
    ownerResult = await resolveUploadOwner(user.id, (body as { owner?: unknown } | null)?.owner, flow);
    if (!ownerResult.ok) return ownerResult.response;
  }

  try {
    const { document, session } = await createUploadSession(user.id, parsed.data);
    if (ownerResult?.ok) await recordDocumentOwner(user.id, document.id, ownerResult.owner);
    return ok({
      document_id: document.id,
      session_id: session.id,
      owner_role: ownerResult?.ok ? ownerResult.owner.ownerRole : null,
      expires_at: session.expires_at,
      allowed_mime_type: session.allowed_mime_type,
      max_size_bytes: session.expected_max_size_bytes,
    });
  } catch (e) {
    if (e instanceof FdhUploadLifecycleError && e.code === 'rate_limited') return bad(e.message, 429);
    return bad(e instanceof Error ? e.message : 'could not create upload session', 500);
  }
}
