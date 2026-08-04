'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, Menu, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

type NavLink = { type: 'link'; label: string; href: string };
type NavDropdown = { type: 'dropdown'; id: string; label: string; items: { label: string; href: string }[] };
type NavEntry = NavLink | NavDropdown;

const INPUT_DATA_ITEMS = [
  { label: 'Income', href: '/income' },
  { label: 'Expenses', href: '/expenses' },
  { label: 'Assets', href: '/assets' },
  { label: 'Liabilities', href: '/liabilities' },
];

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

// Required top-level order. "Scores" and "Twin / Benchmark" are display
// labels only — they reuse the existing /score and /financial-twin routes
// rather than renaming them.
const NAV_ITEMS: NavEntry[] = [
  { type: 'link', label: 'Dashboard', href: '/dashboard' },
  { type: 'dropdown', id: 'input-data', label: 'Input Data', items: INPUT_DATA_ITEMS },
  { type: 'link', label: 'Investments', href: '/investments' },
  { type: 'link', label: 'Insurance', href: '/insurance' },
  { type: 'link', label: 'Goals', href: '/goals' },
  { type: 'link', label: 'Scores', href: '/score' },
  { type: 'link', label: 'DNA', href: '/dna' },
  { type: 'link', label: 'Resilience', href: '/resilience' },
  { type: 'link', label: 'Twin / Benchmark', href: '/financial-twin' },
  { type: 'dropdown', id: 'forecasting', label: 'Forecasting', items: FORECASTING_ITEMS },
  { type: 'link', label: 'Recommendations', href: '/recommendations' },
  { type: 'link', label: 'Reports', href: '/reports' },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

// Stable identifiers for the forecasting E2E suite's required selectors —
// keyed by href since these links are shared between the desktop dropdown
// and the mobile panel and must carry the same testid in both.
const NAV_ITEM_TEST_IDS: Record<string, string> = {
  '/forecast/assumptions': 'forecast-assumptions-link',
  '/forecast/variance': 'forecast-variance-link',
  '/forecast/history': 'forecast-history-link',
};

function linkClasses(active: boolean): string {
  return `rounded px-2 py-1.5 text-sm whitespace-nowrap ${active ? 'font-semibold text-trust' : 'text-gray-600 hover:text-trust'}`;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const [isAdmin, setIsAdmin] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openMobileDropdown, setOpenMobileDropdown] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/me')
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setIsAdmin(Boolean(j.data?.isAdmin));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Route changes always close the mobile panel, regardless of what
  // triggered the navigation (nav link, browser back/forward, etc.).
  useEffect(() => {
    setMobileOpen(false);
    setOpenMobileDropdown(null);
  }, [pathname]);

  async function signOut() {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const dropdownActive = (entry: NavDropdown) => entry.items.some((i) => isActive(pathname, i.href));

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-x-4 px-4 py-3 sm:px-6">
          <span className="text-lg font-semibold text-trust">FHIP</span>

          {/* Desktop / large-tablet navigation */}
          <div className="hidden flex-1 items-center justify-between lg:flex">
            <nav aria-label="Main" className="flex flex-wrap items-center gap-x-1">
              {NAV_ITEMS.map((entry) =>
                entry.type === 'link' ? (
                  <Link
                    key={entry.label}
                    href={entry.href}
                    className={linkClasses(isActive(pathname, entry.href))}
                    aria-current={isActive(pathname, entry.href) ? 'page' : undefined}
                  >
                    {entry.label}
                  </Link>
                ) : (
                  <NavDropdownMenu key={entry.id} entry={entry} pathname={pathname} active={dropdownActive(entry)} />
                )
              )}
              {isAdmin && (
                <Link
                  href="/admin/benchmarks"
                  className={linkClasses(isActive(pathname, '/admin/benchmarks'))}
                  aria-current={isActive(pathname, '/admin/benchmarks') ? 'page' : undefined}
                >
                  Admin
                </Link>
              )}
              {isAdmin && (
                <Link
                  href="/admin/recommendations"
                  className={linkClasses(isActive(pathname, '/admin/recommendations'))}
                  aria-current={isActive(pathname, '/admin/recommendations') ? 'page' : undefined}
                >
                  Recs Admin
                </Link>
              )}
            </nav>
            <button onClick={signOut} className="ml-4 whitespace-nowrap rounded px-2 py-1.5 text-sm text-gray-600 hover:text-risk">
              Sign out
            </button>
          </div>

          {/* Mobile / tablet hamburger trigger */}
          <button
            type="button"
            data-testid="mobile-menu-trigger"
            className="rounded p-2 text-gray-600 hover:text-trust lg:hidden"
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav-panel"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMobileOpen((o) => !o)}
          >
            {mobileOpen ? <X className="h-6 w-6" aria-hidden="true" /> : <Menu className="h-6 w-6" aria-hidden="true" />}
          </button>
        </div>

        {/* Mobile / tablet panel */}
        {mobileOpen && (
          <nav id="mobile-nav-panel" aria-label="Main" className="max-h-[calc(100vh-4rem)] overflow-y-auto border-t bg-white lg:hidden">
            <ul className="space-y-1 px-4 py-3">
              {NAV_ITEMS.map((entry) =>
                entry.type === 'link' ? (
                  <li key={entry.label}>
                    <Link
                      href={entry.href}
                      className={`block rounded px-3 py-2 text-sm ${isActive(pathname, entry.href) ? 'font-semibold text-trust' : 'text-gray-700'}`}
                      aria-current={isActive(pathname, entry.href) ? 'page' : undefined}
                    >
                      {entry.label}
                    </Link>
                  </li>
                ) : (
                  <li key={entry.id}>
                    <button
                      type="button"
                      aria-expanded={openMobileDropdown === entry.id}
                      aria-controls={`mobile-${entry.id}-group`}
                      onClick={() => setOpenMobileDropdown((o) => (o === entry.id ? null : entry.id))}
                      className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm ${dropdownActive(entry) ? 'font-semibold text-trust' : 'text-gray-700'}`}
                    >
                      {entry.label}
                      <ChevronDown className={`h-4 w-4 transition-transform ${openMobileDropdown === entry.id ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>
                    {openMobileDropdown === entry.id && (
                      <ul id={`mobile-${entry.id}-group`} className="ml-3 space-y-1 border-l pl-3">
                        {entry.items.map((item) => (
                          <li key={item.href}>
                            <Link
                              href={item.href}
                              data-testid={NAV_ITEM_TEST_IDS[item.href]}
                              className={`block rounded px-3 py-2 text-sm ${isActive(pathname, item.href) ? 'font-semibold text-trust' : 'text-gray-600'}`}
                              aria-current={isActive(pathname, item.href) ? 'page' : undefined}
                            >
                              {item.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              )}
              {isAdmin && (
                <li>
                  <Link
                    href="/admin/benchmarks"
                    className={`block rounded px-3 py-2 text-sm ${isActive(pathname, '/admin/benchmarks') ? 'font-semibold text-trust' : 'text-gray-700'}`}
                    aria-current={isActive(pathname, '/admin/benchmarks') ? 'page' : undefined}
                  >
                    Admin
                  </Link>
                </li>
              )}
              {isAdmin && (
                <li>
                  <Link
                    href="/admin/recommendations"
                    className={`block rounded px-3 py-2 text-sm ${isActive(pathname, '/admin/recommendations') ? 'font-semibold text-trust' : 'text-gray-700'}`}
                    aria-current={isActive(pathname, '/admin/recommendations') ? 'page' : undefined}
                  >
                    Recs Admin
                  </Link>
                </li>
              )}
              <li className="border-t pt-1">
                <button onClick={signOut} className="block w-full rounded px-3 py-2 text-left text-sm text-gray-700 hover:text-risk">
                  Sign out
                </button>
              </li>
            </ul>
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}

function NavDropdownMenu({ entry, pathname, active }: { entry: NavDropdown; pathname: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Route changes close the dropdown even when navigation happened some
  // other way than clicking a menu item (browser back/forward, address bar).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid={entry.id === 'forecasting' ? 'nav-forecasting' : undefined}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={`${entry.id}-menu`}
        aria-current={active ? 'page' : undefined}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 rounded px-2 py-1.5 text-sm ${active ? 'font-semibold text-trust' : 'text-gray-600 hover:text-trust'}`}
      >
        {entry.label}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div id={`${entry.id}-menu`} role="menu" aria-label={entry.label} className="absolute left-0 top-full z-20 mt-1 w-44 rounded-card border bg-white py-1 shadow-lg">
          {entry.items.map((item) => {
            const itemActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                data-testid={NAV_ITEM_TEST_IDS[item.href]}
                role="menuitem"
                onClick={() => setOpen(false)}
                aria-current={itemActive ? 'page' : undefined}
                className={`block px-3 py-2 text-sm ${itemActive ? 'font-semibold text-trust' : 'text-gray-700 hover:bg-gray-50 hover:text-trust'}`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
