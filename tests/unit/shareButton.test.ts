// Resources social sharing — tests the pure link-building logic behind
// ShareButton.tsx. The component itself is a thin DOM/event wrapper
// (navigator.share, clipboard, a dropdown) around this; what's worth
// testing directly is that each platform gets a correctly-encoded URL.

import { describe, it, expect } from 'vitest';
import { buildShareLinks } from '@/components/resources/public/ShareButton';

describe('buildShareLinks', () => {
  const url = 'https://app.financialhealthplatform.com/resources/understanding-savings-debt-liquidity-ratios';
  const title = 'Understanding Savings, Debt and Liquidity Ratios Together';

  it('produces exactly the 4 expected platforms, in a stable order', () => {
    const links = buildShareLinks(url, title);
    expect(links.map((l) => l.label)).toEqual(['X (Twitter)', 'Facebook', 'LinkedIn', 'WhatsApp']);
  });

  it('every link correctly URL-encodes the canonical URL (no raw special characters leaking through)', () => {
    const links = buildShareLinks(url, title);
    for (const link of links) {
      expect(link.href).toContain(encodeURIComponent(url));
    }
  });

  it('every link that includes a text/title parameter correctly encodes the comma in the title', () => {
    const links = buildShareLinks(url, title);
    const twitter = links.find((l) => l.label === 'X (Twitter)')!;
    const whatsapp = links.find((l) => l.label === 'WhatsApp')!;
    // A raw, unencoded comma would break the query string on some platforms.
    expect(twitter.href).not.toContain(', ');
    expect(twitter.href).toContain(encodeURIComponent(title));
    expect(whatsapp.href).toContain(encodeURIComponent(title));
  });

  it('Facebook only ever needs the URL parameter, never a raw title (matches Facebook Sharer\'s own API contract)', () => {
    const links = buildShareLinks(url, title);
    const facebook = links.find((l) => l.label === 'Facebook')!;
    expect(facebook.href).toBe(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`);
  });

  it('handles a title containing characters that are meaningful in a URL (&, ?, #) without corrupting the query string', () => {
    const trickyTitle = 'Tax & Super: What changed? (2026 update) #FinancialHealth';
    const links = buildShareLinks(url, trickyTitle);
    const twitter = links.find((l) => l.label === 'X (Twitter)')!;
    // The encoded title must appear as a single, intact query value — not
    // split into extra "&"-separated params by an unescaped ampersand.
    expect(twitter.href).toContain(`text=${encodeURIComponent(trickyTitle)}`);
    expect(twitter.href.split('&text=')).toHaveLength(2);
  });
});
