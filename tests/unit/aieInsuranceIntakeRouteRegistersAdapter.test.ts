/**
 * AIE-1 live-DEV verification pass (2026-09-12) — regression guard for a
 * genuine defect found ONLY by driving a real document through the real,
 * running `/api/aie/insurance/intake` route against real DEV infrastructure
 * (see docs/aie-programme/AIE_1_LIVE_DEV_VERIFICATION_REPORT.md, "Real
 * end-to-end Insurance journey").
 *
 * `app/api/aie/insurance/intake/route.ts` used to carry a bare
 * `import '@/lib/aie/adapters/insurance';` with a comment claiming this was
 * "side-effecting registration (parser + AI-fallback schema)". That claim
 * was false: `lib/aie/adapters/insurance/index.ts` deliberately has NO
 * import-time side effects — registration only happens via an explicit
 * `registerInsuranceAdapter()` call, which every existing AIE-1.4/1.5 unit
 * test happens to make in its own `beforeAll`, masking that no application
 * code ever made that call. The real consequence, only visible against a
 * real running process: `sniffDocument()` never recognised a genuine
 * insurance document, the deterministic parser never ran, and zero field
 * candidates were ever produced for a real upload.
 *
 * This test proves the FIX (an explicit `registerInsuranceAdapter()` call
 * in the route module itself) by importing ONLY the route module — never
 * calling `registerInsuranceAdapter` directly, unlike every other AIE
 * insurance test — and confirming `sniffDocument` now recognises a real
 * insurance fixture as a result of that one import alone. This relies on
 * vitest's default per-file module isolation (no `isolate: false` override
 * in vitest.config.ts — confirmed by reading it) so the shared parser
 * registry starts empty for this file.
 */
import { describe, it, expect } from 'vitest';
import { sniffDocument } from '@/lib/aie/classifier/registry';
import { buildAieInsuranceFixtureText } from '../support/buildAieInsuranceFixtureText';

describe('AIE-1 Insurance intake route — registers its own adapter on import (live-DEV regression)', () => {
  it('importing app/api/aie/insurance/intake/route.ts alone makes sniffDocument recognise an insurance document', async () => {
    const beforeImport = sniffDocument(buildAieInsuranceFixtureText());
    expect(beforeImport.kind).toBe('none_matched');

    await import('@/app/api/aie/insurance/intake/route');

    const afterImport = sniffDocument(buildAieInsuranceFixtureText());
    expect(afterImport.kind).toBe('unambiguous');
    if (afterImport.kind === 'unambiguous') {
      expect(afterImport.parser.adapterId).toBe('insurance_generic_schedule_v1');
    }
  });
});
