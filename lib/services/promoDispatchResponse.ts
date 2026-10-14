import type { DispatchFailure } from '@/lib/services/promoCodeEmail';

/**
 * The HTTP response for a refused or duplicate dispatch. Carries the stable code, the message and, for a repeated request key,
 * the per recipient status taken from the ledger. Never a code, an address or a hash.
 */
export function dispatchFailureResponse(f: DispatchFailure): Response {
  return Response.json(
    { error: f.code, message: f.message, ...(f.recipients ? { recipients: f.recipients } : {}) },
    { status: f.status }
  );
}
