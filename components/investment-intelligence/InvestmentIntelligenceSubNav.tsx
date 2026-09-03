'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { II_WORKSPACE_NAV, isIiNavItemActive } from '@/lib/investment-intelligence/workspaceNav';

// II-PC2 — the persistent Investment Intelligence workspace navigation (spec
// section 31). Rendered on all seven workspace pages; the item list and the
// active-route rule live in lib/investment-intelligence/workspaceNav.ts so
// there is exactly ONE nav array in the codebase (spec section 31: "no
// duplicated independent nav arrays across pages") and so both are unit
// testable without a DOM.
//
// ACCESSIBILITY (spec sections 33, 35)
// ------------------------------------
// This is a set of page links, not a tab widget: each item performs a real
// navigation to a distinct URL rather than swapping panels in place. It is
// therefore marked up as a <nav> with a list of links and `aria-current="page"`
// on the active one — deliberately NOT role="tablist"/role="tab", which would
// promise assistive technology an in-page tabpanel relationship that does not
// exist here and would bring arrow-key expectations these links do not honour.
// (components/investments/InvestmentsSubNav.tsx uses the tablist idiom; that
// component is untouched by PC2 and its two entries are out of this
// workspace's scope.)
//
// The status of the active item is conveyed by `aria-current` and by a text
// weight change as well as by colour and the underline bar, so it is never
// colour-alone (spec section 35).
//
// MOBILE (spec section 34): the strip scrolls horizontally INSIDE its own
// container rather than widening the page — an intentional internal scroll,
// which spec section 34 permits, versus page-level overflow, which it forbids.
export function InvestmentIntelligenceSubNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Investment Intelligence sections" className="mb-6 border-b border-line">
      <ul className="-mb-px flex gap-x-1 overflow-x-auto whitespace-nowrap">
        {II_WORKSPACE_NAV.map((item) => {
          const active = isIiNavItemActive(pathname, item.href);
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                aria-label={`${item.label} — ${item.description}`}
                className={`inline-block border-b-2 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 ${
                  active ? 'border-primary font-semibold text-primary' : 'border-transparent text-muted hover:text-primary'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
