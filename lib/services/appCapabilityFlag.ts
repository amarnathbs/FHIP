// G4 — Application-Wide Capability Layer, feature flag.
//
// Dispatch section 9: "safe default (off), deterministic test override, DEV
// activation only after static gates pass, no production activation,
// flag-off restores exact G3 containment behavior with no data changes
// either way."
//
// Server-only env var — deliberately NOT NEXT_PUBLIC_* (this is a
// server-authoritative decision, never a client-toggleable one; the client
// only ever learns the RESOLVED capability decisions, via
// /api/capabilities/nav, never the flag itself). Default is OFF: an unset,
// empty, or any value other than the exact string 'true' is treated as off,
// so a misconfigured environment (typo, unset var) fails to the strictly
// safer G3 legacy behaviour rather than accidentally enabling the new layer.
const ENV_VAR_NAME = 'G4_APP_CAPABILITY_LAYER_ENABLED';

// Test seam (section 9: "deterministic test override") — lets a test force
// the flag on/off without mutating process.env (which leaks across test
// files under vitest's shared worker process). `undefined` means "consult
// the environment variable", which is also the default state.
let testOverride: boolean | undefined;

export function __setG4CapabilityLayerFlagForTests(value: boolean | undefined): void {
  testOverride = value;
}

export function isG4CapabilityLayerEnabled(): boolean {
  if (testOverride !== undefined) return testOverride;
  return process.env[ENV_VAR_NAME] === 'true';
}
