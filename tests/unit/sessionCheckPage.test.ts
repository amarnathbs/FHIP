// /session-check page and the confirm-country change (25-11-2026).
//
// NAMED NEGATIVE CONTROLS
//   NC-S1  the page tells the visitor their data is safe and never names an internal system; its first paint is the waiting state (the retries run in the browser);
//   NC-S2  the destination is sanitised on the server before it reaches the page (no open redirect);
//   NC-S3  a database error on /confirm-country no longer sends the visitor to the blank wizard; "profile incomplete" still does;
//   NC-S4  the page is a public, unindexed route that the proxy's app-route list does not match (so it cannot loop).
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionCheck } from '../../app/(onboarding)/session-check/SessionCheck';

const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('SessionCheck (first paint)', () => {
  const html = renderToStaticMarkup(React.createElement(SessionCheck, { next: '/dashboard' }));

  it('NC-S1: says it is signing the visitor in and that their data is safe and unchanged', () => {
    expect(html).toContain('Signing you in');
    expect(html).toMatch(/safe and have not been changed/);
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-live="polite"/);
    expect(html).toContain('Try now');
  });

  it('NC-S1: names no internal system and no error detail', () => {
    for (const word of ['Supabase', 'PostgREST', 'JWT', 'PGRST', '401', 'token', 'database']) expect(html.toLowerCase()).not.toContain(word.toLowerCase());
  });
});

describe('the page and the routes around it (source checks)', () => {
  it('NC-S2: the page sanitises the destination with safeInternalPath before it reaches the client component', () => {
    const page = read('app/(onboarding)/session-check/page.tsx');
    expect(page).toContain("import { safeInternalPath } from '@/lib/services/profileReadOutcome'");
    expect(page).toContain('safeInternalPath(raw)');
    expect(page).toMatch(/robots:\s*\{\s*index:\s*false/);
  });

  it('NC-S2: the client component only ever navigates to the sanitised prop (never reads the URL itself)', () => {
    const client = read('app/(onboarding)/session-check/SessionCheck.tsx');
    expect(client).toContain('window.location.assign(next)');
    expect(client).not.toMatch(/location\.search|URLSearchParams|document\.referrer/);
  });

  it('NC-S3: confirm-country sends a database ERROR to the retry page and keeps "profile incomplete" going to /onboarding', () => {
    const page = read('app/(onboarding)/confirm-country/page.tsx');
    expect(page).toContain("if (gate.state === 'PROFILE_INCOMPLETE') redirect('/onboarding');");
    expect(page).toContain("if (gate.state === 'DB_ERROR') redirect(sessionCheckUrl('/confirm-country'));");
    expect(page).not.toMatch(/PROFILE_INCOMPLETE'\s*\|\|\s*gate\.state === 'DB_ERROR'/);
  });

  it('NC-S4: the proxy\'s app-route list does not match /session-check', () => {
    const proxy = read('proxy.ts');
    const m = proxy.match(/const isAppRoute = pathname\.match\(\s*(\/\^[^\n]+\/)\s*\)/);
    expect(m).not.toBeNull();
    const re = new RegExp(m![1].slice(1, m![1].lastIndexOf('/')));
    expect(re.test('/session-check')).toBe(false);
    expect(re.test('/dashboard')).toBe(true);
  });
});
