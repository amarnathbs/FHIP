// Real-browser certification of the public Resource Share journey (Chromium
// engine, phone-sized viewports with touch emulation). It cannot prove
// physical iOS Safari behaviour -- WebKit rendering and the real iOS share
// sheet are out of reach here -- but it does prove the layout geometry, the
// Web Share / fallback / Copy link behaviour, and the logged-out recipient
// journey against a real running app.
//
//   RESOURCE_SHARE_BASE_URL (default http://localhost:3989)
//   RESOURCE_SHARE_SLUG     a published Resource slug on that server
//   RESOURCE_SHARE_SHOTS    optional directory for screenshots

import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = (process.env.RESOURCE_SHARE_BASE_URL ?? 'http://localhost:3989').replace(/\/$/, '');
const SLUG = process.env.RESOURCE_SHARE_SLUG ?? 'r1-5-test-live-money-update-1787551600623';
const SHOTS = process.env.RESOURCE_SHARE_SHOTS;
const ARTICLE_URL = `${BASE}/resources/${SLUG}`;

// iPhone-class (Safari) and Android-class (Chrome) portrait widths, plus the
// narrow/wide extremes and one landscape.
const PHONES = [
  { name: 'narrow-320', width: 320, height: 640 },
  { name: 'android-360', width: 360, height: 780 },
  { name: 'iphone-375', width: 375, height: 667 },
  { name: 'iphone-390', width: 390, height: 844 },
  { name: 'iphone-393', width: 393, height: 852 },
  { name: 'android-412', width: 412, height: 915 },
  { name: 'iphone-414', width: 414, height: 896 },
  { name: 'iphone-430', width: 430, height: 932 },
  { name: 'landscape-844', width: 844, height: 390 },
];

type ShareWindow = { __shares: Array<{ title: string; text: string; url: string }>; __mode: string };

async function phoneContext(browser: Browser, width: number, height: number) {
  return browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
}

async function noHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bsw: document.body.scrollWidth }));
  expect(m.sw, `documentElement.scrollWidth ${m.sw} > clientWidth ${m.cw}`).toBeLessThanOrEqual(m.cw + 1);
  expect(m.bsw).toBeLessThanOrEqual(m.cw + 1);
}

function panelLocator(page: Page) {
  return page.getByRole('dialog', { name: 'Share this article' }).or(page.getByRole('menu', { name: 'Share this article' }));
}

async function panelBox(page: Page) {
  const panel = panelLocator(page);
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  const vw = await page.evaluate(() => document.documentElement.clientWidth);
  return { box: box!, vw };
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function installShareMock(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as ShareWindow;
    w.__shares = [];
    w.__mode = 'ok';
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value(data: { title: string; text: string; url: string }) {
        w.__shares.push(data);
        if (w.__mode === 'abort') return Promise.reject(new DOMException('Share canceled', 'AbortError'));
        if (w.__mode === 'deny') return Promise.reject(new DOMException('denied', 'NotAllowedError'));
        return Promise.resolve();
      },
    });
  });
}

test.describe('Resource Share - phone viewports, fallback panel (no Web Share API)', () => {
  for (const vp of PHONES.flatMap((p) => (p.width < 640 ? [{ ...p, wrap: false }, { ...p, wrap: true }] : [{ ...p, wrap: false }]))) {
    test(`${vp.name}${vp.wrap ? ' (Share forced to the LEFT edge, wrapped layout of the PO article)' : ''}: panel fully inside the viewport, Copy link copies the canonical URL, recipient opens the same article`, async ({ browser }) => {
      const ctx = await phoneContext(browser, vp.width, vp.height);
      const page = await ctx.newPage();
      // Simulate a browser without the Web Share API.
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
      });
      await page.goto(ARTICLE_URL);
      const h1 = (await page.locator('h1').first().innerText()).trim();
      if (vp.wrap) {
        await page.waitForLoadState('networkidle'); // let React hydrate before touching the DOM
        // Worst case from the production article: the wide chip row pushes Share
        // onto its own line at the LEFT of the header. The sheet must not care.
        await page.evaluate(() => {
          const wrapper = Array.from(document.querySelectorAll('article header button')).find((b) => b.textContent?.trim() === 'Share')!.parentElement as HTMLElement;
          const row = wrapper.parentElement as HTMLElement;
          (row.firstElementChild as HTMLElement).style.flexBasis = '100%';
          wrapper.style.marginLeft = '0';
          wrapper.style.marginRight = 'auto';
        });
        const sx = await page.getByRole('button', { name: 'Share', exact: true }).evaluate((b) => b.getBoundingClientRect().left);
        expect(sx, 'Share is on the left side of the header').toBeLessThan(80);
      }
      await noHorizontalOverflow(page);

      const share = page.getByRole('button', { name: 'Share', exact: true });
      await expect(share).toBeVisible();
      await expect(share).toHaveAttribute('aria-expanded', 'false');
      await share.tap();
      await expect(share).toHaveAttribute('aria-expanded', 'true');

      const { box, vw } = await panelBox(page);
      await shot(page, `fallback-${vp.name}${vp.wrap ? '-wrapped' : ''}`);
      expect(box.x, 'panel left edge').toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, 'panel right edge').toBeLessThanOrEqual(vw);
      const vh = await page.evaluate(() => window.innerHeight);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(vh + 1);
      await noHorizontalOverflow(page);

      // Touch targets of the panel actions are at least 44px tall on phones.
      const heights = await panelLocator(page).locator('a, button').evaluateAll((els) => els.map((e) => (e as HTMLElement).getBoundingClientRect().height));
      for (const h of heights.filter((x) => x > 0)) expect(h).toBeGreaterThanOrEqual(43.5);

      await page.getByRole('button', { name: 'Copy link' }).tap();
      await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toBe(ARTICLE_URL);

      // Recipient: a fresh, logged-out, cookie-less browser context.
      const recipient = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: true, hasTouch: true });
      const rp = await recipient.newPage();
      const resp = await rp.goto(copied);
      expect(resp?.status()).toBe(200);
      expect(rp.url()).toBe(ARTICLE_URL);
      expect((await rp.locator('h1').first().innerText()).trim()).toBe(h1);
      await rp.reload();
      expect((await rp.locator('h1').first().innerText()).trim()).toBe(h1);
      await noHorizontalOverflow(rp);
      await recipient.close();
      await ctx.close();
    });
  }
});

test.describe('Resource Share - native Web Share on a touch device', () => {
  for (const vp of PHONES.filter((p) => ['iphone-375', 'iphone-390', 'iphone-393', 'android-360', 'android-412'].includes(p.name))) {
    test(`${vp.name}: tap calls navigator.share once with exact title/text/url; cancellation shows nothing`, async ({ browser }) => {
      const ctx = await phoneContext(browser, vp.width, vp.height);
      const page = await ctx.newPage();
      await installShareMock(page);
      await page.goto(ARTICLE_URL);
      const h1 = (await page.locator('h1').first().innerText()).trim();
      const share = page.getByRole('button', { name: 'Share', exact: true });

      await share.tap();
      const shares = await page.evaluate(() => (window as unknown as ShareWindow).__shares);
      expect(shares).toHaveLength(1);
      expect(shares[0].title).toBe(h1);
      expect(shares[0].url).toBe(ARTICLE_URL);
      expect(shares[0].text.length).toBeGreaterThan(0);
      expect(shares[0].text.length).toBeLessThanOrEqual(200);
      await expect(panelLocator(page)).toHaveCount(0);

      // User cancels the OS sheet: no error text, no panel.
      await page.evaluate(() => ((window as unknown as ShareWindow).__mode = 'abort'));
      await share.tap();
      await page.waitForTimeout(300);
      await expect(panelLocator(page)).toHaveCount(0);
      await expect(page.getByText(/share failed|could not|error/i)).toHaveCount(0);

      // Browser refuses (not a cancellation): the in-page panel opens instead.
      await page.evaluate(() => ((window as unknown as ShareWindow).__mode = 'deny'));
      await share.tap();
      const { box, vw } = await panelBox(page);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vw);
      await ctx.close();
    });
  }
});

test.describe('Resource Share - keyboard and dismissal', () => {
  test('desktop: popover inside viewport, Escape closes and returns focus to Share; outside click closes; the OS sheet only when chosen', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await installShareMock(page);
    await page.goto(ARTICLE_URL);
    const share = page.getByRole('button', { name: 'Share', exact: true });
    await share.focus();
    await page.keyboard.press('Enter');
    // Desktop (fine pointer) opens the in-page panel even though navigator.share exists.
    const { box, vw } = await panelBox(page);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vw);
    expect(await page.evaluate(() => (window as unknown as ShareWindow).__shares.length)).toBe(0);
    await expect(page.getByRole('button', { name: 'Copy link' })).toBeFocused();
    await shot(page, 'desktop-popover');
    await page.keyboard.press('Escape');
    await expect(panelLocator(page)).toHaveCount(0);
    await expect(share).toBeFocused();
    await expect(share).toHaveAttribute('aria-expanded', 'false');

    await share.click();
    await expect(panelLocator(page)).toBeVisible();
    await page.mouse.click(5, 400);
    await expect(panelLocator(page)).toHaveCount(0);

    await share.focus();
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: /More options/ }).click();
    expect(await page.evaluate(() => (window as unknown as ShareWindow).__shares.length)).toBe(1);
    await ctx.close();
  });

  test('phone: Escape, the sheet Close button and a backdrop tap close the sheet; focus returns to Share', async ({ browser }) => {
    const ctx = await phoneContext(browser, 390, 844);
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
    });
    await page.goto(ARTICLE_URL);
    const share = page.getByRole('button', { name: 'Share', exact: true });
    await share.tap();
    await page.keyboard.press('Escape');
    await expect(share).toBeFocused();
    await share.tap();
    await page.getByRole('button', { name: 'Close share options' }).tap();
    await expect(panelLocator(page)).toHaveCount(0);
    await expect(share).toBeFocused();
    await share.tap();
    await page.touchscreen.tap(195, 40);
    await expect(panelLocator(page)).toHaveCount(0);
    await ctx.close();
  });
});

test.describe('Resource page - mobile layout with Share closed', () => {
  for (const vp of PHONES) {
    test(`${vp.name}: no horizontal overflow, article inside viewport`, async ({ browser }) => {
      const ctx = await phoneContext(browser, vp.width, vp.height);
      const page = await ctx.newPage();
      await page.goto(ARTICLE_URL);
      await noHorizontalOverflow(page);
      const art = await page.locator('article').first().boundingBox();
      expect(art!.x).toBeGreaterThanOrEqual(0);
      expect(art!.x + art!.width).toBeLessThanOrEqual(vp.width);
      await shot(page, `closed-${vp.name}`);
      await ctx.close();
    });
  }
});

test.describe('Resource page - canonical metadata and recipient journey (logged out)', () => {
  test('canonical, og:url and the shared URL are the same public URL; direct, reload and Back all show the same article', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const resp = await page.goto(ARTICLE_URL);
    expect(resp?.status()).toBe(200);
    expect(page.url()).toBe(ARTICLE_URL);
    expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe(ARTICLE_URL);
    expect(await page.locator('meta[property="og:url"]').getAttribute('content')).toBe(ARTICLE_URL);
    expect(await page.locator('meta[property="og:title"]').getAttribute('content')).toBeTruthy();
    const h1 = (await page.locator('h1').first().innerText()).trim();

    await page.goto(`${BASE}/resources`);
    await page.goBack();
    expect((await page.locator('h1').first().innerText()).trim()).toBe(h1);
    await page.reload();
    expect((await page.locator('h1').first().innerText()).trim()).toBe(h1);
    expect(new URL(page.url()).pathname).toBe(`/resources/${SLUG}`);
    expect(page.url()).not.toContain('/login');
    await ctx.close();
  });
});
