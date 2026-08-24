import { chromium } from 'playwright';
import crypto from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';

// Same base-URL convention as the test harnesses' HARNESS_BASE_URL — this
// server always renders against itself, so a plain env var (not
// NEXT_PUBLIC_*, since it's server-only) with a localhost dev default is
// enough; production deploys set APP_BASE_URL explicitly.
const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const RENDER_TOKEN_TTL_MS = 5 * 60 * 1000;

// Renders the report's print view (app/(app)/reports/[id]/print) to a PDF
// using Playwright's headless Chromium — reuses the exact same charts/CSS
// already built for on-screen viewing and browser printing, rather than
// standing up a second rendering stack. The render_token is single-use:
// minted just before navigation, cleared immediately after (success or
// failure) regardless of its 5-minute TTL.
export async function renderReportToPdf(reportId: string, exportId: string): Promise<{ buffer: Buffer; checksum: string }> {
  const admin = createAdminClient();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RENDER_TOKEN_TTL_MS).toISOString();
  const { error: tokenError } = await admin
    .from('report_exports')
    .update({ render_token: token, render_token_expires_at: expiresAt })
    .eq('id', exportId);
  if (tokenError) throw new Error(`Could not prepare render token: ${tokenError.message}`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const url = `${BASE_URL}/reports/${reportId}/print?token=${token}`;
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    if (!response || !response.ok()) {
      throw new Error(`Print route returned ${response?.status() ?? 'no response'} for ${url}`);
    }
    // Belt-and-braces: page.pdf() switches Chromium to print media
    // internally at capture time regardless, but emulating it explicitly
    // here means anything print-CSS-driven (report-print-root padding
    // compaction etc.) has already settled before the readiness wait below
    // runs, rather than changing out from under a capture that assumed
    // screen-media layout.
    await page.emulateMedia({ media: 'print' });
    // 'networkidle' only guarantees requests have settled — it says
    // nothing about whether React has even mounted yet, let alone whether
    // Recharts' ResponsiveContainer has finished its ResizeObserver-driven
    // layout pass. The naive version of this wait (`if svgs.length === 0
    // return true`) was a false-ready trap: immediately after goto(), the
    // charts haven't hydrated at all yet, so that selector legitimately
    // returns zero elements — indistinguishable, to a single check, from
    // "this page genuinely has no charts". The old code treated both as
    // "ready" and proceeded immediately, so page.pdf() reliably captured
    // every report mid-hydration, before a single chart had mounted —
    // every bar, pie and line chart came out completely blank (confirmed
    // via the PDF's own extracted vector content: zero paint operations in
    // the chart region, not just wrong-looking ones) even though a plain
    // DOM inspection moments later, once hydration had caught up, showed
    // perfectly well-formed SVG geometry. Requiring the same "ready or
    // genuinely chart-free" reading to hold for a run of consecutive polls
    // (~1.5s of stability) distinguishes real emptiness from not-yet-
    // mounted, without hardcoding a single fixed sleep that would be too
    // short under load and wastefully long otherwise. A timeout here is
    // still treated as non-fatal — proceed with whatever rendered rather
    // than failing the whole export over one slow chart.
    await page
      .waitForFunction(
        () => {
          const svgs = document.querySelectorAll('.recharts-wrapper svg');
          // Both dimensions, not just width — a chart can lay out with a
          // non-zero width but a still-collapsing height during the
          // ResizeObserver pass, which would otherwise pass this check
          // while still rendering as a flat/blank strip in the PDF.
          const ready =
            svgs.length > 0 &&
            Array.from(svgs).every((svg) => {
              const box = (svg as SVGSVGElement).getBBox();
              return box.width > 0 && box.height > 0;
            });
          const w = window as unknown as { __fhipChartWaitStreak?: number };
          w.__fhipChartWaitStreak = ready || svgs.length === 0 ? (w.__fhipChartWaitStreak ?? 0) + 1 : 0;
          return w.__fhipChartWaitStreak >= 15;
        },
        { timeout: 8000, polling: 100 }
      )
      .catch(() => {});
    // Real running page numbers require Playwright's own header/footer
    // template mechanism — plain CSS `@page { @bottom-center { ... } }`
    // margin-box content is not supported by Chromium's print-to-PDF
    // pipeline at all, so a CSS-only approach would silently do nothing.
    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '20mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%;font-size:9px;color:#9CA3AF;text-align:center;font-family:Arial,sans-serif;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    return { buffer, checksum };
  } finally {
    await browser.close();
    await admin.from('report_exports').update({ render_token: null, render_token_expires_at: null }).eq('id', exportId);
  }
}
