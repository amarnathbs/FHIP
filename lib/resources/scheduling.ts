// Resources scheduling validation — Admin A0.2 Wave 2, Scope B.
//
// ONE shared implementation of the canonical scheduling rule, used
// identically by all four Resources workflow routes (General Content,
// Glossary, Money Updates, Videos) so that the same administrator action
// produces the same error code, the same HTTP status, the same plain-English
// message and the same field reference regardless of which content type is
// being worked on.
//
// Before Wave 2 these four routes disagreed: only the content route checked
// anything, and what it checked was a client-supplied `scheduledAt` body
// property that was never persisted, never forwarded to the workflow RPC and
// never compared against anything — so `scheduledAt: "banana"` satisfied it.
// The other three routes had no scheduling check at all and fell through to
// the raw table CHECK constraint, whose PostgreSQL 23514 text was surfaced to
// the client as a misleading HTTP 403.
//
// THIS FILE IS NOT THE SECURITY BOUNDARY. The non-bypassable control is the
// same rule implemented inside public.transition_resource_post_status
// (migration 0116), which every one of these routes must go through and which
// also covers a direct RPC call that skips the API entirely. This helper
// exists so the administrator gets a clean, field-level 422 from the API
// instead of a raw database exception — the same relationship the existing
// validateForReview/validateForPublish pre-checks already have with the RPC.
//
// CANONICAL RULE (see migration 0116's header for the derivation):
//   A transition to 'scheduled' requires the Resource to already hold a
//   `scheduled_at` timestamp that is strictly later than now.
//
// Notes on what this deliberately does NOT do:
//   * It never reads a timestamp from the request body. `scheduled_at` is a
//     stored, service-role-only column; trusting a client value here is
//     exactly the bug Wave 2 is removing.
//   * It never infers a timezone from country, currency or locale. The stored
//     value is `timestamptz` — an absolute instant — and the database
//     compares it against its own now().
//   * It imposes no minimum lead time. Nothing in the product defines one.

import type { ResourceStatus } from './types';

export const SCHEDULING_FIELD = 'scheduled_at';

export type SchedulingErrorCode = 'SCHEDULED_AT_REQUIRED' | 'SCHEDULED_AT_INVALID' | 'SCHEDULED_AT_IN_PAST';

export interface SchedulingError {
  code: SchedulingErrorCode;
  /** Plain-English, safe to display. Identical across all four content types. */
  message: string;
  /** Always `scheduled_at` — the field the administrator must fix. */
  field: typeof SCHEDULING_FIELD;
}

// These strings are intentionally identical to the messages raised by
// public.transition_resource_post_status so that the pre-check and the
// database's own rejection are indistinguishable to the administrator.
const REQUIRED_MESSAGE = 'A publish date and time is required before this content can be scheduled.';
const IN_PAST_MESSAGE = 'The scheduled publish date and time must be in the future.';
const INVALID_MESSAGE = 'The scheduled publish date and time is not a valid date.';

/**
 * The canonical scheduling pre-check.
 *
 * Returns `null` when the transition may proceed to the workflow RPC — which
 * includes every transition that is not to `scheduled`, since the invariant
 * gates only that one target. Immediate publish is deliberately unaffected
 * and continues to ignore `scheduled_at` entirely.
 *
 * @param toStatus     the requested target status
 * @param scheduledAt  the Resource's STORED scheduled_at (never a client value)
 */
export function validateScheduledTransition(toStatus: ResourceStatus | string, scheduledAt: string | null | undefined): SchedulingError | null {
  if (toStatus !== 'scheduled') return null;

  if (scheduledAt === null || scheduledAt === undefined || (typeof scheduledAt === 'string' && scheduledAt.trim() === '')) {
    return { code: 'SCHEDULED_AT_REQUIRED', message: REQUIRED_MESSAGE, field: SCHEDULING_FIELD };
  }

  const parsed = Date.parse(scheduledAt);
  if (Number.isNaN(parsed)) {
    return { code: 'SCHEDULED_AT_INVALID', message: INVALID_MESSAGE, field: SCHEDULING_FIELD };
  }

  // Strictly future. The authoritative comparison is the database's own
  // now() inside the RPC; this one only decides whether to spend a round trip
  // finding that out, so a few milliseconds of clock skew between the app
  // server and the database can at worst let a doomed request through to the
  // RPC, which then rejects it with the identical message. It can never let
  // an invalid transition commit.
  if (parsed <= Date.now()) {
    return { code: 'SCHEDULED_AT_IN_PAST', message: IN_PAST_MESSAGE, field: SCHEDULING_FIELD };
  }

  return null;
}

/**
 * The canonical HTTP shape for a scheduling rejection: HTTP 422 with a
 * machine-readable code, a displayable message and a `fields` map keyed by
 * the offending field — the same envelope the existing
 * validateForReview/validateForPublish gates already return, so no client
 * needs a new error shape.
 */
export function schedulingErrorResponse(error: SchedulingError): Response {
  return Response.json({ error: error.message, code: error.code, fields: { [error.field]: error.message } }, { status: 422 });
}
