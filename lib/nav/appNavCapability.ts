// G4 — authenticated navigation, capability-driven visibility.
//
// Pure decision functions only (same separation-of-concerns as
// lib/admin/adminNav.ts, and for the identical two reasons given there: no
// DOM test environment in this repo, and "navigation visibility is a UX
// convenience, never authorisation" -- the real enforcement for every one of
// these hrefs lives at its page/API layer, independent of whether the nav
// link itself is shown). Consumed by components/ui/AppShell.tsx.
//
// A hidden nav item is never the only thing standing between a GENERIC user
// and a domestic module -- see lib/services/appCapability.ts's
// requireModuleCapability() and the individually-migrated routes/pages for
// the actual server-side gate. This file only decides what a legitimate,
// non-attacking user SEES.
import type { CapabilityDecision, ModuleKey } from '@/lib/services/appCapability';

// Maps every authenticated nav href (components/ui/AppShell.tsx's NAV_GROUPS
// + FORECASTING_ITEMS) onto the ModuleKey that governs it. Deliberately
// covers ONLY hrefs that currently exist in that file -- the route-manifest
// completeness test (tests/unit/appCapabilityManifest.test.ts) asserts this
// map's key set matches AppShell's own nav hrefs exactly, so an href added to
// one without the other fails a test rather than silently drifting.
export const NAV_HREF_MODULE_MAP: Record<string, ModuleKey> = {
  '/dashboard': 'DASHBOARD',
  '/income': 'INCOME',
  '/expenses': 'EXPENSES',
  '/financial-data-hub/activity': 'FINANCIAL_DATA_HUB',
  '/assets': 'ASSETS',
  '/liabilities': 'LIABILITIES',
  '/investments': 'INVESTMENTS',
  '/insurance': 'INSURANCE',
  '/goals': 'GOALS',
  '/score': 'SCORES',
  '/dna': 'DNA',
  '/resilience': 'RESILIENCE',
  '/financial-twin': 'FINANCIAL_TWIN',
  '/investment-intelligence': 'INVESTMENT_INTELLIGENCE',
  '/forecast': 'FORECASTING',
  '/forecast/net-worth': 'FORECASTING',
  '/forecast/retirement': 'FORECASTING',
  '/forecast/goals': 'FORECASTING',
  '/forecast/debt': 'FORECASTING',
  '/forecast/investments': 'FORECASTING',
  '/forecast/cross-border': 'FORECASTING',
  '/forecast/resilience': 'FORECASTING',
  '/forecast/variance': 'FORECASTING',
  '/forecast/report': 'FORECASTING',
  '/forecast/scenarios': 'FORECASTING',
  '/forecast/assumptions': 'FORECASTING',
  '/forecast/history': 'FORECASTING',
  '/recommendations': 'RECOMMENDATIONS',
  '/reports': 'REPORTS',
  '/ai-insights': 'AI_INSIGHTS',
  '/profile': 'PROFILE',
};

/**
 * Fail-closed default (mirrors lib/admin/adminNav.ts's NO_ADMIN_CAPABILITIES
 * pattern): the value the nav holds before /api/capabilities/nav resolves,
 * and the value it falls back to on any fetch failure or malformed body — an
 * error must never become a default grant of visibility. An empty object
 * means every mapped href resolves to "no decision" in isNavHrefVisible()
 * below, which that function treats as hidden — every module starts hidden,
 * matching G3's fail-closed direction (an allowlist a route opts into, never
 * a blocklist a route must be added to in order to be protected).
 */
export const EMPTY_NAV_DECISIONS: Record<string, CapabilityDecision> = Object.freeze({});

/**
 * Fail-closed parse of a GET /api/capabilities/nav response body. Any shape
 * other than an object carrying a valid CapabilityDecision string for a given
 * module yields 'UNAVAILABLE' (hidden) for that module — a malformed or
 * partially-populated payload can only narrow visibility, never widen it.
 */
const VALID_DECISIONS = new Set(['ENABLED', 'EXISTING_RECORD_ONLY', 'UNAVAILABLE']);

export function parseNavDecisions(body: unknown): Record<string, CapabilityDecision> {
  const data = (body as { data?: { decisions?: unknown } } | null | undefined)?.data?.decisions;
  const result: Record<string, CapabilityDecision> = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return result;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === 'string' && VALID_DECISIONS.has(value)) {
      result[key] = value as CapabilityDecision;
    }
  }
  return result;
}

/**
 * G4 closure item 2 (Product Owner, 2026-09-05): the CREATE-operation
 * counterpart to parseNavDecisions() above, reading GET /api/capabilities/
 * nav's `writeDecisions` field. Same fail-closed parse: any malformed value
 * is simply absent from the result, and isModuleWriteAvailable() below
 * treats an absent entry as "not writable" — an error or a not-yet-resolved
 * fetch can only narrow what a page offers to edit, never widen it.
 */
export function parseWriteDecisions(body: unknown): Record<string, CapabilityDecision> {
  const data = (body as { data?: { writeDecisions?: unknown } } | null | undefined)?.data?.writeDecisions;
  const result: Record<string, CapabilityDecision> = {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return result;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === 'string' && VALID_DECISIONS.has(value)) {
      result[key] = value as CapabilityDecision;
    }
  }
  return result;
}

/**
 * Is this module's CREATE/UPDATE affordance safe to offer in the UI? Only
 * ENABLED counts — EXISTING_RECORD_ONLY permits reading history but never a
 * live create/update control (mirrors requireModuleCapability's own
 * SAFE_READ_METHODS rule), and an absent/unresolved decision fails closed to
 * "not writable" rather than defaulting to a permissive control.
 */
export function isModuleWriteAvailable(moduleKey: string, writeDecisions: Record<string, CapabilityDecision>): boolean {
  return writeDecisions[moduleKey] === 'ENABLED';
}

/**
 * Is this href shown in the nav at all?
 *
 * - An href with no ModuleKey mapping is always shown (nav visibility is UX
 *   only; an unmapped item is a nav-config gap the completeness test catches,
 *   never a security bypass, since the item's own page/API stays
 *   independently gated regardless).
 * - Otherwise: shown for ENABLED and EXISTING_RECORD_ONLY (a user with
 *   preserved history should still be able to reach it — the page itself
 *   renders the read-only/history view); hidden only for UNAVAILABLE or an
 *   absent decision (fail closed — no decisions object yet, or the module
 *   key was missing from the response, both mean "not shown").
 */
export function isNavHrefVisible(href: string, decisions: Record<string, CapabilityDecision>): boolean {
  const moduleKey = NAV_HREF_MODULE_MAP[href];
  if (!moduleKey) return true;
  const decision = decisions[moduleKey];
  return decision === 'ENABLED' || decision === 'EXISTING_RECORD_ONLY';
}
