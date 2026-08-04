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
    // 'networkidle' only guarantees requests have settled — it says nothing
    // about whether Recharts' ResponsiveContainer has finished its
    // ResizeObserver-driven layout pass yet, which happens after mount, not
    // tied to any network event. Without this wait, page.pdf() can capture
    // charts mid-layout with a zero-width SVG, producing blank charts with
    // axes/labels but no visible bars/lines/pie segments in the PDF. A
    // timeout here is treated as non-fatal — proceed with whatever rendered
    // rather than failing the whole export over one slow chart.
    await page
      .waitForFunction(
        () => {
          const svgs = document.querySelectorAll('.recharts-wrapper svg');
          if (svgs.length === 0) return true;
          return Array.from(svgs).every((svg) => (svg as SVGSVGElement).getBBox().width > 0);
        },
        { timeout: 5000 }
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
