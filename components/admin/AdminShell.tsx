'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, Menu, X } from 'lucide-react';
import { resolveBreadcrumbs, type AdminArea } from '@/lib/admin/adminAreas';

// Admin A2 — Canonical Admin Shell.
//
// Renders the PO-2-approved 8-area canonical navigation (docs/admin/A1_06,
// A1_07) plus breadcrumbs, for every page under app/(app)/admin/**. This is
// an ADDITIVE layer nested inside the pre-existing app/(app)/layout.tsx ->
// AppShell chrome (which keeps rendering its own sidebar, including its own
// pre-existing "Admin" dropdown, completely unchanged — see
// lib/admin/adminAreas.ts's own header comment for why that module was
// deliberately left untouched). A caller reaches this shell either through
// AppShell's existing links (Benchmarks/Recommendations/Resources
// dashboard/etc, all still present, all still working — Standard §4 nav
// visibility is UX only, this shell doesn't change that) or by navigating
// directly to any /admin/** URL; once inside, this shell's own "Home" link
// and 8-area nav become the in-context way to move around Admin.
//
// `areas` is computed SERVER-SIDE in app/(app)/admin/layout.tsx from the
// caller's real role snapshot (getCurrentResourceRoles()) — this component
// receives an already-authorized, already-filtered nav model as a prop and
// performs no capability check of its own (Standard §4: navigation
// visibility here is derived from, never a substitute for, each page's own
// independent server-side gate).

function isActive(pathname: string, href: string, matchMode: 'exact' | 'prefix'): boolean {
  return matchMode === 'exact' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminShell({ areas, children }: { areas: AdminArea[]; children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [openArea, setOpenArea] = useState<string | null>(() => {
    const { area } = resolveBreadcrumbs(pathname);
    const match = areas.find((a) => a.label === area);
    return match ? match.key : null;
  });
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileNavRef = useRef<HTMLDivElement>(null);

  const { crumbs } = resolveBreadcrumbs(pathname);

  function toggleArea(key: string) {
    setOpenArea((prev) => (prev === key ? null : key));
  }

  // A2 §11/§20 — Escape closes the mobile drawer and returns focus to the
  // control that opened it, exactly like any other disclosure/dialog
  // pattern; a screen-reader or keyboard user is never left with focus
  // trapped inside a drawer that just became hidden.
  useEffect(() => {
    if (!mobileNavOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMobileNavOpen(false);
        mobileTriggerRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen]);

  // A2 §11 — selecting a destination inside the mobile drawer closes it and
  // moves focus to the main content landmark (the correct destination after
  // a navigation, per §7), rather than leaving a closed-but-still-focusable
  // drawer behind.
  function handleMobileNavClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target.closest('a')) {
      setMobileNavOpen(false);
      requestAnimationFrame(() => document.getElementById('admin-main-content')?.focus());
    }
  }

  const renderAreaNav = () => (
    <nav aria-label="Admin areas" className="space-y-1">
      {areas.map((area) => {
        const areaActive = area.subGroups.some((g) => g.items.some((i) => isActive(pathname, i.href, g.matchMode)));
        const isOpen = openArea === area.key;
        // Single-item, single-subgroup areas (Home, Recommendations, Data
        // Governance today) render as a plain link — no need for a
        // disclosure around exactly one destination.
        const isSingleLink = area.subGroups.length === 1 && area.subGroups[0].items.length === 1;
        if (isSingleLink) {
          const item = area.subGroups[0].items[0];
          const active = isActive(pathname, item.href, area.subGroups[0].matchMode);
          return (
            <Link
              key={area.key}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`block rounded px-3 py-2 text-sm font-medium ${
                active ? 'bg-trust/10 text-trust' : 'text-ink hover:bg-app'
              }`}
            >
              {area.label}
            </Link>
          );
        }
        return (
          <div key={area.key}>
            <button
              type="button"
              onClick={() => toggleArea(area.key)}
              aria-expanded={isOpen}
              aria-controls={`admin-area-${area.key}`}
              className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm font-semibold ${
                areaActive ? 'text-trust' : 'text-ink hover:bg-app'
              }`}
            >
              {area.label}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {isOpen && (
              <div id={`admin-area-${area.key}`} className="ml-2 space-y-2 border-l border-line pl-3 py-1">
                {area.subGroups.map((group) => (
                  <div key={group.label}>
                    {area.subGroups.length > 1 && (
                      <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">{group.label}</p>
                    )}
                    <ul className="space-y-0.5">
                      {group.items.map((item) => {
                        const active = isActive(pathname, item.href, group.matchMode);
                        return (
                          <li key={item.href}>
                            <Link
                              href={item.href}
                              aria-current={active ? 'page' : undefined}
                              className={`block rounded px-2 py-1.5 text-sm ${
                                active ? 'bg-trust/10 font-medium text-trust' : 'text-muted hover:bg-app hover:text-ink'
                              }`}
                            >
                              {item.label}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="rounded-card border border-line bg-white">
      {/* Skip link (A2 §20): the first focusable element inside the shell,
          visually hidden until focused, jumping straight past the area nav
          to the main content landmark below. Scoped to the Admin shell only
          — the outer app-wide AppShell has no shell of its own to skip. */}
      <a
        href="#admin-main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:m-2 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-trust focus:shadow focus:outline focus:outline-2 focus:outline-trust"
      >
        Skip to main content
      </a>
      {/* Breadcrumbs + mobile nav trigger. Below `lg` (1024px) the area nav
          collapses behind a disclosure so it doesn't compete for width with
          the outer AppShell sidebar at the narrower required test widths
          (320/360/390/768). */}
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
            <li>
              <Link href="/admin/home" className="hover:text-trust hover:underline">
                Admin
              </Link>
            </li>
            {crumbs.map((crumb, i) => (
              <li key={crumb.href} className="flex items-center gap-1">
                <span aria-hidden="true">/</span>
                {i === crumbs.length - 1 ? (
                  <span aria-current="page" className="font-medium text-ink">
                    {crumb.label}
                  </span>
                ) : (
                  <Link href={crumb.href} className="hover:text-trust hover:underline">
                    {crumb.label}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <button
          ref={mobileTriggerRef}
          type="button"
          data-testid="admin-mobile-nav-trigger"
          className="rounded p-2 text-muted hover:text-ink lg:hidden"
          aria-expanded={mobileNavOpen}
          aria-controls="admin-mobile-nav"
          aria-label={mobileNavOpen ? 'Close Admin navigation' : 'Open Admin navigation'}
          onClick={() => setMobileNavOpen((o) => !o)}
        >
          {mobileNavOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
        </button>
      </div>

      {mobileNavOpen && (
        <div id="admin-mobile-nav" ref={mobileNavRef} onClick={handleMobileNavClick} className="border-b border-line px-4 py-3 lg:hidden">
          {renderAreaNav()}
        </div>
      )}

      <div className="flex flex-col lg:flex-row">
        <aside className="hidden shrink-0 border-r border-line px-3 py-4 lg:block lg:w-56" aria-label="Admin navigation">
          {renderAreaNav()}
        </aside>
        <main id="admin-main-content" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
