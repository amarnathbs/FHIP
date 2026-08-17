'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, Menu, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

type NavLink = { type: 'link'; label: string; href: string };
type NavDropdown = { type: 'dropdown'; id: string; label: string; items: { label: string; href: string }[] };
type NavEntry = NavLink | NavDropdown;
type NavGroup = { label: string; items: NavEntry[] };

// "Goal Forecasts" (not "Goals") to avoid colliding with the pre-existing
// top-level Goals link (Module 7's Goal Planning page) — two nav links both
// named exactly "Goals" would make `getByRole('link', {name: /^Goals$/i})`
// ambiguous for tests and for screen readers alike.
const FORECASTING_ITEMS = [
  { label: 'Overview', href: '/forecast' },
  { label: 'Net Worth', href: '/forecast/net-worth' },
  { label: 'Retirement', href: '/forecast/retirement' },
  { label: 'Goal Forecasts', href: '/forecast/goals' },
  { label: 'Debt Reduction', href: '/forecast/debt' },
  { label: 'Investment Growth', href: '/forecast/investments' },
  { label: 'Cross-Border', href: '/forecast/cross-border' },
  { label: 'Financial Resilience', href: '/forecast/resilience' },
  { label: 'Forecast Variance', href: '/forecast/variance' },
  { label: 'Consolidated Report', href: '/forecast/report' },
  { label: 'Scenarios', href: '/forecast/scenarios' },
  { label: 'Assumptions', href: '/forecast/assumptions' },
  { label: 'Forecast History', href: '/forecast/history' },
];

// Grouped per the approved design-system nav pattern (Overview / Your
// finances / Plan & improve / Forecasting / Review & share / Account).
// "Forecasting" gets its own group rather than nesting under "Plan &
// improve" — with 13 sub-pages it doesn't fit gracefully two levels deep,
// and the design doc's own module table already treats Forecasting as a
// distinct top-level area.
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ type: 'link', label: 'Dashboard', href: '/dashboard' }],
  },
  {
    label: 'Your finances',
    items: [
      { type: 'link', label: 'Income', href: '/income' },
      { type: 'link', label: 'Expenses', href: '/expenses' },
      { type: 'link', label: 'Assets', href: '/assets' },
      { type: 'link', label: 'Liabilities', href: '/liabilities' },
      // Retirement isn't its own sidebar entry — it's reached via the
      // in-page tab on this grid (InvestmentsSubNav) — so the label makes
      // that explicit rather than implying only Investments lives here.
      { type: 'link', label: 'Investment & Retirement', href: '/investments' },
      { type: 'link', label: 'Insurance', href: '/insurance' },
    ],
  },
  {
    label: 'Plan & improve',
    items: [
      { type: 'link', label: 'Goals', href: '/goals' },
      { type: 'link', label: 'Scores', href: '/score' },
      { type: 'link', label: 'DNA', href: '/dna' },
      { type: 'link', label: 'Resilience', href: '/resilience' },
      { type: 'link', label: 'Twin / Benchmark', href: '/financial-twin' },
    ],
  },
  {
    label: 'Forecasting',
    items: [{ type: 'dropdown', id: 'forecasting', label: 'Forecasting', items: FORECASTING_ITEMS }],
  },
  {
    label: 'Review & share',
    items: [
      { type: 'link', label: 'Recommendations', href: '/recommendations' },
      { type: 'link', label: 'Reports', href: '/reports' },
    ],
  },
];

// R1.2 Admin Resources shell nav — spec §41. Shown to any user holding at
// least one Resources role or Super Admin (hasResourcesAccess, from
// /api/admin/me); RLS remains the actual access boundary underneath this,
// this list is UX-only (spec §90/§43: "Do not hide content solely for
// security... Navigation hiding is only UX"). Future routes named in the
// spec (§8 — videos/glossary/faqs/categories/etc.) are deliberately not
// listed here at all, rather than shown disabled, per spec §8's "omit until
// implementation" option.
const RESOURCES_ITEMS: { label: string; href: string }[] = [
  { label: 'Dashboard', href: '/admin/resources' },
  { label: 'All Content', href: '/admin/resources/content' },
  { label: 'Drafts', href: '/admin/resources/content/drafts' },
  { label: 'Review Queue', href: '/admin/resources/content/review' },
  { label: 'Scheduled', href: '/admin/resources/content/scheduled' },
  { label: 'Published', href: '/admin/resources/content/published' },
  { label: 'Review Due', href: '/admin/resources/content/review-due' },
  { label: 'Archived', href: '/admin/resources/content/archived' },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

// Stable identifiers for the forecasting E2E suite's required selectors —
// keyed by href since these links are shared between the desktop sidebar
// and the mobile drawer and must carry the same testid in both.
const NAV_ITEM_TEST_IDS: Record<string, string> = {
  '/forecast/assumptions': 'forecast-assumptions-link',
  '/forecast/variance': 'forecast-variance-link',
  '/forecast/history': 'forecast-history-link',
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const [isAdmin, setIsAdmin] = useState(false);
  const [hasResourcesAccess, setHasResourcesAccess] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);
  // Auto-expand the Forecasting group only if the initial page load lands
  // inside it; thereafter the user's own expand/collapse choice persists
  // across navigation (a persistent sidebar, unlike the old floating
  // top-bar dropdown, has no overlay-conflict reason to force-close it).
  const [openDropdown, setOpenDropdown] = useState<string | null>(() => (pathname.startsWith('/forecast') ? 'forecasting' : null));
  // Multi-item groups (Your finances, Plan & improve, Review & share) are
  // collapsible via their header, same idea as the Forecasting dropdown but
  // one level up — collapsing the section, not just one entry inside it.
  // All expanded by default; a group only enters this set once the user
  // explicitly collapses it, and stays collapsed across navigation the same
  // way openDropdown does (this sidebar persists across routes — see
  // app/(app)/layout.tsx — so plain useState is enough, no storage needed).
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  function toggleGroup(label: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }
  // Keyed by dropdown entry id so Escape can return focus to whichever
  // dropdown's trigger was open — generic even though only Forecasting uses
  // it today, so a future second dropdown doesn't need this refactored again.
  const dropdownTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/me')
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) {
          setIsAdmin(Boolean(j.data?.isAdmin));
          setHasResourcesAccess(Boolean(j.data?.hasResourcesAccess));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Route changes always close the mobile drawer, regardless of what
  // triggered the navigation (nav link, browser back/forward, etc.).
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  async function signOut() {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const dropdownActive = (entry: NavDropdown) => entry.items.some((i) => isActive(pathname, i.href));

  // Rendered once for the desktop aside and once for the mobile drawer; both
  // copies exist in the DOM simultaneously whenever the drawer is open (the
  // aside is merely CSS-hidden below `lg`, not unmounted), so every id needs
  // a scope prefix — two elements sharing an id is invalid HTML and makes
  // `aria-controls` resolve unpredictably.
  const renderSidebar = (scope: 'desktop' | 'mobile') => (
    <>
      <div className="flex h-16 items-center gap-2 px-5">
        {/* The mark's outline elements are dark navy, close to bg-nav's own
            #0F2747 — a small white chip keeps it legible against the dark
            sidebar without needing a separate light-background asset. */}
        <span className="flex h-8 w-8 items-center justify-center rounded bg-white/95 p-1">
          <img src="/images/fhip-icon-32.png" alt="" className="h-full w-full object-contain" />
        </span>
        <span className="text-lg font-semibold text-white">FHIP</span>
      </div>
      <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {NAV_GROUPS.map((group) => {
          // Skip the group header when it would just repeat a single item's
          // own label right above it (the Forecasting group: header
          // "FORECASTING" directly above a dropdown button also labelled
          // "Forecasting" read as the same word shown twice in a row) — that
          // one entry's own button already carries the heading styling
          // (see the `redundantHeader ? 'uppercase tracking-wide' : ''`
          // below) and its own openDropdown collapse, so it doesn't need
          // this separate group-level collapse mechanism too.
          const redundantHeader = group.items.length === 1 && group.items[0].label === group.label;
          const collapsible = !redundantHeader && group.items.length > 1;
          const groupSlug = group.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          const isCollapsed = collapsedGroups.has(group.label);
          return (
          <div key={group.label}>
            {redundantHeader ? null : collapsible ? (
              <button
                type="button"
                onClick={() => toggleGroup(group.label)}
                aria-expanded={!isCollapsed}
                aria-controls={`${scope}-navgroup-${groupSlug}`}
                className="flex w-full items-center justify-between px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-white/50 hover:text-white/70"
              >
                {group.label}
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isCollapsed ? '' : 'rotate-180'}`} aria-hidden="true" />
              </button>
            ) : (
              <p className="px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">{group.label}</p>
            )}
            {(!collapsible || !isCollapsed) && (
            <ul id={collapsible ? `${scope}-navgroup-${groupSlug}` : undefined} className="space-y-0.5">
              {group.items.map((entry) =>
                entry.type === 'link' ? (
                  <li key={entry.label}>
                    <Link
                      href={entry.href}
                      aria-current={isActive(pathname, entry.href) ? 'page' : undefined}
                      className={`block rounded px-3 py-2 text-sm ${
                        isActive(pathname, entry.href) ? 'bg-white/10 font-semibold text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      {entry.label}
                    </Link>
                  </li>
                ) : (
                  <li
                    key={entry.id}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && openDropdown === entry.id) {
                        setOpenDropdown(null);
                        dropdownTriggerRefs.current[entry.id]?.focus();
                      }
                    }}
                  >
                    <button
                      ref={(el) => {
                        dropdownTriggerRefs.current[entry.id] = el;
                      }}
                      type="button"
                      data-testid={entry.id === 'forecasting' ? 'nav-forecasting' : undefined}
                      aria-expanded={openDropdown === entry.id}
                      aria-controls={`${scope}-${entry.id}-group`}
                      aria-current={dropdownActive(entry) ? 'page' : undefined}
                      onClick={() => setOpenDropdown((o) => (o === entry.id ? null : entry.id))}
                      className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm ${
                        dropdownActive(entry) ? 'font-semibold text-white' : 'text-white/70 hover:text-white'
                      } ${redundantHeader ? 'uppercase tracking-wide' : ''}`}
                    >
                      {entry.label}
                      <ChevronDown className={`h-4 w-4 transition-transform ${openDropdown === entry.id ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>
                    {openDropdown === entry.id && (
                      <ul
                        id={`${scope}-${entry.id}-group`}
                        role="menu"
                        aria-label={entry.label}
                        className="ml-2 space-y-0.5 border-l border-white/10 pl-3"
                      >
                        {entry.items.map((item) => {
                          const itemActive = isActive(pathname, item.href);
                          return (
                            <li key={item.href}>
                              <Link
                                href={item.href}
                                data-testid={NAV_ITEM_TEST_IDS[item.href]}
                                role="menuitem"
                                aria-current={itemActive ? 'page' : undefined}
                                className={`block rounded px-3 py-1.5 text-sm ${
                                  itemActive ? 'bg-white/10 font-semibold text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'
                                }`}
                              >
                                {item.label}
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                )
              )}
            </ul>
            )}
          </div>
          );
        })}

        {isAdmin && (
          <div>
            <p className="px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">Account</p>
            <ul className="space-y-0.5">
              <li>
                <Link
                  href="/admin/benchmarks"
                  aria-current={isActive(pathname, '/admin/benchmarks') ? 'page' : undefined}
                  className={`block rounded px-3 py-2 text-sm ${
                    isActive(pathname, '/admin/benchmarks') ? 'bg-white/10 font-semibold text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  Admin
                </Link>
              </li>
              <li>
                <Link
                  href="/admin/recommendations"
                  aria-current={isActive(pathname, '/admin/recommendations') ? 'page' : undefined}
                  className={`block rounded px-3 py-2 text-sm ${
                    isActive(pathname, '/admin/recommendations') ? 'bg-white/10 font-semibold text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  Recs Admin
                </Link>
              </li>
            </ul>
          </div>
        )}

        {hasResourcesAccess && (
          <div>
            <p className="px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">Resources</p>
            <ul className="space-y-0.5">
              {RESOURCES_ITEMS.map((entry) => {
                // Exact-match only (not the shared isActive's startsWith
                // semantics) — Resources routes nest (/admin/resources/content
                // vs /admin/resources/content/drafts), so a prefix match would
                // highlight "All Content" while viewing "Drafts" too.
                const itemActive = pathname === entry.href;
                return (
                  <li key={entry.href}>
                    <Link
                      href={entry.href}
                      aria-current={itemActive ? 'page' : undefined}
                      className={`block rounded px-3 py-2 text-sm ${
                        itemActive ? 'bg-white/10 font-semibold text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      {entry.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </nav>
      <div className="border-t border-white/10 p-3">
        <button
          onClick={() => setSignOutConfirmOpen(true)}
          className="block w-full rounded px-3 py-2 text-left text-sm text-white/70 hover:bg-white/5 hover:text-white"
        >
          Sign out
        </button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-app">
      {/* Desktop persistent sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col bg-nav lg:flex">{renderSidebar('desktop')}</aside>

      {/* Mobile top bar + hamburger trigger */}
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-line bg-white px-4 lg:hidden">
        <span className="flex items-center gap-2">
          <img src="/images/fhip-icon-32.png" alt="" className="h-7 w-7 object-contain" />
          <span className="text-lg font-semibold text-primary">FHIP</span>
        </span>
        <button
          type="button"
          data-testid="mobile-menu-trigger"
          className="rounded p-2 text-muted hover:text-primary"
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav-panel"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          onClick={() => setMobileOpen((o) => !o)}
        >
          {mobileOpen ? <X className="h-6 w-6" aria-hidden="true" /> : <Menu className="h-6 w-6" aria-hidden="true" />}
        </button>
      </header>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} aria-hidden="true" />
          <div id="mobile-nav-panel" className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-nav shadow-xl">
            {renderSidebar('mobile')}
          </div>
        </div>
      )}

      <main className="px-4 py-8 lg:ml-[248px] lg:px-8">
        <div className="mx-auto max-w-[1480px]">{children}</div>
      </main>

      <ConfirmDialog
        open={signOutConfirmOpen}
        title="Sign out?"
        message="You'll need to sign back in to see your dashboard and data."
        confirmLabel="Sign out"
        cancelLabel="Stay signed in"
        onConfirm={() => {
          setSignOutConfirmOpen(false);
          void signOut();
        }}
        onCancel={() => setSignOutConfirmOpen(false)}
      />
    </div>
  );
}
