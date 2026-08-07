import { chromium } from 'playwright';
import crypto from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';

// Same base-URL convention as lib/services/reportPdfRenderer.ts and the test
// harnesses' HARNESS_BASE_URL.
const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const RENDER_TOKEN_TTL_MS = 5 * 60 * 1000;

// Mirrors lib/services/reportPdfRenderer.ts's renderReportToPdf() exactly
// (same Playwright pattern, same chart-readiness wait, same page-number
// footer template) — this report just has no report_id/report_exports row
// to attach a token to, since it isn't a saved/versioned report the way
// Free/Premium reports are; it's always rendered live from current data.
// forecast_report_render_tokens (0024_forecast_report_render_tokens.sql) is
// the equivalent single-use, short-lived token store.
export async function renderForecastReportToPdf(userId: string, scenarioId?: string): Promise<Buffer> {
  const admin = createAdminClient();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RENDER_TOKEN_TTL_MS).toISOString();
  const { error: tokenError } = await admin
    .from('forecast_report_render_tokens')
    .insert({ token, user_id: userId, scenario_id: scenarioId ?? null, expires_at: expiresAt });
  if (tokenError) throw new Error(`Could not prepare render token: ${tokenError.message}`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const params = new URLSearchParams({ token });
    if (scenarioId) params.set('scenario', scenarioId);
    const url = `${BASE_URL}/forecast/report/print?${params.toString()}`;
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    if (!response || !response.ok()) {
      throw new Error(`Print route returned ${response?.status() ?? 'no response'} for ${url}`);
    }
    // Same chart-readiness wait as reportPdfRenderer.ts — width AND height,
    // not just width (see that file's comment for why).
    await page
      .waitForFunction(
        () => {
          const svgs = document.querySelectorAll('.recharts-wrapper svg');
          if (svgs.length === 0) return true;
          return Array.from(svgs).every((svg) => {
            const box = (svg as SVGSVGElement).getBBox();
            return box.width > 0 && box.height > 0;
          });
        },
        { timeout: 5000 }
      )
      .catch(() => {});
    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '20mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%;font-size:9px;color:#9CA3AF;text-align:center;font-family:Arial,sans-serif;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
    return buffer;
  } finally {
    await browser.close();
    // Single-use — delete regardless of success/failure, same as
    // reportPdfRenderer.ts clearing report_exports.render_token.
    await admin.from('forecast_report_render_tokens').delete().eq('token', token);
  }
}
