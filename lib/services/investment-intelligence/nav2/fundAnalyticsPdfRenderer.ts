// NAV2 Stage 2 -- the Fund analytics report as a PDF. The same Playwright pattern as the forecast report
// (lib/services/forecastReportPdfRenderer.ts): a single-use, short-lived render token (nav2_report_render_tokens, migration
// 0261, service role only) tied to ONE user and ONE pinned report; the headless browser opens the bare print route with the
// token and prints exactly what the on-screen page shows (one component renders both).
//
// The token is deleted whatever happens. The route that calls this checks Premium (canExportReports) and that the report is
// the caller's own BEFORE a token is created; the print route checks the token again and loads the report with an explicit
// user filter, so a token for one user's report can never open another's.

import { chromium } from 'playwright';
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
export const NAV2_RENDER_TOKEN_TTL_MS = 5 * 60 * 1000;

export async function createNav2RenderToken(admin: SupabaseClient, userId: string, reportId: string, nowMs = Date.now()): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const { error } = await admin.from('nav2_report_render_tokens').insert({ token, user_id: userId, report_id: reportId, expires_at: new Date(nowMs + NAV2_RENDER_TOKEN_TTL_MS).toISOString() });
  if (error) throw new Error('Could not prepare the PDF.');
  return token;
}

/** The user and report a token opens, or null when it is unknown or expired. */
export async function resolveNav2RenderToken(admin: SupabaseClient, token: string, nowMs = Date.now()): Promise<{ userId: string; reportId: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const { data } = await admin.from('nav2_report_render_tokens').select('user_id, report_id, expires_at').eq('token', token).maybeSingle();
  if (!data) return null;
  const row = data as { user_id: string; report_id: string; expires_at: string | null };
  if (!row.expires_at || new Date(row.expires_at).getTime() < nowMs) return null;
  return { userId: row.user_id, reportId: row.report_id };
}

export async function renderFundAnalyticsReportToPdf(admin: SupabaseClient, userId: string, reportId: string): Promise<Buffer> {
  const token = await createNav2RenderToken(admin, userId, reportId);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const url = `${BASE_URL}/reports/fund-analytics/print?${new URLSearchParams({ token }).toString()}`;
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    if (!response || !response.ok()) throw new Error(`Print route returned ${response?.status() ?? 'no response'}`);
    await page.emulateMedia({ media: 'print' });
    // Same chart-readiness wait as the other report renderers: a run of consecutive ready (or chart-free) polls.
    await page
      .waitForFunction(
        () => {
          const svgs = document.querySelectorAll('.recharts-wrapper svg');
          const ready = svgs.length > 0 && Array.from(svgs).every((svg) => {
            const box = (svg as SVGSVGElement).getBBox();
            return box.width > 0 && box.height > 0;
          });
          const w = window as unknown as { __fhipChartWaitStreak?: number };
          w.__fhipChartWaitStreak = ready || svgs.length === 0 ? (w.__fhipChartWaitStreak ?? 0) + 1 : 0;
          return w.__fhipChartWaitStreak >= 15;
        },
        { timeout: 20000, polling: 100 }
      )
      .catch(() => {});
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '20mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;font-size:9px;color:#9CA3AF;text-align:center;font-family:Arial,sans-serif;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
  } finally {
    await browser.close();
    await admin.from('nav2_report_render_tokens').delete().eq('token', token);
  }
}
