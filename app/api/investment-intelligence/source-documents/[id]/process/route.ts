import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { processSourceDocument } from '@/lib/services/investment-intelligence/documentProcessing';
import { z } from 'zod';

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
  return ok(result);
}
