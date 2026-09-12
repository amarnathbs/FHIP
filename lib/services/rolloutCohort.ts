/**
 * G8 closure — canonical controlled-rollout / percentage-cohort primitive.
 *
 * BACKGROUND (docs/country-programme/g8-ownership-decisions.md, G8.055):
 * no per-user rollout/cohort/canary mechanism exists anywhere in this
 * codebase. Every existing flag examined (G2/G4/G5B, all in
 * lib/services/*Flag.ts) is a plain boolean: DEV-verify, then flip one
 * global env var to 100% of production, instantly, for every user. The one
 * near-miss, `ai_model_registry.rollout_percentage` (migration 0110), is
 * dead code (read by nobody), scoped to AI-model traffic-splitting (no
 * user-key column at all), and governance-locked to admin/service-role —
 * not a general per-user targeting primitive, and NOT reused here per the
 * closure mission's explicit instruction.
 *
 * SCOPE OF THIS FILE, PRECISELY: this module is a new, generic, reusable
 * primitive. It is NOT wired into any existing route by this closure work.
 * A rollout key with no configuration at all (the default state for every
 * key today) fails closed to `false` for everyone — which is exactly
 * correct BECAUSE nothing currently calls this module, so its 0% default
 * cannot regress G5B GENERIC write access, G4 capabilities, G6/G7 behaviour,
 * or the G2 anonymous-landing presentation, all of which continue to be
 * governed entirely by their own existing, unrelated boolean flags. Wiring
 * this primitive into a specific real feature (and choosing that feature's
 * actual rollout percentage) is a separate, explicit Product Owner decision
 * for a future change, not made unilaterally by this file's existence.
 *
 * DESIGN, matching the required behaviour list verbatim:
 *  - Global kill switch: ROLLOUT_<KEY>_ENABLED must be the exact string
 *    'true'; anything else (unset, empty, 'TRUE', '1') is OFF. Mirrors the
 *    exact fail-closed idiom of g5bWriteFlag.ts / appCapabilityFlag.ts /
 *    landingLocalisationFlag.ts.
 *  - Stable authenticated subject allocation: a deterministic
 *    HMAC-SHA-256-derived bucket of (key, version, subjectId) — never
 *    Math.random(), never session/request state, never a client-supplied
 *    identity.
 *  - Configurable percentage: ROLLOUT_<KEY>_PERCENTAGE, integer 0-100.
 *  - Explicit configuration version: ROLLOUT_<KEY>_VERSION, a required
 *    non-empty string. The subject's bucket is derived from (key, version,
 *    subjectId) — NOT from percentage — so raising the percentage with the
 *    version unchanged only ever turns exclusions into inclusions for a
 *    fixed set of subjects (a strictly expanding cohort), never reshuffles
 *    who is already in it. Changing the version is the only way to
 *    deliberately re-bucket everyone.
 *  - Secure certification allowlist: ROLLOUT_<KEY>_ALLOWLIST, a
 *    comma-separated list of subject ids always included regardless of
 *    percentage (e.g. for internal QA / synthetic certification accounts).
 *    Never client-suppliable — server-configured only.
 *  - Explicit denylist precedence: ROLLOUT_<KEY>_DENYLIST, checked BEFORE
 *    the allowlist and BEFORE the percentage bucket — a denylisted subject
 *    is excluded even if also allowlisted or within the percentage.
 *  - Unknown/malformed configuration fails closed: a non-boolean-parseable
 *    ENABLED, an out-of-range or non-numeric PERCENTAGE, or a missing
 *    VERSION all resolve to EXCLUDED, never a thrown error and never a
 *    silent "treat as 100%".
 *  - No client-controlled identity, percentage or inclusion: the caller
 *    must pass a server-resolved subjectId (e.g. `user.id` from
 *    `supabase.auth.getUser()`); this module never reads any request
 *    header, cookie, or query parameter itself.
 *  - Stable across requests/devices/sessions: pure function of
 *    (key, version, subjectId, config) — no per-request or per-device
 *    state at all.
 *  - Country eligibility independent: this module takes no country/
 *    jurisdiction input and makes no jurisdiction decision — a caller
 *    composes it strictly AFTER its own country/capability gate (see
 *    "COMPOSITION" below), exactly like G5B composes after G4.
 *  - No currency-derived jurisdiction: no currency input exists in this
 *    module's signature at all.
 *  - Server-side enforcement: this is plain server-side TypeScript with no
 *    client-reachable code path; a caller enforces it the same way it
 *    enforces requireModuleCapability() today — inside the route handler,
 *    server-side, before any protected work happens.
 *
 * COMPOSITION (the mission's own required effective-permission formula):
 *   Authenticated and country-confirmed
 *   AND jurisdiction/module/operation eligible
 *   AND rollout permits exposure
 *   AND kill switch is not active
 * i.e. a caller resolves auth + MCC + capability FIRST (exactly as
 * requireModuleCapability() already does), and only calls
 * isRolloutPermitted() as one more, final, purely-narrowing check — never
 * before those gates, and never able to grant access those gates deny.
 * Rollout never overrides RLS, MCC, capability rules or entitlement — it
 * has no code path that could, since it only ever returns false or true for
 * ONE flag key and touches no other table, policy, or gate.
 */

export type RolloutDecisionReason =
  | 'KILL_SWITCH_OFF'
  | 'MALFORMED_CONFIG'
  | 'DENYLISTED'
  | 'ALLOWLISTED'
  | 'PERCENTAGE_INCLUDED'
  | 'PERCENTAGE_EXCLUDED';

export interface RolloutDecision {
  permitted: boolean;
  reason: RolloutDecisionReason;
  /** Present only when permitted/excluded by the percentage bucket — useful for audit logging, never for client display. */
  bucket?: number;
}

function envVar(key: string, suffix: string): string | undefined {
  return process.env[`ROLLOUT_${key}_${suffix}`];
}

/** Test-only deterministic override — mirrors __setG4CapabilityLayerFlagForTests()
 * / __setG5BGenericWriteFlagForTests()'s established seam so unit tests never
 * mutate the shared process.env object (which leaks across test files under
 * vitest's shared worker process). Keyed by rollout key so multiple rollout
 * flags can be independently overridden in the same test file. */
const testOverrides = new Map<string, RolloutConfigInput>();
export function __setRolloutConfigForTests(key: string, config: RolloutConfigInput | undefined): void {
  if (config === undefined) testOverrides.delete(key);
  else testOverrides.set(key, config);
}

export interface RolloutConfigInput {
  enabled: boolean;
  version: string;
  percentage: number;
  allowlist?: string[];
  denylist?: string[];
}

/** Parses this rollout key's configuration from process.env, failing closed
 * (returns null) on ANY malformed value — never throws, never guesses. */
function resolveConfig(key: string): RolloutConfigInput | null {
  if (testOverrides.has(key)) {
    return testOverrides.get(key)!;
  }

  const enabledRaw = envVar(key, 'ENABLED');
  if (enabledRaw !== 'true') return null; // kill switch off, or absent -- fail closed either way

  const version = envVar(key, 'VERSION');
  if (!version || version.trim() === '') return null; // explicit version is mandatory

  const percentageRaw = envVar(key, 'PERCENTAGE');
  // Number('') === 0 in JS -- an empty-string env var is a misconfiguration,
  // not a deliberate "0%", so it must be treated the same as "absent".
  const percentage = percentageRaw === undefined || percentageRaw.trim() === '' ? NaN : Number(percentageRaw);
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) return null;

  const allowlist = (envVar(key, 'ALLOWLIST') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const denylist = (envVar(key, 'DENYLIST') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return { enabled: true, version, percentage, allowlist, denylist };
}

/** Deterministic 0-99 bucket for (key, version, subjectId). Uses Node's
 * built-in crypto (no external dependency), SHA-256 over a delimited string
 * (delimiters prevent e.g. key="A" version="1" subject="2" colliding with
 * key="A1" version="" subject="2"). Never Math.random(), never wall-clock
 * time, never any per-request value -- same three inputs always produce the
 * same bucket, in this process or any other. */
function bucketFor(key: string, version: string, subjectId: string): number {
  // Lazily require so this module has zero impact on any bundle that never
  // calls it (Next.js server-only code; 'node:crypto' is never sent to the
  // client, but this keeps the import scoped to the one function that needs it).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const digest = createHash('sha256').update(`rollout|${key}|${version}|${subjectId}`).digest();
  // First 4 bytes as an unsigned 32-bit integer, mod 100. Using multiple
  // bytes (not just digest[0] % 100, which would only have 256 possible
  // values and an uneven mod-100 distribution) keeps the bucket close to
  // uniform across 0-99.
  const n = digest.readUInt32BE(0);
  return n % 100;
}

/**
 * Resolves whether `subjectId` (a server-resolved authenticated user id —
 * NEVER a client-supplied value) is inside the rollout cohort for
 * `key`. Fails closed on any malformed or absent configuration.
 *
 * This function makes NO jurisdiction, capability, entitlement, or RLS
 * decision. Call it only after your own auth + MCC + capability gates have
 * already permitted the request — see this file's COMPOSITION note.
 */
export function resolveRolloutDecision(key: string, subjectId: string): RolloutDecision {
  const config = resolveConfig(key);
  if (config === null) {
    // Indistinguishable on purpose: "kill switch explicitly off" and
    // "malformed/absent configuration" both fail closed identically, so a
    // misconfiguration can never be mistaken for an active, deliberate 0%
    // rollout by anything reading this decision.
    const enabledRaw = envVar(key, 'ENABLED');
    return { permitted: false, reason: enabledRaw === 'true' ? 'MALFORMED_CONFIG' : 'KILL_SWITCH_OFF' };
  }

  if (config.denylist?.includes(subjectId)) {
    return { permitted: false, reason: 'DENYLISTED' };
  }
  if (config.allowlist?.includes(subjectId)) {
    return { permitted: true, reason: 'ALLOWLISTED' };
  }

  const bucket = bucketFor(key, config.version, subjectId);
  const permitted = bucket < config.percentage;
  return { permitted, reason: permitted ? 'PERCENTAGE_INCLUDED' : 'PERCENTAGE_EXCLUDED', bucket };
}

/** Convenience boolean form for the common case (composition inside an
 * existing gate chain, matching isG4CapabilityLayerEnabled()'s plain-boolean
 * shape) -- prefer resolveRolloutDecision() directly wherever the reason
 * code is useful for audit logging. */
export function isRolloutPermitted(key: string, subjectId: string): boolean {
  return resolveRolloutDecision(key, subjectId).permitted;
}
