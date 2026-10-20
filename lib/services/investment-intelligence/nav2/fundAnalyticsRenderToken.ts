// NAV2 -- the single-use, short-lived render token of the Fund analytics report (nav2_report_render_tokens, migration 0261, service role only).
// Kept in its OWN module, with no browser import: the print page (app/(print)/reports/fund-analytics/print/page.tsx) resolves the token and is
// the page every person's "Print / Save as PDF" opens. It must load on a server that has no headless browser (Amplify packs none: the
// 18-10-2026 artifact slimming removed playwright from the server trace), so it must never import fundAnalyticsPdfRenderer.ts (which
// imports playwright at its top level). A test enforces this.
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

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
