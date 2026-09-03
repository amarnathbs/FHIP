// II-PC2 — the single source of truth for Investment Intelligence workspace
// navigation (spec sections 8, 9, 31, 32).
//
// WHY THIS IS A PURE MODULE, NOT A CONSTANT INSIDE THE COMPONENT
// --------------------------------------------------------------
// Spec section 31 requires "no duplicated independent nav arrays across
// pages". Keeping the item list and the active-route rule here means the
// React component is a thin renderer, and both are unit-testable under this
// repository's node-environment vitest baseline (there is no jsdom /
// @testing-library in this project, so a component-render test is not an
// option — see vitest.config.ts).
//
// TERMINOLOGY (spec sections 8, 37): the labels below are NOT the internal
// engine names. The spec's suggested labels ("SIP", "X-RAY") are deliberately
// NOT used, because no user-facing surface in this application says "X-Ray" —
// each label is taken from the destination page's own existing <h1>:
//   /performance -> "Investment performance"       -> "Performance"
//   /sip         -> "Recurring investments"        -> "Recurring investments"
//   /xray        -> "What your funds actually hold"-> "Fund holdings"
//   /tax         -> "India tax & cost intelligence"-> "Tax & cost"
//   /review      -> "Investment Review Centre"     -> "Review"

export const II_WORKSPACE_ROOT = '/investment-intelligence';

export interface IiWorkspaceNavItem {
  /** Stable machine key — used by tests and as the React key. Never shown. */
  key: string;
  /** User-facing label. Must match the destination page's own heading language. */
  label: string;
  href: string;
  /**
   * Short accessible description, announced to screen-reader users via the
   * link's aria-label so the terse visual label is still unambiguous out of
   * visual context (spec section 35).
   */
  description: string;
}

export const II_WORKSPACE_NAV: readonly IiWorkspaceNavItem[] = [
  {
    key: 'overview',
    label: 'Overview',
    href: II_WORKSPACE_ROOT,
    description: 'What investment data you have and which analysis is available',
  },
  {
    key: 'data',
    label: 'Statements & data',
    href: `${II_WORKSPACE_ROOT}/data`,
    description: 'Upload statements, review data issues, certify and publish positions',
  },
  {
    key: 'performance',
    label: 'Performance',
    href: `${II_WORKSPACE_ROOT}/performance`,
    description: 'How your investments performed and how that compares with their benchmarks',
  },
  {
    key: 'sip',
    label: 'Recurring investments',
    href: `${II_WORKSPACE_ROOT}/sip`,
    description: 'Your recurring contributions and the same contributions in the benchmark',
  },
  {
    key: 'xray',
    label: 'Fund holdings',
    href: `${II_WORKSPACE_ROOT}/xray`,
    description: 'The securities inside your funds, and where they overlap',
  },
  {
    key: 'tax',
    label: 'Tax & cost',
    href: `${II_WORKSPACE_ROOT}/tax`,
    description: 'Estimated realised gains and cost basis from recorded disposals',
  },
  {
    key: 'review',
    label: 'Review',
    href: `${II_WORKSPACE_ROOT}/review`,
    description: 'What needs your attention across your investment data',
  },
] as const;

/**
 * Canonical FHIP destinations reached FROM the workspace (spec sections 9,
 * 23-26). These are deliberately NOT workspace tabs: they are other people's
 * canonical systems, and duplicating them under II "to make navigation look
 * symmetrical" is explicitly forbidden (spec section 9).
 */
export interface IiRelatedDestination {
  key: string;
  label: string;
  href: string;
  /** Why a user would go there, and how it differs from Investment Intelligence. */
  relationship: string;
}

export const II_RELATED_DESTINATIONS: readonly IiRelatedDestination[] = [
  {
    key: 'investments',
    label: 'Investment & Retirement',
    href: '/investments',
    relationship:
      'Your household investment register, used across your overall FHIP finances. Positions you publish from here appear there — they are the same holdings, not a second copy.',
  },
  {
    key: 'goals',
    label: 'Goals',
    href: '/goals',
    relationship: 'Your goals live in Goals. Investments can be linked to a goal there; this workspace only reports that linkage.',
  },
  {
    key: 'forecast',
    label: 'Investment forecast',
    href: '/forecast/investments',
    relationship:
      'Investment Intelligence describes what has already happened. Forecasting projects what might happen next, under assumptions you set.',
  },
  {
    key: 'reports',
    label: 'Reports',
    href: '/reports',
    relationship: 'Reports are generated from the certified data in these systems — there is no separate report to run from here.',
  },
] as const;

/**
 * Active-tab rule.
 *
 * The workspace root is matched EXACTLY: without that special case
 * `/investment-intelligence` would prefix-match every child route and the
 * Overview tab would report itself active on all seven pages, which is both
 * visually wrong and an `aria-current` lie to assistive technology.
 *
 * Every other item matches its own path or a deeper descendant of it, so a
 * future detail route (e.g. /performance/<schemeId>) keeps its parent tab lit.
 * The boundary check is on `${href}/` specifically so a sibling route with a
 * shared prefix (e.g. /taxonomy vs /tax) can never light the wrong tab.
 */
export function isIiNavItemActive(pathname: string, href: string): boolean {
  if (href === II_WORKSPACE_ROOT) return pathname === II_WORKSPACE_ROOT;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The nav item matching a pathname, or null when the path is outside the workspace. */
export function activeIiNavItem(pathname: string): IiWorkspaceNavItem | null {
  return II_WORKSPACE_NAV.find((item) => isIiNavItemActive(pathname, item.href)) ?? null;
}
