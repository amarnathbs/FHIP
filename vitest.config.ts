import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // The AI fallback is refused unless the real malware scan is on
    // (lib/aie/malware/aiEgressPrecondition.ts). Unit tests run fake providers on
    // synthetic text with no AWS scanner, so they take the disclosed DEV-only
    // override; the tests that prove the refusal delete it explicitly.
    env: { AIE_ALLOW_AI_FALLBACK_WITHOUT_REAL_SCAN: 'true' },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
