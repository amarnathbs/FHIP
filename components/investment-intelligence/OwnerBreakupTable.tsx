import { formatMoneyCode } from '@/lib/engines/money';
import { ownerClassHeading, type OwnerClassOption } from './ownerClassUi';

// Investment Intelligence Overview -- "Holdings by owner class" (2026-10-01, PO decision).
//
// One SEPARATE table per owner kind (personal, joint, trust / HUF / company, shared with an
// entity, unallocated), then ONE explicit "Consolidated (macro view only)" line. The macro line
// is exactly the sum of the rows above it (each position counted once) and is labelled as a
// macro summary, never as a personal total: entity-owned data is never silently summed into
// personal figures. Joint rows list each owner's part, divided by the ownership split.
//
// Presentational only: every number arrives already computed from
// /api/investment-intelligence/overview (ownerClass.ts#buildOwnerBreakup). Nothing is derived here.

export interface OwnerBreakupPayload {
  classes: {
    info: { key: string; kind: OwnerClassOption['kind']; label: string; detail: string | null };
    accountCount: number;
    positionCount: number;
    valueByCurrency: { currencyCode: string; totalValue: number; positionCount: number }[];
    ownerAttribution: { ownerKey: string; ownerLabel: string; valueByCurrency: { currencyCode: string; totalValue: number }[] }[] | null;
  }[];
  consolidated: { label: string; note: string; accountCount: number; positionCount: number; valueByCurrency: { currencyCode: string; totalValue: number; positionCount: number }[] };
}

const KIND_ORDER: OwnerClassOption['kind'][] = ['personal', 'joint', 'entity', 'entity_shared', 'unallocated'];

function Values({ items }: { items: { currencyCode: string; totalValue: number }[] }) {
  if (items.length === 0) return <span className="text-muted">No positions yet</span>;
  return (
    <>
      {items.map((v) => (
        <div key={v.currencyCode} className="tabular-nums">
          {formatMoneyCode(v.totalValue, v.currencyCode)}
        </div>
      ))}
    </>
  );
}

export function OwnerBreakupTable({ breakup }: { breakup: OwnerBreakupPayload }) {
  const kinds = KIND_ORDER.filter((k) => breakup.classes.some((c) => c.info.kind === k));
  return (
    <section className="rounded-card border border-line bg-white p-6" aria-labelledby="owner-breakup-heading" data-testid="owner-breakup">
      <h2 id="owner-breakup-heading" className="text-lg font-semibold text-ink">
        Holdings by owner class
      </h2>
      <p className="mt-1 text-sm text-muted">Everything you have uploaded, grouped by who owns it. Each group is complete on its own and is not added to the others.</p>

      {kinds.map((kind) => (
        <div key={kind} className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{ownerClassHeading(kind)}</h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th className="py-1 pr-3 font-medium">Owner</th>
                  <th className="py-1 pr-3 font-medium">Accounts</th>
                  <th className="py-1 pr-3 font-medium">Positions</th>
                  <th className="py-1 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {breakup.classes
                  .filter((c) => c.info.kind === kind)
                  .map((c) => (
                    <tr key={c.info.key} className="border-b border-line align-top">
                      <td className="py-2 pr-3 text-ink">
                        {c.info.label}
                        {c.info.detail && <span className="ml-1 text-xs text-muted">{c.info.detail}</span>}
                        {c.ownerAttribution && (
                          <ul className="mt-1 space-y-0.5 text-xs text-muted">
                            {c.ownerAttribution.map((o) => (
                              <li key={o.ownerKey}>
                                {o.ownerLabel}: {o.valueByCurrency.map((v) => formatMoneyCode(v.totalValue, v.currencyCode)).join(' + ')}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{c.accountCount}</td>
                      <td className="py-2 pr-3 tabular-nums">{c.positionCount}</td>
                      <td className="py-2 text-right">
                        <Values items={c.valueByCurrency} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div className="mt-6 rounded-compact border border-dashed border-line bg-gray-50 p-3" data-testid="owner-breakup-macro">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink">{breakup.consolidated.label}</p>
            <p className="mt-0.5 max-w-xl text-xs text-muted">{breakup.consolidated.note}</p>
            <p className="mt-0.5 text-xs text-muted">
              {breakup.consolidated.accountCount} accounts · {breakup.consolidated.positionCount} positions
            </p>
          </div>
          <div className="text-right text-sm font-semibold">
            <Values items={breakup.consolidated.valueByCurrency} />
          </div>
        </div>
      </div>
    </section>
  );
}
