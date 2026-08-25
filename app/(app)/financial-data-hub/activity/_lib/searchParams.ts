// FDH-8 Financial Activity UI — shared server-component search-param
// resolution. This is a thin adapter, not a second parser: it builds a
// `URL` from Next.js's server-component `searchParams` prop and hands it to
// the SAME `parseActivityParams` every FDH-8 API route already uses, so the
// UI and the API agree on preset/from/to/account_id semantics without a
// parallel implementation (mirrors the "reuse, not a competing engine"
// principle financialActivityAnalytics.ts states for totals).

import { parseActivityParams, type ParsedActivityParams } from '@/lib/financial-data-hub/analytics/requestParams';

export type RawSearchParams = Record<string, string | string[] | undefined>;

function toUrl(sp: RawSearchParams): URL {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }
  // Host/path are irrelevant — only the query string is ever read.
  return new URL(`http://activity.local/?${params.toString()}`);
}

/** Resolves `period`/`from`/`to`/`account_id` from a Next.js server-component
 * `searchParams` object, exactly as the API routes resolve them from a
 * request URL. */
export function resolveActivityParams(sp: RawSearchParams): ParsedActivityParams {
  return parseActivityParams(toUrl(sp));
}

/** Reads a single scalar query param, taking the first value if the param
 * was repeated. */
export function rawParam(sp: RawSearchParams, key: string): string | null {
  const v = sp[key];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
