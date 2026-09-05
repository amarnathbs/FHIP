import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { APP_CAPABILITY_MANIFEST, MODULE_KEYS, type ModuleKey } from '@/lib/services/appCapability';

// Route-manifest completeness test (dispatch section 10). Walks the actual
// top-level folders under app/(app)/** and app/api/** and asserts every one
// is either mapped onto a real ModuleKey with a manifest entry, or is
// explicitly on the documented infra/out-of-scope allowlist below — so a
// brand-new top-level module folder added later without an update here fails
// this test instead of silently having no capability classification at all.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function listDirs(relPath: string): string[] {
  const abs = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

// app/(app)/** page-route folders -> ModuleKey. 'global-setup' is
// deliberately NOT a module — it is G3's interim generic-experience landing
// page, infra rather than a financial module.
const PAGE_FOLDER_MODULE_MAP: Record<string, ModuleKey> = {
  admin: 'ADMIN',
  'ai-insights': 'AI_INSIGHTS',
  assets: 'ASSETS',
  dashboard: 'DASHBOARD',
  dna: 'DNA',
  expenses: 'EXPENSES',
  'financial-data-hub': 'FINANCIAL_DATA_HUB',
  'financial-twin': 'FINANCIAL_TWIN',
  forecast: 'FORECASTING',
  goals: 'GOALS',
  income: 'INCOME',
  insurance: 'INSURANCE',
  'investment-intelligence': 'INVESTMENT_INTELLIGENCE',
  investments: 'INVESTMENTS',
  liabilities: 'LIABILITIES',
  profile: 'PROFILE',
  recommendations: 'RECOMMENDATIONS',
  reports: 'REPORTS',
  resilience: 'RESILIENCE',
  retirement: 'RETIREMENT', // SMSF is a section within this page, not a separate route folder
  score: 'SCORES',
};
const PAGE_FOLDER_INFRA_ALLOWLIST = new Set(['global-setup']);

// app/api/** top-level folders -> ModuleKey, OR the infra allowlist below for
// folders that are genuinely cross-cutting/shared infrastructure rather than
// a single financial module (documented reason inline).
const API_FOLDER_MODULE_MAP: Record<string, ModuleKey> = {
  'ai-insights': 'AI_INSIGHTS', // (folder is actually named "ai" — see alias below)
  assets: 'ASSETS',
  dashboard: 'DASHBOARD',
  expenses: 'EXPENSES',
  'financial-data-hub': 'FINANCIAL_DATA_HUB',
  'financial-twin': 'FINANCIAL_TWIN',
  forecast: 'FORECASTING',
  goals: 'GOALS',
  'health-score': 'SCORES',
  income: 'INCOME',
  insurance: 'INSURANCE',
  intelligence: 'DNA', // app/api/intelligence/{financial-dna,recalculate-dna}
  'investment-intelligence': 'INVESTMENT_INTELLIGENCE',
  investments: 'INVESTMENTS',
  liabilities: 'LIABILITIES',
  recommendations: 'RECOMMENDATIONS',
  reports: 'REPORTS',
  'report-exports': 'REPORTS',
  resilience: 'RESILIENCE',
  retirement: 'RETIREMENT',
  smsf: 'SMSF',
  admin: 'ADMIN',
};
// Folder-name aliasing: the on-disk folder is "ai", not "ai-insights".
const API_FOLDER_ALIASES: Record<string, string> = { ai: 'ai-insights' };

// Cross-cutting/shared infrastructure — deliberately not owned by any single
// module in the dispatch's inventory (section 5), so excluded from the
// per-module completeness check rather than force-mapped onto one:
//   - benchmarks: shared reference data consumed by Financial Twin AND Admin.
//   - commitments: a shared entity read by Dashboard/Resilience/Goals, not
//     itself a nav destination.
//   - contact: public marketing contact form, unauthenticated.
//   - household / household-members: onboarding infra, not a nav module.
//   - internal: server-to-server (cron/worker) routes, no end-user surface.
//   - landing: G2's anonymous landing-page country bucket, pre-authentication.
//   - master-items: shared catalogue lookup infra used by every grid module.
//   - onboarding: the onboarding wizard itself, not a post-onboarding module.
//   - professional-access: advisor/proxy access — real feature, but not named
//     in the dispatch's module inventory (section 5); out of scope for this
//     task's classification pass.
//   - property-liability-links: a junction-table API linking Assets and
//     Liabilities, not a distinct module.
//   - reference: public reference/lookup data (e.g. goal types).
//   - user: PROFILE + CROSS_BORDER + billing/primary-country/country-confirm
//     all live here — already covered individually via the manifest's PROFILE
//     and CROSS_BORDER entries and lib/api.ts's own guard choices; the folder
//     itself spans more than one ModuleKey so isn't force-mapped to just one.
//   - capabilities: this task's OWN new /api/capabilities/nav endpoint.
const API_FOLDER_INFRA_ALLOWLIST = new Set([
  'benchmarks',
  'commitments',
  'contact',
  'household',
  'household-members',
  'internal',
  'landing',
  'master-items',
  'onboarding',
  'professional-access',
  'property-liability-links',
  'reference',
  'user',
  'capabilities',
]);

describe('route-manifest completeness (dispatch section 10)', () => {
  it('every app/(app) page-route folder is mapped to a ModuleKey with a real manifest entry, or is explicitly infra', () => {
    const dirs = listDirs('app/(app)');
    for (const dir of dirs) {
      if (PAGE_FOLDER_INFRA_ALLOWLIST.has(dir)) continue;
      const moduleKey = PAGE_FOLDER_MODULE_MAP[dir];
      expect(moduleKey, `app/(app)/${dir} has no ModuleKey mapping — add one to PAGE_FOLDER_MODULE_MAP or PAGE_FOLDER_INFRA_ALLOWLIST`).toBeDefined();
      expect(APP_CAPABILITY_MANIFEST[moduleKey]).toBeDefined();
    }
  });

  it('every app/api top-level folder is mapped to a ModuleKey with a real manifest entry, or is explicitly infra', () => {
    const dirs = listDirs('app/api');
    for (const rawDir of dirs) {
      const dir = API_FOLDER_ALIASES[rawDir] ?? rawDir;
      if (API_FOLDER_INFRA_ALLOWLIST.has(rawDir)) continue;
      const moduleKey = API_FOLDER_MODULE_MAP[dir];
      expect(moduleKey, `app/api/${rawDir} has no ModuleKey mapping — add one to API_FOLDER_MODULE_MAP or API_FOLDER_INFRA_ALLOWLIST`).toBeDefined();
      expect(APP_CAPABILITY_MANIFEST[moduleKey]).toBeDefined();
    }
  });

  it('the manifest itself has no orphan entries — every ModuleKey maps back from at least one page or API folder, or is a documented exception', () => {
    // SUBSCRIPTION_PRICING, RESOURCES and CROSS_BORDER are the three
    // documented exceptions:
    //   - SUBSCRIPTION_PRICING has no live route at all yet (no
    //     billing/checkout surface exists in the repo).
    //   - RESOURCES has no route under app/(app)/** or app/api/** either —
    //     the only Resources surface in this repo is the PUBLIC,
    //     unauthenticated app/(marketing)/resources/** site, out of scope
    //     for this authenticated-app manifest by design (see the manifest
    //     entry's own note); its entry exists so a FUTURE authenticated
    //     in-app Resources surface has a governed home from day one.
    //   - CROSS_BORDER has no dedicated page/API folder of its own: its UI
    //     is a panel embedded WITHIN app/(app)/profile/page.tsx
    //     (CrossBorderRelationshipsPanel), and its API lives under
    //     app/api/user/cross-border-relationships/** — inside the 'user'
    //     folder, which is on the infra allowlist because it also serves
    //     PROFILE, billing-country and primary-country routes that are not
    //     CROSS_BORDER's concern. Forcing a folder mapping here would either
    //     misattribute 'user' entirely to CROSS_BORDER (wrong — most of that
    //     folder is PROFILE) or require a folder-internal split this test
    //     isn't designed to express, so it is a documented exception instead.
    const documented = new Set<ModuleKey>(['SUBSCRIPTION_PRICING', 'RESOURCES', 'CROSS_BORDER']);
    const referenced = new Set<ModuleKey>([
      ...Object.values(PAGE_FOLDER_MODULE_MAP),
      ...Object.values(API_FOLDER_MODULE_MAP),
    ]);
    for (const key of MODULE_KEYS) {
      if (documented.has(key)) continue;
      expect(referenced.has(key), `ModuleKey ${key} is never referenced by any page/API folder mapping`).toBe(true);
    }
  });
});
