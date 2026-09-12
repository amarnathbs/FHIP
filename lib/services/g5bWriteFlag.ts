// G5B — Generic Universal-Module Write Enablement, feature flag.
//
// Product Owner authorisation, 2026-09-05: "Build the application capability
// changes but keep them disabled until the migration has been reviewed,
// applied and behaviorally verified in DEV." This is a SEPARATE, narrower
// flag from lib/services/appCapabilityFlag.ts's G4 flag, not a reuse of it —
// the G4 flag governs whether the ENTIRE manifest-driven resolver is active
// at all (falling back to legacy requireCountryConfirmedUser() behaviour when
// off); this flag only matters once G4 is already on, and only changes the
// CREATE/UPDATE operation policy for the three G5B-certified modules
// (Income/Expenses/Insurance). Turning G4 on without this flag leaves those
// three modules' CREATE/UPDATE exactly as UNAVAILABLE_FOR_GENERIC_WRITE as
// they are today; turning this flag on with G4 off has no effect at all
// (requireModuleCapability() never consults operationPolicy while G4 is off).
//
// Same safe-default pattern as appCapabilityFlag.ts: server-only env var
// (never NEXT_PUBLIC_*), default OFF, fails to the safer legacy behaviour on
// any misconfiguration (unset, empty, or any value other than the exact
// string 'true'), plus a deterministic test override seam.
//
// G8.056 — ROLLBACK ASYMMETRY, DISCLOSED HERE SO A FUTURE OPERATOR'S RUNBOOK
// CANNOT ASSUME "FLIP THIS OFF" IS SUFFICIENT: this flag ONLY controls
// whether FHIP's own Next.js API routes are willing to construct a
// GENERIC-write request. It has NO effect on the separate, independently-
// controlled DATABASE-layer grant (migration 0129's is_write_permitted() /
// mcc_generic_write_capabilities) — Postgres cannot read a Node.js
// process.env value. The instant migration 0129 is applied to an
// environment, GENERIC-user writes to Income/Expenses/Insurance become
// permanently, unconditionally permitted at the database layer, independent
// of this flag's state, for ANY client authenticated as that user —
// including a direct PostgREST call outside this app entirely. Setting this
// env var back to 'false' does NOT revoke that grant; only migration 0129's
// own commented-out manual rollback SQL block does. See that migration's
// header for the actual kill-switch procedure.
const ENV_VAR_NAME = 'G5B_GENERIC_WRITE_ENABLED';

let testOverride: boolean | undefined;

/** Test seam — lets a test force the flag on/off without mutating
 * process.env (which leaks across test files under vitest's shared worker
 * process). `undefined` means "consult the environment variable", which is
 * also the default state. */
export function __setG5BGenericWriteFlagForTests(value: boolean | undefined): void {
  testOverride = value;
}

/**
 * Whether the G5B database migration has been applied to and verified in DEV
 * and the application layer is authorised to expose CREATE/UPDATE for the
 * three G5B-certified modules (Income/Expenses/Insurance) to a GENERIC
 * user. MUST default to false — see this task's Phase 1 governance ("Do NOT
 * enable the feature flag by default anywhere"). Flipping this on before the
 * migration is applied would show a GENERIC user a live "Add"/"Edit" control
 * that the database still rejects with a raw 42501 on submit.
 */
export function isG5BGenericWriteEnabled(): boolean {
  if (testOverride !== undefined) return testOverride;
  return process.env[ENV_VAR_NAME] === 'true';
}
