'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Retirement was removed from the main top-level menu but must remain fully
// reachable and keep its own route (spec: "make it accessible as an internal
// sub-tab ... within Investments"). This renders on both pages so the two
// stay reachable from each other, without merging their content.
const TABS = [
  { label: 'Investments', href: '/investments' },
  { label: 'Retirement', href: '/retirement' },
];

export function InvestmentsSubNav() {
  const pathname = usePathname();
  return (
    <div className="mb-6 border-b" role="tablist" aria-label="Investments and Retirement">
      <div className="flex gap-x-4">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              role="tab"
              aria-selected={active}
              aria-current={active ? 'page' : undefined}
              className={`-mb-px border-b-2 px-1 py-2 text-sm ${
                active ? 'border-trust font-semibold text-trust' : 'border-transparent text-gray-500 hover:text-trust'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
