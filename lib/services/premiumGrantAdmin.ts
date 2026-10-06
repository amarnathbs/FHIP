// Admin Premium grant (migration 0231) — request validation, RPC wrappers and
// error mapping for the grant / extend / revoke admin surface.
//
// WHERE THE RULES LIVE. The database function admin_manage_premium_entitlement()
// is authoritative for every rule (capability, 365-day cap, mandatory reason,
// paid-entitlement protection, audit). `parseManageRequest` repeats the input
// rules ONLY so a bad request is rejected early with a precise message and
// without a database round trip; it can never approve anything the database
// would refuse, and the cap is enforced on the server in BOTH places — the UI
// date picker is a convenience, not the control.

import type { SupabaseClient } from '@supabase/supabase-js';
import { ENTITLEMENT_GRANT_MAX_DAYS, addDaysIso, isValidIsoDate } from '@/lib/services/entitlementWindow';

export const MANAGE_ACTIONS = ['grant', 'extend', 'revoke'] as const;
export type ManageAction = (typeof MANAGE_ACTIONS)[number];

/**
 * Maximum successful admin extensions per grant. ONE named constant on the TypeScript side; the
 * database's single source is premium_grant_max_extensions() (migration 0237) and a test asserts they
 * agree. Definitions (see the migration header and the report): a "grant" is one allocation (admin
 * Grant or promo redemption); an "extension" is one successful admin Extend on it; the counter resets
 * when a new grant starts (Grant after Revoke/lapse, or a promo redemption) and Revoke clears it.
 */
export const MAX_EXTENSIONS_PER_GRANT = 5;

export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 1000;

export interface ManageRequest {
  action: ManageAction;
  userId: string;
  /** YYYY-MM-DD; null for revoke. */
  endsOn: string | null;
  reason: string;
}

export interface RouteError {
  status: number;
  code: string;
  message: string;
}

export type ParseManageResult = { ok: true; value: ManageRequest } | ({ ok: false } & RouteError);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code: string, message: string, status = 422): ParseManageResult {
  return { ok: false, status, code, message };
}

/**
 * The end-date rule for grant/extend. `maxDays` is a parameter ONLY so the test
 * suite can run a deliberately weakened rule as a negative control; every real
 * call site uses the default (the 1-year cap).
 */
export function checkEndDate(endsOn: unknown, today: string, maxDays: number = ENTITLEMENT_GRANT_MAX_DAYS): RouteError | null {
  if (!isValidIsoDate(endsOn)) {
    return { status: 422, code: 'ENTITLEMENT_END_DATE_REQUIRED', message: 'endsOn must be a valid date.' };
  }
  if (endsOn < today) {
    return { status: 422, code: 'ENTITLEMENT_END_DATE_IN_PAST', message: 'The end date cannot be in the past.' };
  }
  const latest = addDaysIso(today, maxDays);
  if (endsOn > latest) {
    return {
      status: 422,
      code: 'ENTITLEMENT_END_DATE_EXCEEDS_MAX',
      message: `The end date cannot be more than ${maxDays} days after today (latest allowed: ${latest}).`,
    };
  }
  return null;
}

export function parseManageRequest(body: unknown, today: string): ParseManageResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('ENTITLEMENT_REQUEST_INVALID', 'The request body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;

  if (typeof b.action !== 'string' || !(MANAGE_ACTIONS as readonly string[]).includes(b.action)) {
    return fail('ENTITLEMENT_ACTION_INVALID', 'action must be one of grant, extend or revoke.');
  }
  const action = b.action as ManageAction;

  if (typeof b.userId !== 'string' || !UUID_RE.test(b.userId)) {
    return fail('ENTITLEMENT_TARGET_REQUIRED', 'userId must be a valid user id.');
  }

  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < REASON_MIN_LENGTH) {
    return fail('ENTITLEMENT_REASON_REQUIRED', `A reason of at least ${REASON_MIN_LENGTH} characters is required.`);
  }
  if (reason.length > REASON_MAX_LENGTH) {
    return fail('ENTITLEMENT_REASON_TOO_LONG', `The reason must be at most ${REASON_MAX_LENGTH} characters.`);
  }

  if (action === 'revoke') {
    return { ok: true, value: { action, userId: b.userId.toLowerCase(), endsOn: null, reason } };
  }

  const dateError = checkEndDate(b.endsOn, today);
  if (dateError) return { ok: false, ...dateError };
  return { ok: true, value: { action, userId: b.userId.toLowerCase(), endsOn: b.endsOn as string, reason } };
}

// Stable database message codes -> HTTP status + administrator-facing text.
const RPC_ERRORS: Record<string, { status: number; message: string }> = {
  ENTITLEMENT_UNAUTHENTICATED: { status: 401, message: 'unauthenticated' },
  ENTITLEMENT_ADMIN_REQUIRED: { status: 403, message: 'Premium entitlement admin access required' },
  ENTITLEMENT_ACTION_INVALID: { status: 422, message: 'action must be one of grant, extend or revoke.' },
  ENTITLEMENT_TARGET_REQUIRED: { status: 422, message: 'A target user is required.' },
  ENTITLEMENT_REASON_REQUIRED: { status: 422, message: `A reason of at least ${REASON_MIN_LENGTH} characters is required.` },
  ENTITLEMENT_REASON_TOO_LONG: { status: 422, message: `The reason must be at most ${REASON_MAX_LENGTH} characters.` },
  ENTITLEMENT_END_DATE_REQUIRED: { status: 422, message: 'An end date is required.' },
  ENTITLEMENT_END_DATE_IN_PAST: { status: 422, message: 'The end date cannot be in the past.' },
  ENTITLEMENT_END_DATE_EXCEEDS_MAX: {
    status: 422,
    message: `The end date cannot be more than ${ENTITLEMENT_GRANT_MAX_DAYS} days after today.`,
  },
  ENTITLEMENT_QUERY_TOO_SHORT: { status: 422, message: 'Enter at least 3 characters of an email, or a full user id.' },
  ENTITLEMENT_FILTER_INVALID: { status: 422, message: 'filter/source is not one of the allowed values.' },
  ENTITLEMENT_USER_NOT_FOUND: { status: 404, message: 'No such user.' },
  ENTITLEMENT_SELF_TARGET: { status: 422, message: 'You cannot change your own entitlement.' },
  ENTITLEMENT_PAID_ACTIVE: {
    status: 409,
    message:
      'This user already holds an active Premium entitlement that was not allocated by an admin (paid, or set manually). It is protected: it cannot be granted over, extended or revoked here.',
  },
  ENTITLEMENT_GRANT_ALREADY_ACTIVE: { status: 409, message: 'This user already has an active admin grant. Use Extend to change its end date.' },
  ENTITLEMENT_NO_ADMIN_GRANT: { status: 409, message: 'This user has no admin grant to extend or revoke. Use Grant.' },
  ENTITLEMENT_EXTENSION_LIMIT_REACHED: {
    status: 409,
    message: `This grant has already been extended ${MAX_EXTENSIONS_PER_GRANT} times, which is the limit. To give further access, Revoke it and then Grant again (both actions are audited).`,
  },
  ENTITLEMENT_EXTENSION_NOT_LATER: {
    status: 422,
    message: 'An extension must set an end date later than the current end date. To end access sooner, use Revoke.',
  },
};

/**
 * Maps a Postgres/PostgREST error from one of the entitlement RPCs to a safe
 * route error, or null when it is not one of ours (the caller then falls back
 * to safeDbError(), which never leaks internals).
 */
/**
 * True when the error means "this database does not have the object": a missing function (PostgREST
 * PGRST202 / Postgres 42883), table or view (PGRST205 / 42P01) or column (42703). That is a deployment-order
 * condition (the code is live before its migration), not a user mistake and not a defect to leak.
 */
export function isMissingDbObjectError(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (['PGRST202', '42883', 'PGRST205', '42P01', '42703'].includes(code)) return true;
  return /could not find the function|does not exist|schema cache/i.test(error.message ?? '');
}

export const FEATURE_UNAVAILABLE: RouteError = {
  status: 503,
  code: 'FEATURE_UNAVAILABLE',
  message: 'This feature is not available on this database yet. Nothing was changed.',
};

export function mapEntitlementRpcError(error: { message?: string; code?: string } | null | undefined): RouteError | null {
  if (!error?.message) return null;
  if (isMissingDbObjectError(error)) return FEATURE_UNAVAILABLE;
  const code = Object.keys(RPC_ERRORS).find((c) => error.message === c || error.message!.startsWith(`${c}:`) || error.message!.includes(c));
  if (!code) return null;
  return { code, ...RPC_ERRORS[code] };
}

type RpcClient = Pick<SupabaseClient, 'rpc'>;

export interface ManageResult {
  audit_id: string;
  action: ManageAction;
  target_user_id: string;
  as_of: string;
  plan_tier: 'free' | 'premium';
  entitlement_source: 'payment' | 'admin_grant';
  effective_from: string | null;
  effective_to: string | null;
  admin_grant_ends_on: string | null;
  extension_count?: number;
  extensions_remaining?: number;
}

/**
 * Runs the single authoritative write. MUST be given the CALLER's session
 * client (not the service-role client): the RPC authorises on auth.uid().
 */
export function callManageEntitlement(client: RpcClient, req: ManageRequest) {
  return client.rpc('admin_manage_premium_entitlement', {
    p_action: req.action,
    p_target_user_id: req.userId,
    p_ends_on: req.endsOn,
    p_reason: req.reason,
  });
}

export function callSearchUsers(client: RpcClient, query: string) {
  return client.rpc('admin_search_premium_entitlement_users', { p_query: query });
}

export function callListGrants(client: RpcClient, filter: 'expiring' | 'active' | 'lapsed', withinDays: number) {
  return client.rpc('admin_list_premium_grants', { p_filter: filter, p_within_days: withinDays });
}

export function callExpirySummary(client: RpcClient, source: 'admin_grant' | 'promo_code' | null) {
  return client.rpc('admin_entitlement_expiry_summary', { p_source: source });
}

export function callHistory(client: RpcClient, userId: string, limit = 50) {
  return client.rpc('admin_premium_entitlement_history', { p_target_user_id: userId, p_limit: limit });
}
