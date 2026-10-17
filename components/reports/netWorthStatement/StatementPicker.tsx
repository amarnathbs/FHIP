import Link from 'next/link';
import type { NetWorthStatementSet, StatementView } from '@/lib/engines/netWorthStatement';
import { statementViewKey } from '@/lib/engines/netWorthStatement';

/** One option per statement: Personal, each entity, Family, and "All statements". Plain links: keyboard friendly, no client JS. */
export function statementOptions(set: Pick<NetWorthStatementSet, 'entities'>): { key: string; label: string }[] {
  return [
    { key: 'personal', label: 'Personal' },
    ...set.entities.map((e) => ({ key: `entity:${e.entityId}`, label: e.header.subtitle })),
    { key: 'family', label: 'Family (consolidated)' },
    { key: 'all', label: 'All statements' },
  ];
}

export function StatementPicker({ set, view, basePath = '/reports/net-worth-statement' }: { set: NetWorthStatementSet; view: StatementView; basePath?: string }) {
  const current = statementViewKey(view);
  return (
    <nav aria-label="Choose a statement" className="no-print">
      <ul className="flex flex-wrap gap-2" data-testid="nws-picker">
        {statementOptions(set).map((o) => {
          const active = o.key === current;
          return (
            <li key={o.key}>
              <Link
                href={`${basePath}?view=${encodeURIComponent(o.key)}`}
                aria-current={active ? 'page' : undefined}
                className={`inline-block rounded border px-3 py-1.5 text-sm ${active ? 'border-trust bg-trust text-white' : 'text-gray-700 hover:border-trust'}`}
              >
                {o.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
