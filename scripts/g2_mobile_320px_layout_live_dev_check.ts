/**
 * Country programme mission, section 6: "Test mobile and desktop layouts,
 * including the previously sensitive 320px width." Real browser viewport
 * resize against the real running landing page with G2 active, checking
 * for horizontal overflow (the exact class of regression "previously
 * sensitive" implies) at 320px, a common small-phone width, plus 375px
 * and desktop for comparison.
 *
 * Run: npx tsx scripts/g2_mobile_320px_layout_live_dev_check.ts [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3903';
let passed = 0, failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}` + (detail !== undefined ? ` -- ${JSON.stringify(detail)}` : '')); }
}

async function main() {
  const browser = await chromium.launch();
  try {
    for (const { width, height, label } of [
      { width: 320, height: 568, label: '320px (previously sensitive small-phone width)' },
      { width: 375, height: 812, label: '375px (common phone width)' },
      { width: 768, height: 1024, label: '768px (tablet)' },
      { width: 1440, height: 900, label: '1440px (desktop)' },
    ]) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.goto(`${BASE}/`);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      check(`${label}: no horizontal overflow`, !overflow, { scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth), clientWidth: await page.evaluate(() => document.documentElement.clientWidth) });

      const combo = page.getByRole('combobox', { name: 'Experience' });
      check(`${label}: the country selector is present and visible`, await combo.isVisible().catch(() => false));
      await context.close();
    }
  } finally {
    await browser.close();
    console.log(`\n=== SUMMARY: ${passed}/${passed + failed} checks passed ===`);
    if (failed > 0) process.exitCode = 1;
  }
}

main();
