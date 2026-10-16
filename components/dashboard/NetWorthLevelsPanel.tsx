import { formatMoneyWhole } from '@/lib/engines/money';
import { DataTable, DataTd, DataTh } from '@/components/ui/DataTable';
import {
  NET_WORTH_ENTITY_KIND_LABELS,
  type NetWorthEntityBlock,
  type NetWorthLevels,
  type Totals,
} from '@/lib/engines/netWorthLevels';

/**
 * Net Worth at two levels -- the ONE presentation shared by the Dashboard Net Worth section and the
 * Monthly Report (PO decision 16-10-2026). Purely presentational: every figure comes from the
 * NetWorthLevels model; nothing is recomputed here. Personal and entity figures are never blended in
 * one row: the family level is shown as an explicit sum of the personal level and each entity.
 */

type Currency = 'AUD' | 'INR';

function basisText(b: NetWorthEntityBlock): string {
  if (b.source === 'owner_tag') return b.kind === 'smsf' ? 'In full' : 'As entered (owner tag)';
  return b.basis === 'ownership_share' ? `Your ${b.includedPercent}% share` : 'In full';
}

function Row({ label, sub, t, currency, strong }: { label: string; sub?: string; t: Totals; currency: Currency; strong?: boolean }) {
  const cls = strong ? 'font-semibold text-ink' : 'text-ink';
  return (
    <tr className="border-t border-line">
      <th scope="row" className={`py-2 pr-3 text-left align-top text-sm ${strong ? 'font-semibold' : 'font-normal'} ${cls}`}>
        {label}
        {sub && <span className="block text-xs font-normal text-muted">{sub}</span>}
      </th>
      <DataTd kind="num" className={`align-top text-sm ${cls}`}>{formatMoneyWhole(t.totalAssets, currency)}</DataTd>
      <DataTd kind="num" className={`align-top text-sm ${cls}`}>{formatMoneyWhole(t.liabilities, currency)}</DataTd>
      <DataTd kind="num" className={`align-top text-sm font-semibold ${cls}`}>{formatMoneyWhole(t.net, currency)}</DataTd>
    </tr>
  );
}

function Head({ first }: { first: string }) {
  return (
    <thead>
      <tr>
        <DataTh className="text-left text-xs font-medium text-muted">{first}</DataTh>
        <DataTh kind="num" className="text-xs font-medium text-muted">Assets</DataTh>
        <DataTh kind="num" className="text-xs font-medium text-muted">Liabilities</DataTh>
        <DataTh kind="num" className="text-xs font-medium text-muted">Net worth</DataTh>
      </tr>
    </thead>
  );
}

export function NetWorthLevelsPanel({ levels }: { levels: NetWorthLevels }) {
  const currency: Currency = levels.currency === 'INR' ? 'INR' : 'AUD';
  const fmt = (n: number) => formatMoneyWhole(n, currency);
  const { personal, entities, family } = levels;
  const unexplained = levels.bridge.lines.find((l) => l.key === 'unexplained');
  const explained = levels.bridge.lines.filter((l) => l.key !== 'unexplained');

  return (
    <div className="space-y-6" data-testid="net-worth-levels">
      {/* ---- Level 1: personal ---- */}
      <section aria-labelledby="nw-personal-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <h3 id="nw-personal-heading" className="text-base font-semibold text-ink">Personal net worth</h3>
          <p className="text-lg font-semibold tabular-nums text-ink" data-testid="net-worth-personal-total">{fmt(personal.total.net)}</p>
        </div>
        <p className="mt-1 text-sm text-muted">{levels.explanation.personal}</p>
        <div className="mt-3">
          <DataTable label="Personal net worth by person">
            <caption className="sr-only">Personal net worth by person</caption>
            <Head first="Person" />
            <tbody>
              {personal.parties.map((p) => (
                <Row
                  key={p.key}
                  label={p.label}
                  sub={p.jointShare.totalAssets !== 0 || p.jointShare.liabilities !== 0 ? `includes ${fmt(p.jointShare.net)} net from joint items` : undefined}
                  t={p.total}
                  currency={currency}
                />
              ))}
              <Row label="Personal total" t={personal.total} currency={currency} strong />
            </tbody>
          </DataTable>
        </div>
        {levels.explanation.jointSplit && <p className="mt-2 text-xs text-muted">{levels.explanation.jointSplit}</p>}
      </section>

      {/* ---- Entities ---- */}
      {levels.hasEntities && (
        <section aria-labelledby="nw-entities-heading">
          <h3 id="nw-entities-heading" className="text-base font-semibold text-ink">Entities (kept separate from your personal figures)</h3>
          <div className="mt-3">
            <DataTable label="Entity net worth included in the family level">
              <caption className="sr-only">Entity net worth included in the family level</caption>
              <Head first="Entity" />
              <tbody>
                {entities.blocks.map((b) => (
                  <Row
                    key={b.id}
                    label={`${NET_WORTH_ENTITY_KIND_LABELS[b.kind]}: ${b.name}`}
                    sub={`${basisText(b)}${b.note ? `. ${b.note}` : ''}`}
                    t={b.included}
                    currency={currency}
                  />
                ))}
                <Row label="Entities total" t={entities.total} currency={currency} strong />
              </tbody>
            </DataTable>
          </div>
        </section>
      )}

      {/* ---- Level 2: consolidated family ---- */}
      <section aria-labelledby="nw-family-heading" className="rounded-card border border-line bg-app p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <h3 id="nw-family-heading" className="text-base font-semibold text-ink">Family net worth (consolidated)</h3>
          <p className="text-lg font-semibold tabular-nums text-ink" data-testid="net-worth-family-total">{fmt(family.net)}</p>
        </div>
        <p className="mt-1 text-sm text-muted">{levels.explanation.family}</p>
        <ul className="mt-3 space-y-1 text-sm" aria-label="How the family figure is made up">
          {levels.reconciliation.map((l, i) => (
            <li key={l.key} className={`flex justify-between gap-3 ${i === levels.reconciliation.length - 1 ? 'border-t border-line pt-1 font-semibold text-ink' : 'text-ink'}`}>
              <span>{i > 0 && i < levels.reconciliation.length - 1 ? '+ ' : i === levels.reconciliation.length - 1 ? '= ' : ''}{l.label}</span>
              <span className="tabular-nums">{fmt(l.net)}</span>
            </li>
          ))}
        </ul>
        {levels.bridge.previouslyReported !== null && explained.length > 0 && (
          <div className="mt-3 text-xs text-muted" data-testid="net-worth-bridge">
            <p>
              Net worth was previously reported as {fmt(levels.bridge.previouslyReported)}. That earlier figure is the family figure adjusted by:
            </p>
            <ul className="mt-1 list-disc pl-5">
              {explained.map((l) => (
                <li key={l.key}>
                  {l.label}: {l.amount >= 0 ? '+' : '-'}{fmt(Math.abs(l.amount))}
                </li>
              ))}
            </ul>
          </div>
        )}
        {unexplained && (
          <p className="mt-2 text-xs font-medium text-ink" role="status">
            Check: {unexplained.label}: {unexplained.amount >= 0 ? '+' : '-'}{fmt(Math.abs(unexplained.amount))}.
          </p>
        )}
      </section>

      {levels.bridge.personalParityOk === false && levels.bridge.personalSummaryNet !== null && (
        <p className="text-xs font-medium text-ink" role="status" data-testid="net-worth-personal-parity-check">
          Check: the personal net worth used by your scores and forecasts ({fmt(levels.bridge.personalSummaryNet)}) differs from the personal level above ({fmt(personal.total.net)}). Please report this.
        </p>
      )}
      {levels.dataStatus.smsfPossibleDoubleCount && (
        <p className="text-xs font-medium text-ink" role="status" data-testid="net-worth-smsf-double-count">Check: {levels.dataStatus.smsfPossibleDoubleCount}</p>
      )}
      {levels.dataStatus.duplicateRisk && <p className="text-xs font-medium text-ink" role="status">Check: {levels.dataStatus.duplicateRisk}</p>}
      {levels.dataStatus.unconvertedCount > 0 && (
        <p className="text-xs text-muted" role="status">
          {levels.dataStatus.unconvertedCount} item{levels.dataStatus.unconvertedCount === 1 ? ' is' : 's are'} in a currency that cannot be converted and {levels.dataStatus.unconvertedCount === 1 ? 'is' : 'are'} left out of every figure above, not counted as zero.
        </p>
      )}
    </div>
  );
}
