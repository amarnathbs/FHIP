import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { processSourceDocument } from '@/lib/services/investment-intelligence/documentProcessing';
import { kickUserNavHistory } from '@/lib/services/investment-intelligence/pc6/userNavHistoryKick';
import { z } from 'zod';
import { refuseUnlessImportRunMayStart } from '@/lib/entitlements/financialDataImport';
import { iiSourceDocumentRunPosition } from '@/lib/services/investment-intelligence/importRunPosition';
import { ensureIiRealScanAdmissible } from '@/lib/services/investment-intelligence/realScanAdmission';
import { scanRefusalHttp } from '@/lib/services/investment-intelligence/scanRefusal';
import { recordPasswordNeededAtScanGate } from '@/lib/services/investment-intelligence/scanPasswordPrompt';

// A real-world CAMS consolidated statement with many schemes/transactions
// (found live 2026-09-07: a 17-scheme, ~1000-row statement) can take longer
// to parse+write than the platform's default function timeout, which kills
// the request mid-run with no chance to return a clean error -- the client
// sees a truncated/empty body ("Unexpected end of JSON input") and the
// parse run is left permanently 'running' (see the stale-run rescue in
// documentProcessing.ts). Raise the ceiling here; on platforms that don't
// honor this (some Amplify Hosting compute tiers), the stale-run rescue is
// still the backstop that keeps a timeout from permanently wedging a
// document.
export const maxDuration = 300;

// R2 — "process source document" / "supply temporary PDF password" (spec
// section 51), combined into one endpoint since a password is only ever
// relevant to a processing attempt, never stored beyond this request
// (spec section 10 — "the password used only for document processing;
// do NOT persist the plaintext password anywhere").
//
// Ownership is re-verified inside processSourceDocument() itself (it
// queries ii_source_documents with .eq('user_id', userId) — never trusts
// the route param alone), so this route cannot be used to trigger
// processing of another user's document even if the id is guessed.
//
// Idempotent by design (spec section 52): repeatedly calling this while a
// run is already active returns a clear "already processing" response
// rather than starting a second one; repeatedly calling it after a
// SUCCEEDED run returns the cached summary rather than re-parsing, unless
// forceReparse is explicitly set.
const processBodySchema = z.object({
  password: z.string().max(256).optional(),
  forceReparse: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const bodyRaw = await req.json().catch(() => ({}));
  const parsed = processBodySchema.safeParse(bodyRaw);
  if (!parsed.success) return badValidation(parsed.error, 422);

  // Premium Upload Entitlement (14-10-2026): a retry or a forced re-parse is NEW extraction work and needs Premium; the first run of
  // a document admitted while Premium (and the password it is waiting for) still completes after a downgrade.
  const importDenied = await refuseUnlessImportRunMayStart(user.id, 'ii.source_document.process', () =>
    iiSourceDocumentRunPosition(user.id, id, parsed.data.forceReparse === true),
  );
  if (importDenied) return importDenied;

  // AIE-1 final completion (2026-09-25): nothing parses these bytes until the
  // real malware scan has cleared them (a no-op while the scan is switched
  // off). 409 is retryable -- the client polls; 422 is final.
  const scan = await ensureIiRealScanAdmissible(user.id, id, { password: parsed.data.password });
  if (!scan.admitted) {
    if (scan.reason === 'not_found') return bad('Source document not found.', 404);
    // WP-H2: a protected statement is opened in memory with its password for the scan. A missing or wrong password is the ordinary
    // password step (the document goes to `password_required`, nothing is deleted), not a scan verdict.
    if (scan.reason === 'password_required' || scan.reason === 'wrong_password') return ok(await recordPasswordNeededAtScanGate(user.id, id, scan.reason));
    const refusal = scanRefusalHttp(scan);
    return bad(refusal.message, refusal.status, refusal.code);
  }

  const result = await processSourceDocument({
    userId: user.id,
    sourceDocumentId: id,
    password: parsed.data.password,
    forceReparse: parsed.data.forceReparse,
  });

  // The response NEVER echoes back the supplied password in any field —
  // `result` (ProcessSourceDocumentResult) has no such field by
  // construction (see documentProcessing.ts).
  if (!result.ok && result.status === 'not_found') return bad('Source document not found.', 404);
  // M12C §10 (`M2-OPEN-8`): the shared password-attempt limiter refused this
  // attempt. 429 matches the bank-PDF and AIE unlock routes exactly, so every
  // PDF password surface in the product refuses in the same way.
  if (!result.ok && result.status === 'password_rate_limited') return bad(result.error ?? 'Too many password attempts for this document.', 429, 'password_rate_limited');
  // PO 2026-10-03: once a statement is processed, start fetching the missing NAV
  // history of THIS user's funds -- AFTER the response, never inside it (a data
  // source must not be able to slow or fail the upload). Best effort; the
  // Investment page keeps asking while there is work, and the scheduled job is
  // the fallback.
  if (result.ok && result.summary) kickUserNavHistory(user.id);
  return ok(result);
}
