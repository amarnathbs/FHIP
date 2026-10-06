// NAV2 Stage 2 -- the Fund analytics report as a PDF. The same Playwright pattern as the forecast report
// (lib/services/forecastReportPdfRenderer.ts): a single-use, short-lived render token (nav2_report_render_tokens, migration
// 0261, service role only) tied to ONE user and ONE pinned report; the headless browser opens the bare print route with the
// token and prints exactly what the on-screen page shows (one component renders both).
//
// The token is deleted whatever happens. The route that calls this checks Premium (canExportReports) and that the report is
// the caller's own BEFORE a token is created; the print route checks the token again and loads the report with an explicit
// user filter, so a token for one user's report can never open another's.

import { chromium, type Page } from 'playwright';
import { formatDateTimeMinutes } from '@/lib/engines/date';
import { FUND_ANALYTICS_SAVED_REPORT_SENTENCE } from '@/lib/engines/nav2/reportWording';
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

/** What the running header and footer say about the stored report. */
export interface PdfReportMeta {
  versionNumber: number;
  /** ISO timestamp the version was made. */
  createdAt: string;
}

// PAGE SETUP (one place, shared by the export route and the layout check): A4 portrait, equal side margins, room at the top for the running
// header and at the bottom for the running footer. The print stylesheet (.fa-doc in app/globals.css) is written for exactly this text area.
export const FUND_ANALYTICS_PDF_MARGIN = { top: '22mm', bottom: '20mm', left: '16mm', right: '16mm' } as const;

const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TEMPLATE_STYLE = 'width:100%;box-sizing:border-box;padding:0 16mm;gap:4mm;font-size:9.5px;color:#6B7280;font-family:Arial,sans-serif;display:flex;justify-content:space-between;align-items:center;';

/** Running header: "FHIP - Fund analytics report" left, "Version N, made 05-10-2026, 9:30 am" right (day-first, minutes). */
export function pdfHeaderTemplate(meta?: PdfReportMeta): string {
  const right = meta ? `Version ${meta.versionNumber}, made ${formatDateTimeMinutes(meta.createdAt, 'INR')}` : '';
  return `<div style="${TEMPLATE_STYLE}"><span>FHIP - Fund analytics report</span><span>${esc(right)}</span></div>`;
}

/** Running footer: "FHIP - Premium report" and the saved-report sentence left, "Page n of N" right. */
export function pdfFooterTemplate(): string {
  return `<div style="${TEMPLATE_STYLE}"><span>FHIP - Premium report. ${esc(FUND_ANALYTICS_SAVED_REPORT_SENTENCE)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
}

/**
 * The print document is server-rendered, so it carries its own READY marker (data-fa-print-ready) and says how many price charts it holds
 * (data-fa-expected-charts). Printing waits for the marker, for the fonts, and for every expected chart to be in the page; a chart that
 * is not there makes the render FAIL (the export answers an error) instead of printing a blank rectangle. Stage 3 saw exactly that with a
 * client-side chart that had not mounted when the old "no charts yet counts as ready" wait gave up.
 */
export async function waitForPrintReady(page: Page): Promise<void> {
  await page.waitForSelector('[data-fa-print-ready="true"]', { timeout: 30_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForFunction(
    () => {
      const root = document.querySelector('[data-fa-print-ready="true"]');
      const expected = Number(root?.getAttribute('data-fa-expected-charts') ?? '0');
      return document.querySelectorAll('svg[data-fa-chart="true"]').length >= expected;
    },
    undefined,
    { timeout: 15_000 }
  );
}

/** Prints the open page exactly as the export route does (the layout check uses this same function). */
export async function printPageToPdf(page: Page, meta?: PdfReportMeta): Promise<Buffer> {
  await page.emulateMedia({ media: 'print' });
  await waitForPrintReady(page);
  return await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: FUND_ANALYTICS_PDF_MARGIN,
    displayHeaderFooter: true,
    headerTemplate: pdfHeaderTemplate(meta),
    footerTemplate: pdfFooterTemplate(),
  });
}

export async function renderFundAnalyticsReportToPdf(admin: SupabaseClient, userId: string, reportId: string, meta?: PdfReportMeta): Promise<Buffer> {
  const token = await createNav2RenderToken(admin, userId, reportId);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const url = `${BASE_URL}/reports/fund-analytics/print?${new URLSearchParams({ token }).toString()}`;
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    if (!response || !response.ok()) throw new Error(`Print route returned ${response?.status() ?? 'no response'}`);
    return await printPageToPdf(page, meta);
  } finally {
    await browser.close();
    await admin.from('nav2_report_render_tokens').delete().eq('token', token);
  }
}
