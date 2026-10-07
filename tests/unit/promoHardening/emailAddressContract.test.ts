// Item 5 (canonical address contract) and item 9 (recipient validation): the TypeScript half of the contract, checked
// against the SHARED vector file that the SQL half (public.promo_normalise_email) is checked against in
// tests/unit/promoHardeningPglite.test.ts. Plus the recipient validation that keeps a header injection or a malformed
// address out of the mailer.
//
// NAMED NEGATIVE CONTROLS
//   NC-E1  a normaliser that rewrites Gmail dots and plus tags fails "no gmail rewriting";
//   NC-E2  a normaliser that lower-cases with toLowerCase() (unicode) fails "ASCII only lower case";
//   NC-E3  a validator that forgets to refuse control characters accepts an injected header: "control characters are refused".

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkRecipientAddress, normaliseEmailAddress } from '@/lib/services/emailAddressContract';
import { expectNamedFailure, REPO_ROOT } from '../support/promoTestHelpers';

const VECTORS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'email-normalisation-vectors.json'), 'utf8')) as {
  vectors: { input: string; normalised: string }[];
};

function assertNoGmailRewriting(normalise: (s: string) => string) {
  expect(normalise('First.Last+Tag@Gmail.com'), 'no gmail rewriting').toBe('first.last+tag@gmail.com');
  expect(normalise('a.b@googlemail.com'), 'no gmail rewriting').toBe('a.b@googlemail.com');
}
function assertAsciiOnlyLowerCase(normalise: (s: string) => string) {
  expect(normalise('ÀB@Example.com'), 'ASCII only lower case').toBe('Àb@example.com');
}

describe('normalisation contract (shared vectors)', () => {
  it('every vector in the shared file normalises exactly as written', () => {
    expect(VECTORS.vectors.length).toBeGreaterThanOrEqual(10);
    for (const v of VECTORS.vectors) expect(normaliseEmailAddress(v.input), JSON.stringify(v.input)).toBe(v.normalised);
  });

  it('is idempotent', () => {
    for (const v of VECTORS.vectors) expect(normaliseEmailAddress(v.normalised)).toBe(v.normalised);
  });

  it('NC-E1: a normaliser that rewrites Gmail dots and plus tags is caught', async () => {
    assertNoGmailRewriting(normaliseEmailAddress);
    const gmailRewriter = (s: string) => {
      const base = normaliseEmailAddress(s);
      const [local, domain] = base.split('@');
      return domain === 'gmail.com' ? `${local.replace(/\./g, '').split('+')[0]}@${domain}` : base;
    };
    await expectNamedFailure(() => assertNoGmailRewriting(gmailRewriter), 'no gmail rewriting');
  });

  it('NC-E2: a unicode lower-casing normaliser is caught (SQL lowers ASCII only, so the two must agree)', async () => {
    assertAsciiOnlyLowerCase(normaliseEmailAddress);
    await expectNamedFailure(() => assertAsciiOnlyLowerCase((s) => s.trim().toLowerCase()), 'ASCII only lower case');
  });
});

describe('recipient validation', () => {
  const ok = (a: string) => {
    const r = checkRecipientAddress(a);
    expect(r.ok, a).toBe(true);
    return r.ok ? r.address : '';
  };
  const bad = (a: unknown) => {
    const r = checkRecipientAddress(a);
    expect(r.ok, String(a)).toBe(false);
    return r.ok ? '' : r.reason;
  };

  it('accepts ordinary public addresses and returns them normalised', () => {
    expect(ok('  Person@Example-Mail.COM ')).toBe('person@example-mail.com');
    expect(ok('first.last+tag@sub.mail.co.uk')).toBe('first.last+tag@sub.mail.co.uk');
    expect(ok('a_b-c@x1.io')).toBe('a_b-c@x1.io');
  });

  it('control characters are refused, before any trimming can hide them', () => {
    expect(bad('a@b.com\r\nBcc: victim@x.com')).toBe('control_characters');
    expect(bad('a@b.com\nSubject: hi')).toBe('control_characters');
    expect(bad('a@\u0000b.com')).toBe('control_characters');
    expect(bad('a@b.com x')).toBe('control_characters');
    expect(bad('a@b.com\u0085x')).toBe('control_characters');
  });

  it('header and display-name tricks are refused: angle brackets, commas, quotes, brackets, backslash, colon, spaces', () => {
    for (const a of ['Name <a@b.com>', 'a@b.com, c@d.com', '"a"@b.com', 'a@b.com;c@d.com', 'a(b)@c.com', 'a[b]@c.com', 'a\\b@c.com', 'a:b@c.com', 'a b@c.com']) {
      expect(bad(a), a).toBe('forbidden_characters');
    }
  });

  it('malformed shapes are refused', () => {
    expect(bad('plain')).toBe('malformed');
    expect(bad('@b.com')).toBe('malformed');
    expect(bad('a@b@c.com')).toBe('malformed');
    expect(bad(42)).toBe('malformed');
    expect(bad('')).toBe('empty');
    expect(bad(`${'a'.repeat(250)}@b.com`)).toBe('too_long');
  });

  it('local part and domain rules', () => {
    expect(bad('.a@b.com')).toBe('bad_local_part');
    expect(bad('a.@b.com')).toBe('bad_local_part');
    expect(bad('a..b@c.com')).toBe('bad_local_part');
    expect(bad(`${'a'.repeat(65)}@b.com`)).toBe('bad_local_part');
    for (const d of ['b', 'b.', '.com', 'b..com', '-b.com', 'b-.com', 'b.c', 'b.123', 'b.com-', `${'x'.repeat(64)}.com`]) {
      expect(bad(`a@${d}`), d).toBe('bad_domain');
    }
  });

  it('IP literals, internationalised addresses and reserved top level labels are refused', () => {
    expect(bad('a@1.2.3.4')).toBe('bad_domain');
    expect(bad('a@[1.2.3.4]')).toBe('forbidden_characters');
    expect(bad('üser@example.com')).toBe('forbidden_characters');
    for (const t of ['test', 'example', 'invalid', 'localhost', 'local', 'internal']) expect(bad(`a@b.${t}`), t).toBe('bad_domain');
    expect(ok('a@b.xn--p1ai')).toBe('a@b.xn--p1ai'); // an already-punycoded label is allowed
  });

  it('NC-E3: a validator that forgets the control character rule accepts an injected header', async () => {
    const real = () => expect(checkRecipientAddress('a@b.com\r\nBcc: v@x.com').ok, 'control characters are refused').toBe(false);
    real();
    // a validator that checks only the first line: everything after a line break rides along into the header block
    const firstLine = (a: string) => a.split(String.fromCharCode(10))[0].split(String.fromCharCode(13))[0];
    const forgetful = (a: string) => ({ ok: /^[^@ ]+@[^@ ]+[.][a-z]{2,}$/.test(normaliseEmailAddress(firstLine(a))) });
    await expectNamedFailure(
      () => expect(forgetful('a@b.com\r\nBcc: v@x.com').ok, 'control characters are refused').toBe(false),
      'control characters are refused'
    );
  });
});
