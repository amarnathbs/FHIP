// AIE payslip AI-fallback feature flag — matches this codebase's universal
// convention (tests/unit/aiePilotCohort.test.ts, iiAiFallbackPilotCohort.test.ts,
// etc.): default OFF, only the literal string 'true' enables it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAiePayslipAiFallbackEnabled } from '@/lib/aie/adapters/payslip/featureFlags';

const KEY = 'AIE_PAYSLIP_AI_FALLBACK_ENABLED';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[KEY];
  delete process.env[KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe('isAiePayslipAiFallbackEnabled', () => {
  it('defaults to false when unset', () => {
    expect(isAiePayslipAiFallbackEnabled()).toBe(false);
  });

  it('is false for any value other than the exact literal "true"', () => {
    for (const v of ['TRUE', 'True', '1', 'yes', 'enabled', '']) {
      process.env[KEY] = v;
      expect(isAiePayslipAiFallbackEnabled()).toBe(false);
    }
  });

  it('is true only for the exact literal "true"', () => {
    process.env[KEY] = 'true';
    expect(isAiePayslipAiFallbackEnabled()).toBe(true);
  });
});
