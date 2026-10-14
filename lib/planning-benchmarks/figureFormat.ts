// Planning Benchmarks: how a figure is SHOWN. One rule for every Planning Benchmarks screen (the Upload tab preview, the
// Observed values and Target ranges tabs, the Allowed values lists, the validator messages).
//
// RULE (Product Owner, 07/10/2026): a figure is formatted by ITS OWN currency or unit, never by the viewer's profile or
// browser locale. An AUD amount reads 183,000, an INR amount reads 1,83,000, a percentage, ratio, month or count is a plain
// number with Australian grouping. The decimal rule is the one the preview always had: up to 4 decimals, none forced, so a
// reviewer sees the exact figure that would go live (the documented exception (a) of the whole-unit rule G1 in
// lib/engines/money.ts: a figure shown to be checked character for character).
//
// The digit grouping comes from localeForCurrencyCode in lib/engines/money.ts, the one place the app decides it. This file
// adds only what the benchmark screens need on top: which currency a figure has, and a safe fallback when it cannot be told.
import { localeForCurrencyCode } from '@/lib/engines/money';

/** Said next to a currency figure whose currency the data does not state. */
export const CURRENCY_NOT_STATED = 'currency not stated';

const MAX_FRACTION_DIGITS = 4;
/** Grouping of every figure that is not a currency amount (and of counts). Fixed, never the viewer's locale. */
const PLAIN_LOCALE = 'en-AU';

export interface FigureContext {
  /** metric unit: currency, percentage, months, ratio, count, days. Absent means unknown (shown as a plain number). */
  unit?: string | null;
  /** ISO 4217 code of the figure itself (original_currency of an observed value). */
  currency?: string | null;
  /** Country of the band, used only when the figure has no currency of its own (a target range band has none). */
  country?: string | null;
}

const COUNTRY_CURRENCY: Record<string, string> = { AU: 'AUD', IN: 'INR' };

/** The currency a figure is in: its own code, else the currency of its country, else null (not stated). */
export function figureCurrency(ctx: FigureContext): string | null {
  const own = (ctx.currency ?? '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(own)) return own;
  const byCountry = COUNTRY_CURRENCY[(ctx.country ?? '').trim().toUpperCase()];
  return byCountry ?? null;
}

/** True when the figure is a currency amount whose currency cannot be told, so the screen must say so. */
export function currencyIsMissing(ctx: FigureContext): boolean {
  return ctx.unit === 'currency' && figureCurrency(ctx) === null;
}

/** A figure as text. A missing value is "none"; text that is not a number is returned as it came. */
export function formatFigure(value: string | number | null | undefined, ctx: FigureContext = {}): string {
  if (value === null || value === undefined || value === '') return 'none';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  const opts = { maximumFractionDigits: MAX_FRACTION_DIGITS };
  if (ctx.unit === 'currency') {
    const code = figureCurrency(ctx);
    if (code === null) return `${n.toLocaleString(PLAIN_LOCALE, opts)} (${CURRENCY_NOT_STATED})`;
    return n.toLocaleString(localeForCurrencyCode(code), opts);
  }
  return n.toLocaleString(PLAIN_LOCALE, opts);
}

/** A whole number such as a row or pair count: plain grouping, never the viewer's locale. */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString(PLAIN_LOCALE) : String(n);
}
