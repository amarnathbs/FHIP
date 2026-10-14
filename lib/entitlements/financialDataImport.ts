/**
 * Financial data import -- the ONE server-side Premium capability for every customer-facing
 * financial file upload / statement import / automated extraction / reprocess / connector sync.
 *
 *   Helper name (stable, documented):  resolveFinancialImportAccess / refuseUnlessFinancialImportAllowed /
 *                                      assertFinancialImportAllowed / refuseUnlessImportRunMayStart
 *   Capability name:                   financial_data_import (FINANCIAL_DATA_IMPORT_CAPABILITY)
 *   Inventory + CI contract:           lib/entitlements/financialImportInventory.ts
 *                                      tests/unit/premiumUploadInventoryContract.test.ts
 *
 * POLICY (Product Owner decision 14-10-2026), and nothing else
 *   allowed  <=>  the signed-in user is Premium TODAY
 *   denied   <=>  anything else -- Free, no entitlement row, an expired / not-yet-started window, an unknown
 *                 tier, a malformed row. Ambiguity is Free, never Premium.
 *   unavailable <=> the entitlement could not be read (database error, missing client). Fail closed, but report
 *                 it as an OUTAGE (HTTP 503 ENTITLEMENT_UNAVAILABLE), not as "please pay" (HTTP 403 PREMIUM_REQUIRED).
 *
 * "PREMIUM" MEANS WHAT THE REST OF THE PRODUCT MEANS. There is no second subscription system and no second
 * reading of provider status here: this consumes `user_entitlements` through the same pure predicate
 * (`effectivePlanTier`, lib/services/entitlementWindow.ts) that report export, the recommendations page and the
 * SQL AI functions use. Stripe / Razorpay webhooks (lib/services/payments/entitlementSync.ts) are the only writers
 * of that row, so active / trialing / past_due (Premium) and terminal statuses (Free) are honoured without this
 * file knowing about any of them, and admin grants and promo codes -- which write the same row -- work too.
 * This module NEVER writes `plan_tier` and NEVER calls a payment provider (tests/unit/premiumUploadEntitlementAudit).
 *
 * WHAT IT NEVER DOES
 *   - trusts the browser: no plan, price, country or Premium flag in a body, query string, header, cookie or
 *     localStorage is ever read. The id passed in is the AUTHENTICATED session user's id.
 *   - treats an Admin / Super Admin as Premium. Staff and system jobs are governed by admin capabilities on
 *     admin routes (which never call this) -- not by a consumer subscription; and an admin testing as a
 *     customer needs a customer entitlement like anyone else.
 *   - caches. Every call reads the row (one indexed single-row select), so an upgrade is usable on the next
 *     request and a downgrade stops NEW admissions on the next request. There is nothing to invalidate.
 *
 * DOWNGRADE POLICY (documented, deterministic)
 *   - NEW admission (a file's bytes, a signed credential / upload session, a document row, a connector sync):
 *     requires Premium NOW. Premium is "stamped" by the admission itself: a document row can only exist because
 *     every creation path above passed this check, and the admission audit event records `import_entitlement:
 *     'premium'`.
 *   - An already-admitted document keeps its lifecycle after a downgrade -- review, correct, approve, apply,
 *     delete, the user's own privacy actions -- so sensitive data is never stranded behind a new paywall; and the
 *     first processing run of a document admitted while Premium (status `queued`) may still start. What a Free
 *     user cannot do is start NEW work: re-queue a `failed` document (retry), force a re-parse, or upload again.
 *     `refuseUnlessImportRunMayStart` is that rule.
 *   - The upload-session credential is single-use and short-lived, but it is NOT honoured after a downgrade:
 *     completing the upload (the step that stores raw bytes) re-checks Premium.
 */

import { createClient } from '@/lib/supabase/server';
import { effectivePlanTier, isValidIsoDate, utcToday, type EntitlementWindowRow } from '@/lib/services/entitlementWindow';
import {
  FINANCIAL_IMPORT_ENTITLEMENT_UNAVAILABLE,
  FINANCIAL_IMPORT_PREMIUM_REQUIRED,
  FINANCIAL_IMPORT_UPGRADE_PATH,
  financialImportDeniedMessage,
  type FinancialImportAccessView,
  type FinancialImportDenyCode,
  type FinancialImportDeniedBody,
} from './financialDataImportContract';

export * from './financialDataImportContract';

export type FinancialImportDecision =
  | { allowed: true; planTier: 'premium' }
  | { allowed: false; code: FinancialImportDenyCode; httpStatus: 403 | 503; upgradeAvailable: boolean };

/** Result of reading one entitlement row. `error` set means "could not read" -- never "Free". */
export interface FinancialImportEntitlementRead {
  row: EntitlementWindowRow | null;
  error: string | null;
}

export interface FinancialImportAccessDeps {
  /** Test seam. Default: the request-scoped (RLS, own-row-only) read of `user_entitlements`. */
  readEntitlement?: (userId: string) => Promise<FinancialImportEntitlementRead>;
  /** Test seam. Default: the UTC calendar date, as the SQL functions and every other consumer use. */
  today?: string;
  /** Test seam. Default: a structured, PII-free log line for denials. */
  onEvent?: (event: FinancialImportEvent) => void;
}

/** Privacy-safe decision record: the surface and the reason code. No user id, no file name, no document content. */
export interface FinancialImportEvent {
  event: 'import_admission_allowed' | 'import_admission_denied_free' | 'import_entitlement_unavailable';
  surface: string;
  code?: FinancialImportDenyCode;
}

async function readEntitlementRow(userId: string): Promise<FinancialImportEntitlementRead> {
  try {
    const supabase = await createClient();
    // Request-scoped: the session client, so RLS ("own entitlement": auth.uid() = user_id) can only ever return the
    // caller's own row; the explicit eq is belt and braces, not the isolation.
    const { data, error } = await supabase
      .from('user_entitlements')
      .select('plan_tier, effective_from, effective_to')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return { row: null, error: error.message || 'entitlement read failed' };
    return { row: (data ?? null) as EntitlementWindowRow | null, error: null };
  } catch (e) {
    return { row: null, error: e instanceof Error ? e.message : 'entitlement read threw' };
  }
}

function emit(deps: FinancialImportAccessDeps, event: FinancialImportEvent): void {
  try {
    if (deps.onEvent) {
      deps.onEvent(event);
      return;
    }
    if (event.event !== 'import_admission_allowed' && process.env.NODE_ENV !== 'test') {
      console.info(JSON.stringify({ ...event, capability: 'financial_data_import' }));
    }
  } catch {
    /* an event sink must never change an access decision */
  }
}

/** A row whose Premium claim cannot be trusted (garbage dates) is NOT Premium. */
function isWellFormedWindow(row: EntitlementWindowRow): boolean {
  const from = row.effective_from ?? null;
  const to = row.effective_to ?? null;
  return (from === null || isValidIsoDate(from)) && (to === null || isValidIsoDate(to));
}

/**
 * The shared decision. `userId` MUST be the authenticated session user's id -- never a value taken from a request
 * body, query string or header (a Premium user therefore cannot spend their entitlement on someone else's behalf,
 * and nobody can ask about another user's plan).
 */
export async function resolveFinancialImportAccess(
  userId: string,
  surface: string,
  deps: FinancialImportAccessDeps = {},
): Promise<FinancialImportDecision> {
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    emit(deps, { event: 'import_entitlement_unavailable', surface, code: FINANCIAL_IMPORT_ENTITLEMENT_UNAVAILABLE });
    return { allowed: false, code: FINANCIAL_IMPORT_ENTITLEMENT_UNAVAILABLE, httpStatus: 503, upgradeAvailable: false };
  }

  let read: FinancialImportEntitlementRead;
  try {
    read = await (deps.readEntitlement ?? readEntitlementRow)(userId);
  } catch {
    read = { row: null, error: 'entitlement reader threw' };
  }
  if (read.error) {
    emit(deps, { event: 'import_entitlement_unavailable', surface, code: FINANCIAL_IMPORT_ENTITLEMENT_UNAVAILABLE });
    return { allowed: false, code: FINANCIAL_IMPORT_ENTITLEMENT_UNAVAILABLE, httpStatus: 503, upgradeAvailable: false };
  }

  const row = read.row;
  const tier = row && isWellFormedWindow(row) ? effectivePlanTier(row, deps.today ?? utcToday()) : 'free';
  if (tier !== 'premium') {
    emit(deps, { event: 'import_admission_denied_free', surface, code: FINANCIAL_IMPORT_PREMIUM_REQUIRED });
    return { allowed: false, code: FINANCIAL_IMPORT_PREMIUM_REQUIRED, httpStatus: 403, upgradeAvailable: true };
  }

  emit(deps, { event: 'import_admission_allowed', surface });
  return { allowed: true, planTier: 'premium' };
}

/** The unified refusal body: HTTP 403 { code: 'PREMIUM_REQUIRED' } or HTTP 503 { code: 'ENTITLEMENT_UNAVAILABLE' }. */
export function financialImportDeniedBody(decision: Extract<FinancialImportDecision, { allowed: false }>): FinancialImportDeniedBody {
  return {
    error: financialImportDeniedMessage(decision.code),
    code: decision.code,
    data: {
      allowed: false,
      reason: decision.code,
      upgrade_available: decision.upgradeAvailable,
      upgrade_path: decision.upgradeAvailable ? FINANCIAL_IMPORT_UPGRADE_PATH : null,
    },
  };
}

export function financialImportDeniedResponse(decision: Extract<FinancialImportDecision, { allowed: false }>): Response {
  return Response.json(financialImportDeniedBody(decision), {
    status: decision.httpStatus,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

/**
 * Route guard. Returns the Response to send back when the caller may NOT start a new import, or null when they may.
 * Call it immediately after authentication and BEFORE the body is read, a document row is created, a credential is
 * issued, a file is stored, a scan or a parser is run, a job is queued, or a paid provider is called.
 */
export async function refuseUnlessFinancialImportAllowed(
  userId: string,
  surface: string,
  deps: FinancialImportAccessDeps = {},
): Promise<Response | null> {
  const decision = await resolveFinancialImportAccess(userId, surface, deps);
  return decision.allowed ? null : financialImportDeniedResponse(decision);
}

/** Thrown by `assertFinancialImportAllowed` -- the service-layer boundary behind every route guard. */
export class FinancialImportDeniedError extends Error {
  readonly code: FinancialImportDenyCode;
  readonly httpStatus: 403 | 503;
  readonly upgradeAvailable: boolean;
  constructor(decision: Extract<FinancialImportDecision, { allowed: false }>) {
    super(financialImportDeniedMessage(decision.code));
    this.name = 'FinancialImportDeniedError';
    this.code = decision.code;
    this.httpStatus = decision.httpStatus;
    this.upgradeAvailable = decision.upgradeAvailable;
  }
}

/**
 * Service / RPC admission boundary. A critical write service (create a document row, store raw bytes, create an
 * intake) calls this so that an accidentally ungated route still cannot create new Free upload work.
 */
export async function assertFinancialImportAllowed(
  userId: string,
  surface: string,
  deps: FinancialImportAccessDeps = {},
): Promise<void> {
  const decision = await resolveFinancialImportAccess(userId, surface, deps);
  if (!decision.allowed) throw new FinancialImportDeniedError(decision);
}

/** Maps a thrown denial to the unified response; null for any other error (the caller keeps its own mapping). */
export function financialImportErrorResponse(error: unknown): Response | null {
  if (!(error instanceof FinancialImportDeniedError)) return null;
  return financialImportDeniedResponse({
    allowed: false,
    code: error.code,
    httpStatus: error.httpStatus,
    upgradeAvailable: error.upgradeAvailable,
  });
}

/**
 * What an already-admitted document is doing when a process / retry / reprocess request arrives:
 *   'first_run' -- the document is waiting for its first processing run (admitted while Premium; bounded continuation)
 *   'in_flight' -- processing / review / approval already past that point (idempotent; no new extraction work)
 *   'retry'     -- a failed document that would be re-queued (a NEW parse / provider attempt)
 *   'forced'    -- the caller asked to throw away a previous result and parse again
 *   'unknown'   -- no such document for this user
 */
export type AdmittedRunPosition = 'first_run' | 'in_flight' | 'retry' | 'forced' | 'unknown';

/**
 * Guard for process / retry / reprocess style routes (they receive a document id, not a file).
 *   Premium now            -> allowed (existing behaviour, unchanged).
 *   Free now, 'first_run'  -> allowed: the bounded continuation of a document admitted while Premium.
 *   Free now, 'in_flight'  -> allowed: idempotent, returns what already exists, starts no new extraction.
 *   Free now, 'retry' / 'forced' / 'unknown' -> PREMIUM_REQUIRED (a fresh parse / provider attempt, or a document
 *                             this user does not have: never confirms existence).
 *   Entitlement unreadable -> 503 (fail closed), whatever the position, because the position is only consulted
 *                             when the entitlement is known to be Free.
 * `position` is a thunk so a Premium caller pays for exactly one entitlement read and no document read.
 */
export async function refuseUnlessImportRunMayStart(
  userId: string,
  surface: string,
  position: () => Promise<AdmittedRunPosition>,
  deps: FinancialImportAccessDeps = {},
): Promise<Response | null> {
  const decision = await resolveFinancialImportAccess(userId, surface, deps);
  if (decision.allowed) return null;
  if (decision.code === FINANCIAL_IMPORT_PREMIUM_REQUIRED) {
    let where: AdmittedRunPosition;
    try {
      where = await position();
    } catch {
      where = 'unknown';
    }
    if (where === 'first_run' || where === 'in_flight') return null;
  }
  return financialImportDeniedResponse(decision);
}

/** What the browser is drawn from. Presentation only: it authorises nothing. */
export async function financialImportAccessView(
  userId: string,
  surface: string,
  deps: FinancialImportAccessDeps = {},
): Promise<FinancialImportAccessView> {
  const decision = await resolveFinancialImportAccess(userId, surface, deps);
  if (decision.allowed) return { state: 'allowed' };
  return decision.code === FINANCIAL_IMPORT_PREMIUM_REQUIRED ? { state: 'premium_required' } : { state: 'unavailable' };
}
