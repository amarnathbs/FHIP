'use client';

/**
 * The Income grid's take-home presentation (PO request 17-10-2026): the Take-home cell of the desktop table, the same figure on the mobile
 * card, and the live result under the Net Amount / Tax fields of the Add / Edit form. All meaning lives in lib/grid/incomeTakeHome.ts, which
 * applies the ONE net-basis rule (lib/engines/incomeNetBasis.ts); this only renders it. Money is formatted exactly like the Amount column
 * (formatMoneyWhole, the row's own currency).
 *
 * The assumed-gross basis uses the amber note style the Dashboard and the Income page already use for the same fact (PO decision 16-10-2026:
 * when take-home is unknown the gross is assumed and must be highlighted). The basis is always TEXT, never colour alone.
 */
import { formatMoneyWhole } from '@/lib/engines/money';
import { NET_BASIS_LABELS } from '@/lib/engines/incomeNetBasis';
import {
  TAKE_HOME_BASIS_LIVE,
  TAKE_HOME_BASIS_SHORT,
  TAKE_HOME_PERIOD_WORDS,
  incomeTakeHome,
  takeHomeHint,
  type IncomeTakeHome,
  type IncomeTakeHomeRow,
} from '@/lib/grid/incomeTakeHome';

type Currency = 'AUD' | 'INR';
const money = (n: number, currency: string) => formatMoneyWhole(n, (currency === 'INR' ? 'INR' : 'AUD') as Currency);

/** Classes of the basis label: the assumed-gross wording is highlighted in the existing amber note style. */
export function basisChipClass(basis: IncomeTakeHome['basis']): string {
  return basis === 'assumed_gross'
    ? 'inline-block rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900'
    : 'text-xs text-muted';
}

function fullDescription(t: IncomeTakeHome, currency: string): string {
  const period = t.frequency ? TAKE_HOME_PERIOD_WORDS[t.frequency] : '';
  const parts = [`Take-home ${money(t.net, currency)} ${period}`.trim(), NET_BASIS_LABELS[t.basis]];
  if (t.hasAnnualEquivalent && t.frequency !== 'annually') parts.splice(1, 0, `${money(t.annualNet, currency)} a year`);
  return parts.join('. ');
}

/**
 * The take-home of one saved row. `layout="cell"` is the desktop table cell content (figure, basis label, and the Add take-home control
 * when the take-home is only assumed); `layout="card"` is the mobile card line.
 */
export function TakeHomeDisplay({
  row,
  currency,
  itemLabel,
  layout,
  onAddTakeHome,
}: {
  row: IncomeTakeHomeRow;
  currency: string;
  itemLabel: string;
  layout: 'cell' | 'card';
  onAddTakeHome?: () => void;
}) {
  const t = incomeTakeHome(row);
  if (!t) return <span className="text-muted">-</span>;
  const hint = takeHomeHint(t);
  const periodic = t.frequency !== null && t.frequency !== 'annually';
  const period = t.frequency && periodic ? TAKE_HOME_PERIOD_WORDS[t.frequency] : null;
  const annualSuffix = t.hasAnnualEquivalent && periodic && t.basis !== 'assumed_gross' ? ` · ${money(t.annualNet, currency)} a year` : '';
  return (
    <div data-testid="income-take-home" data-basis={t.basis} title={fullDescription(t, currency)} className={layout === 'card' ? 'mt-1' : undefined}>
      <p className={layout === 'cell' ? 'whitespace-nowrap' : 'text-xs text-ink'}>
        {layout === 'card' && <span className="text-muted">Take-home </span>}
        <span className="font-medium tabular-nums">{money(t.net, currency)}</span>
        {period && <span className="text-xs text-muted"> {period}</span>}
      </p>
      <p>
        <span data-take-home-basis={t.basis} className={basisChipClass(t.basis)}>
          {TAKE_HOME_BASIS_SHORT[t.basis]}
        </span>
        {annualSuffix && <span className="text-xs text-muted">{annualSuffix}</span>}
      </p>
      {hint && (
        <p className="text-xs text-amber-900" title={hint.long} data-testid="income-take-home-hint">
          {hint.short}
        </p>
      )}
      {t.basis === 'assumed_gross' && onAddTakeHome && (
        <button
          type="button"
          onClick={onAddTakeHome}
          aria-label={`Add take-home for ${itemLabel}`}
          className="mt-1 inline-flex min-h-[24px] items-center text-xs font-medium text-trust hover:underline"
        >
          Add take-home
        </button>
      )}
    </div>
  );
}

/** The result under the form's Net Amount and Tax fields, recalculated as the user types. */
export function TakeHomeLive({ draft }: { draft: IncomeTakeHomeRow & { currency_code?: unknown } }) {
  const currency = typeof draft.currency_code === 'string' ? draft.currency_code : 'AUD';
  const t = incomeTakeHome(draft);
  return (
    <div data-testid="income-take-home-live" role="status" aria-live="polite" aria-atomic="true" className="max-w-xl text-xs">
      {!t ? (
        <p className="text-muted">Enter the gross amount and the frequency to see the take-home.</p>
      ) : (
        <>
          <p className={t.basis === 'assumed_gross' ? 'rounded border border-amber-300 bg-amber-50 p-2 text-amber-900' : 'text-ink'}>
            {!t.frequency
              ? `Take-home = ${money(t.net, currency)} (${TAKE_HOME_BASIS_LIVE[t.basis]}). Choose a frequency to see it per year.`
              : t.frequency === 'one_off'
                ? `Take-home = ${money(t.net, currency)} one-off (${TAKE_HOME_BASIS_LIVE[t.basis]})`
                : `Take-home = ${money(t.annualNet, currency)} per year (${TAKE_HOME_BASIS_LIVE[t.basis]})${
                    t.frequency === 'annually' ? '' : `, ${money(t.net, currency)} ${TAKE_HOME_PERIOD_WORDS[t.frequency]}`
                  }`}
          </p>
          {takeHomeHint(t) && <p className="mt-1 text-caution">{takeHomeHint(t)!.long}</p>}
        </>
      )}
    </div>
  );
}
