/**
 * Document2 closure mission, finding #16 (2026-09-30) — Tax & Cost's
 * user-facing failure messages must never embed an internal identifier.
 *
 * BACKGROUND. lib/engines/investment-intelligence/tax/taxLotEngine.ts and
 * taxOrchestrator.ts throw `Error`s whose message embeds raw internal ids
 * (e.g. "acquisition event <sourceEventId>", "lot <lotId> over-consumed",
 * "disposal <sourceEventId>", "instrument <instrumentKey>"). Three routes —
 * tax/summary, tax/lots, tax/redemption-simulation — used to catch that
 * error and interpolate its `.message` VERBATIM into the client-facing
 * `bad(...)` response body, which TaxIntelligenceClient.tsx then renders
 * directly to the end user (`<NotAvailable text={error} />` / `setError`).
 * A real engine failure could therefore show a database event/lot id
 * straight to a real user — exactly the class of leak the original
 * Document2 review's Tax & Cost screenshot flagged.
 *
 * THE FIX (this pass): all three routes now log the raw engine message
 * server-side only (`console.error`) and return a fixed, clean, generic
 * explanation with no interpolated engine detail.
 *
 * THIS TEST is a deliberately blunt, comment-agnostic source-text guard
 * (same rationale/style as tests/unit/pc5Prohibitions.test.ts and
 * tests/unit/aieIiAdapterProhibitions.test.ts): it does not re-derive the
 * whole tax engine's behaviour, it only prevents a future edit from
 * reintroducing `bad(`...${message}`)`-style interpolation of a caught
 * exception's `.message` into these three routes' user-facing responses.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const ROUTES = [
  join(ROOT, 'app', 'api', 'investment-intelligence', 'tax', 'summary', 'route.ts'),
  join(ROOT, 'app', 'api', 'investment-intelligence', 'tax', 'lots', 'route.ts'),
  join(ROOT, 'app', 'api', 'investment-intelligence', 'tax', 'redemption-simulation', 'route.ts'),
];

// Matches `bad(` ... a template literal that interpolates a caught error's
// own message variable (message / rawMessage / e.message) ... `)`. This is
// intentionally narrow to the exact defect class found (an interpolated
// caught-exception message reaching the client), not a blanket "no template
// literals" rule.
const LEAK_PATTERN = /bad\(\s*`[^`]*\$\{\s*(?:rawMessage|message|e\.message)\s*\}[^`]*`/;

describe('Investment Intelligence tax routes never leak a caught engine error message to the client', () => {
  it.each(ROUTES)('%s does not interpolate a caught exception message into its bad() response', (filePath) => {
    const source = readFileSync(filePath, 'utf8');
    expect(source).not.toMatch(LEAK_PATTERN);
  });

  it('tax/summary/route.ts still logs the raw failure server-side (does not silently swallow it)', () => {
    const source = readFileSync(ROUTES[0], 'utf8');
    expect(source).toMatch(/console\.error\(/);
  });

  it('tax/lots/route.ts still logs the raw failure server-side', () => {
    const source = readFileSync(ROUTES[1], 'utf8');
    expect(source).toMatch(/console\.error\(/);
  });

  it('tax/redemption-simulation/route.ts still logs the raw failure server-side', () => {
    const source = readFileSync(ROUTES[2], 'utf8');
    expect(source).toMatch(/console\.error\(/);
  });

  it('NEGATIVE CONTROL: the guard regex actually fires on the pre-fix pattern (demonstrates it is not vacuous)', () => {
    const preFixExample = 'return bad(`Tax simulation could not be calculated: ${message}`, 500);';
    expect(preFixExample).toMatch(LEAK_PATTERN);
  });
});
