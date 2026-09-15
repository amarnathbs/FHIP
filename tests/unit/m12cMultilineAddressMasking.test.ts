/**
 * M12C — `M3-OPEN-2`: BOUNDED MULTI-LINE ADDRESS MASKING.
 *
 * WHAT WAS OPEN, AND WHY IT WAS NOT CLOSED EARLIER. `lib/aie/masking/
 * piiMasking.ts`'s address rule was deliberately first-line-only, and said so
 * in place: "a postal address printed across several lines is masked on its
 * FIRST line only ... Lines two and three of a wrapped address still reach the
 * provider." The stated reason for not extending it was that an unbounded
 * newline capture "would run on and swallow the next labelled field" — the
 * exact over-capture failure the folio rule already had to be narrowed for
 * during M2. That reasoning is correct and is NOT overturned here. What M12C
 * adds is the third option the original comment did not consider: a BOUNDED
 * continuation, capped in both directions and terminated by explicit
 * stop-conditions, so lines two-to-four are covered without the rule ever
 * becoming open-ended.
 *
 * Every test below therefore asserts BOTH halves of the trade: the address
 * lines are gone AND the thing that follows them survives intact. A test that
 * only asserted the first half would pass just as happily against an unbounded
 * `[\s\S]*` regex, which is precisely the implementation this item forbids.
 *
 * Every address, name and identifier in this file is invented for the fixture.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { maskText, containsUnmaskedPii } from '@/lib/aie/masking/piiMasking';

const TEST_KEY = 'a1'.repeat(32);
const TENANT = { tenantKey: 'user-m12c-address-0001' };

let originalKey: string | undefined;

beforeAll(() => {
  originalKey = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
  else process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = originalKey;
});

/** Collected so the guard-lockstep test can loop EVERY input this file
 * exercises rather than a hand-picked subset — the desynchronisation M12B-F2
 * was caused by only shows up on inputs nobody thought to re-check. */
const ALL_INPUTS: Array<{ name: string; text: string }> = [];
function input(name: string, text: string): string {
  ALL_INPUTS.push({ name, text });
  return text;
}

describe('M12C — M3-OPEN-2: bounded multi-line address masking', () => {
  // ---- 1. REGRESSION. The single-line behaviour M3 shipped must be
  // byte-for-byte unchanged: same masking, same coverage count, label kept.
  it('1-line address — unchanged: masked, label kept, counts exactly 1', () => {
    const text = input('1-line', 'Residential Address: 14 Marigold Avenue, Indiranagar, Bengaluru 560038');
    const result = maskText(text, TENANT);
    expect(result.maskedText).not.toContain('14 Marigold Avenue');
    expect(result.maskedText).not.toContain('Indiranagar');
    expect(result.maskedText).not.toContain('560038');
    expect(result.maskedText).toContain('Residential Address:');
    expect(result.coverageByType.address_label).toBe(1);
  });

  // ---- 2. TWO-LINE. Pre-M12C this FAILED: line 2 reached the provider
  // verbatim.
  it('2-line address — the continuation line is masked too, as ONE address (count 1)', () => {
    const text = input('2-line', ['Residential Address: 14 Marigold Avenue', 'Indiranagar, Bengaluru 560038'].join('\n'));
    const result = maskText(text, TENANT);
    expect(result.maskedText).not.toContain('14 Marigold Avenue');
    // THE assertion that was red before M12C.
    expect(result.maskedText).not.toContain('Indiranagar');
    expect(result.maskedText).not.toContain('560038');
    expect(result.maskedText).toContain('Residential Address:');
    // DOCUMENTED COUNTING DECISION: one address FIELD is one match, however
    // many lines it wraps onto. See the rule's comment in piiMasking.ts.
    expect(result.coverageByType.address_label).toBe(1);
    expect(result.distinctIdentifierCount).toBe(1);
  });

  // ---- 3. FOUR-LINE (label line + 3 continuation lines = the cap).
  it('4-line address — all four lines masked as ONE address at the documented cap', () => {
    const text = input(
      '4-line',
      [
        'Correspondence Address: Flat 7B, Sunrise Residency',
        '12 Marigold Avenue',
        'Indiranagar',
        'Bengaluru, Karnataka 560038',
      ].join('\n'),
    );
    const result = maskText(text, TENANT);
    for (const fragment of ['Flat 7B', 'Sunrise Residency', '12 Marigold Avenue', 'Indiranagar', 'Karnataka', '560038']) {
      expect(result.maskedText).not.toContain(fragment);
    }
    expect(result.maskedText).toContain('Correspondence Address:');
    expect(result.coverageByType.address_label).toBe(1);
  });

  // ---- 4. STOP AT THE NEXT RECOGNISED FINANCIAL FIELD. Both halves are
  // asserted: the label AND its value must survive. This is the test that
  // fails against an unbounded newline regex.
  it('stops at the next financial field — BOTH the label and its value survive unmasked', () => {
    const text = input(
      'address-then-financial-field',
      [
        'Permanent Address: 14 Marigold Avenue',
        'Indiranagar, Bengaluru 560038',
        'Sum Insured: 12,50,000.00',
        'Premium: 3,450.00',
        'Currency: INR',
      ].join('\n'),
    );
    const result = maskText(text, TENANT);
    // Address half: gone.
    expect(result.maskedText).not.toContain('14 Marigold Avenue');
    expect(result.maskedText).not.toContain('Indiranagar');
    // Financial half: BOTH the label and the money survive.
    expect(result.maskedText).toContain('Sum Insured:');
    expect(result.maskedText).toContain('12,50,000.00');
    expect(result.maskedText).toContain('Premium:');
    expect(result.maskedText).toContain('3,450.00');
    expect(result.maskedText).toContain('Currency: INR');
    expect(result.coverageByType.address_label).toBe(1);
    // The newline structure below the address is preserved: the three
    // surviving fields are still three separate lines.
    expect(result.maskedText.split('\n').filter((l) => l.includes(':')).length).toBeGreaterThanOrEqual(4);
  });

  // ---- 4b. A MONEY-SHAPED continuation line is not address continuation even
  // when it carries no label at all.
  it('a money-shaped line immediately after the address is NOT consumed', () => {
    const text = input(
      'address-then-bare-money',
      ['Address: 14 Marigold Avenue', 'Indiranagar 560038', '12,50,000.00', 'TRAILING-MARKER-A'].join('\n'),
    );
    const result = maskText(text, TENANT);
    expect(result.maskedText).not.toContain('Indiranagar');
    expect(result.maskedText).toContain('12,50,000.00');
    expect(result.maskedText).toContain('TRAILING-MARKER-A');
  });

  // ---- 4c. A DATE-LED line is not address continuation.
  it('a date-led line immediately after the address is NOT consumed', () => {
    const text = input(
      'address-then-date',
      ['Address: 14 Marigold Avenue', 'Indiranagar 560038', '31/08/2027 renewal effective', 'TRAILING-MARKER-B'].join('\n'),
    );
    const result = maskText(text, TENANT);
    expect(result.maskedText).not.toContain('Indiranagar');
    expect(result.maskedText).toContain('31/08/2027 renewal effective');
    expect(result.maskedText).toContain('TRAILING-MARKER-B');
  });

  // ---- 4c-bis. THE NEAR-MISS THIS ITEM ACTUALLY HIT, pinned so it cannot
  // come back. The first draft of the date-led stop-condition was
  // `\d{1,2}\s+(jan|feb|mar|...)`, and because the whole rule runs
  // case-insensitively it matched "12 Mar" INSIDE `12 Marigold Avenue` — so
  // the 4-line test went red in a new way: the address stopped dead on its
  // second line. Both halves are asserted here: a house number followed by a
  // month-prefixed street name is NOT a date, and a real spelled-out date
  // still IS one.
  it('a house number + month-prefixed street name is not mistaken for a date, but a real spelled-out date still stops', () => {
    const notADate = input(
      'month-prefixed-street-name',
      ['Address: Flat 7B, Sunrise Residency', '12 Marigold Avenue', '3 Junction Parade', 'Bengaluru 560038'].join('\n'),
    );
    const consumed = maskText(notADate, TENANT);
    expect(consumed.maskedText).not.toContain('12 Marigold Avenue');
    expect(consumed.maskedText).not.toContain('3 Junction Parade');
    expect(consumed.maskedText).not.toContain('Bengaluru 560038');

    const realDate = input(
      'spelled-out-date-line',
      ['Address: 14 Marigold Avenue', 'Indiranagar 560038', '31 March 2027 renewal effective', 'TRAILING-MARKER-D'].join('\n'),
    );
    const stopped = maskText(realDate, TENANT);
    expect(stopped.maskedText).not.toContain('Indiranagar');
    expect(stopped.maskedText).toContain('31 March 2027 renewal effective');
    expect(stopped.maskedText).toContain('TRAILING-MARKER-D');
  });

  // ---- 4d. A BLANK LINE is a section boundary.
  it('a blank line ends the address — nothing past the section boundary is consumed', () => {
    const text = input(
      'address-then-blank',
      ['Address: 14 Marigold Avenue', 'Indiranagar 560038', '', 'BELOW-THE-BLANK-LINE', 'STILL-BELOW'].join('\n'),
    );
    const result = maskText(text, TENANT);
    expect(result.maskedText).not.toContain('Indiranagar');
    expect(result.maskedText).toContain('BELOW-THE-BLANK-LINE');
    expect(result.maskedText).toContain('STILL-BELOW');
  });

  // ---- 5. STOP AT A TABLE. The header AND the row must both survive: a
  // holdings table is the evidence the adapter exists to read.
  it('stops at a table header — the whole table survives unmasked', () => {
    const text = input(
      'address-then-table',
      [
        'Mailing Address: 14 Marigold Avenue',
        'Indiranagar, Bengaluru 560038',
        'Scheme Name          Units        NAV',
        'Nippon India Liquid  1234.567     100.25',
        'Kotak Flexicap       890.120       58.40',
      ].join('\n'),
    );
    const result = maskText(text, TENANT);
    expect(result.maskedText).not.toContain('14 Marigold Avenue');
    expect(result.maskedText).not.toContain('Indiranagar');
    expect(result.maskedText).toContain('Scheme Name');
    expect(result.maskedText).toContain('Units');
    expect(result.maskedText).toContain('NAV');
    expect(result.maskedText).toContain('Nippon India Liquid');
    expect(result.maskedText).toContain('1234.567');
    expect(result.maskedText).toContain('Kotak Flexicap');
    expect(result.maskedText).toContain('58.40');
    expect(result.coverageByType.address_label).toBe(1);
  });

  // ---- 6. THE OVER-CAPTURE ATTACK. A 200-line block after `Address:` with no
  // label, no blank line, no money and no date — i.e. every stop-condition
  // except the line cap is deliberately withheld, so ONLY the cap can save us.
  // This is the test an unbounded `[\s\S]*` implementation cannot pass.
  it('a malicious 200-line block after "Address:" consumes AT MOST 3 continuation lines', () => {
    const filler = Array.from({ length: 200 }, (_, i) => `LINE-${String(i + 1).padStart(4, '0')} filler prose with no label`);
    const text = input('malicious-200-line-block', ['Address: 1 Attack Street', ...filler, 'CANARY-SURVIVES-UNTOUCHED'].join('\n'));
    const result = maskText(text, TENANT);

    expect(result.maskedText).not.toContain('1 Attack Street');
    // EXACT upper bound: label line + 3 continuation lines. Lines 1-3 are
    // consumed; line 4 onward must be untouched.
    expect(result.maskedText).not.toContain('LINE-0001');
    expect(result.maskedText).not.toContain('LINE-0002');
    expect(result.maskedText).not.toContain('LINE-0003');
    expect(result.maskedText).toContain('LINE-0004');
    expect(result.maskedText).toContain('LINE-0100');
    expect(result.maskedText).toContain('LINE-0200');
    // Exactly 197 of the 200 filler lines survive — an exact count, not a
    // "greater than zero" smoke check.
    expect([...result.maskedText.matchAll(/LINE-\d{4}/g)]).toHaveLength(197);
    // Text far below the block is untouched.
    expect(result.maskedText).toContain('CANARY-SURVIVES-UNTOUCHED');
    // And it is still ONE address, not 4.
    expect(result.coverageByType.address_label).toBe(1);
  });

  // ---- 7. `Email Address:` is still never an address, multi-line or not.
  it('"Email Address:" is still classified as an email and claims no continuation line', () => {
    const text = input(
      'email-address-label',
      ['Email Address: investor@example.com', 'Indiranagar, Bengaluru 560038', 'NEXT-LINE-MARKER'].join('\n'),
    );
    const result = maskText(text, TENANT);
    expect(result.maskedText).not.toContain('investor@example.com');
    expect(result.coverageByType.email).toBe(1);
    expect(result.coverageByType.address_label ?? 0).toBe(0);
    // The lookbehind must also stop the rule claiming the line BELOW it.
    expect(result.maskedText).toContain('Indiranagar, Bengaluru 560038');
    expect(result.maskedText).toContain('NEXT-LINE-MARKER');
  });

  // ---- 8. An EMPTY address label still cannot claim the next line (the M12B
  // `[^\S\r\n]*` property). A continuation only exists once a first-line value
  // exists.
  it('an EMPTY "Residential Address:" line still claims nothing', () => {
    const text = input('empty-address-label', ['Residential Address:', 'Sum Insured: 12,50,000.00', 'Currency: INR'].join('\n'));
    const result = maskText(text, TENANT);
    expect(result.maskedText).toContain('Sum Insured:');
    expect(result.maskedText).toContain('12,50,000.00');
    expect(result.coverageByType.address_label ?? 0).toBe(0);
  });

  // ---- 9. A COLON-LESS field line still stops the capture, and the field it
  // introduces is still detected and counted as ITSELF. This is the
  // `coverage_by_type` half of the over-capture worry: swallowing `PAN
  // ABCDE1234F` into the address token would still have "masked" it, but the
  // privacy evidence would then say the document held one address and no tax
  // id, which is untrue.
  it('a colon-less "PAN <value>" line stops the address AND is still counted as a tax_id in its own right', () => {
    const text = input(
      'colon-less-field-line',
      ['Address: 14 Marigold Avenue', 'Indiranagar 560038', 'PAN ABCDE1234F', 'TRAILING-MARKER-C'].join('\n'),
    );
    const result = maskText(text, TENANT);
    expect(result.maskedText).not.toContain('14 Marigold Avenue');
    expect(result.maskedText).not.toContain('Indiranagar');
    expect(result.maskedText).not.toContain('ABCDE1234F');
    // The PAN label survived and the value was bucketed correctly.
    expect(result.maskedText).toContain('PAN [MASKED:tax_id:');
    expect(result.coverageByType.tax_id).toBe(1);
    expect(result.coverageByType.address_label).toBe(1);
    // No token-of-a-token anywhere.
    expect(result.maskedText).not.toContain('[MASKED:address_label:hmac:[MASKED:');
    expect(result.maskedText).toContain('TRAILING-MARKER-C');
  });

  // ---- 9b. THE PER-LINE CHARACTER BOUND. An over-long line is not consumed
  // AT ALL rather than being truncated mid-line: a 120-character prefix in the
  // token with the tail left behind would destroy structure without protecting
  // anything.
  it('a continuation line longer than the per-line bound is not consumed at all — never truncated mid-line', () => {
    const longLine = `${'x'.repeat(200)} TAIL-MARKER`;
    const text = input('over-long-continuation-line', ['Address: 14 Marigold Avenue', longLine, 'AFTER-LONG-LINE'].join('\n'));
    const result = maskText(text, TENANT);
    expect(result.maskedText).not.toContain('14 Marigold Avenue');
    // The whole long line survives intact — no prefix of it went into a token.
    expect(result.maskedText).toContain(longLine);
    expect(result.maskedText).toContain('AFTER-LONG-LINE');
    expect(result.coverageByType.address_label).toBe(1);
  });

  // ---- 9c. Already-masked content on a continuation line. Reaching this
  // state needs an EARLIER rule in `PII_PATTERNS` to have fired — the folio
  // rule runs before the address rule — so this is the real ordering, not a
  // hypothetical.
  it('a continuation line already carrying a placeholder stops the capture rather than being MAC-ed twice', () => {
    const text = input(
      'continuation-carries-placeholder',
      ['Address: 14 Marigold Avenue', 'Folio No: 12345678/90', 'TRAILING-MARKER-E'].join('\n'),
    );
    const result = maskText(text, TENANT);
    expect(result.maskedText).not.toContain('12345678/90');
    expect(result.maskedText).toContain('Folio No:');
    expect(result.coverageByType.folio_number).toBe(1);
    expect(result.coverageByType.address_label).toBe(1);
    expect(result.maskedText).not.toContain('[MASKED:address_label:hmac:[MASKED:');
    expect(result.maskedText).toContain('TRAILING-MARKER-E');
  });

  // ---- 10. GUARD LOCKSTEP. `containsUnmaskedPii` re-reads the same
  // `PiiPattern` fields; if the multi-line mechanism had been bolted on
  // OUTSIDE that interface the two would silently disagree. Loop EVERY input
  // above in both directions.
  it('containsUnmaskedPii agrees with maskText on every input in this file', () => {
    expect(ALL_INPUTS.length).toBeGreaterThanOrEqual(10);
    for (const { name, text } of ALL_INPUTS) {
      const masked = maskText(text, TENANT).maskedText;
      // The guard must find NOTHING residual in text maskText declared done.
      expect(containsUnmaskedPii(masked), `guard flagged fully-masked text for "${name}"`).toBe(false);
      // Masking is idempotent: a second pass finds nothing left to mask.
      const second = maskText(masked, TENANT);
      expect(second.totalMatches, `second masking pass found new matches for "${name}"`).toBe(0);
      expect(second.maskedText, `second masking pass changed the text for "${name}"`).toBe(masked);
    }
  });

  // ---- 11. NO CATASTROPHIC BACKTRACKING. The continuation guards include a
  // nested-quantifier lookahead (the 3-column table check) and an ~80-way stop
  // term alternation, both applied per candidate line — worth pinning, because
  // this rule runs on WHOLE extracted documents (`orchestrator.ts` masks the
  // entire text before any adapter is chosen) and a quadratic blow-up here
  // would be a denial of service reachable by uploading a PDF. The bound is
  // deliberately loose (measured 2-11ms for all five inputs on the dev machine
  // this was written on) so it flags an order-of-magnitude regression rather
  // than machine-speed noise.
  it('does not backtrack catastrophically on adversarial documents', () => {
    const adversarial = [
      Array.from({ length: 1000 }, () => 'Residential Address: 14 Marigold Avenue\nIndiranagar\nBengaluru 560038\nSum Insured: 1,000.00').join('\n'),
      `Address: 1 Attack Street\n${Array.from({ length: 5000 }, (_, i) => `LINE-${i} filler prose with no label`).join('\n')}`,
      `Address: 1 Attack Street\n${'a b  '.repeat(20000)}`,
      `Address: 1 Attack Street\n${Array.from({ length: 2000 }, () => `${'a'.repeat(100)}  `).join('')}`,
      `Address: 1 Attack Street\n${Array.from({ length: 2000 }, () => 'q'.repeat(119)).join('\n')}`,
    ];
    for (const text of adversarial) {
      const started = Date.now();
      const masked = maskText(text, TENANT).maskedText;
      containsUnmaskedPii(masked);
      expect(Date.now() - started, `slow on a ${text.length}-char document`).toBeLessThan(5000);
    }
  }, 60_000);

  it('containsUnmaskedPii still flags a RAW multi-line address — fail-closed is preserved', () => {
    // The direction that proves the guard did not merely get quieter.
    const raw = ['Residential Address: 14 Marigold Avenue', 'Indiranagar, Bengaluru 560038'].join('\n');
    expect(containsUnmaskedPii(raw)).toBe(true);
  });
});
