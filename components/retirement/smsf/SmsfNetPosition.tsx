import { formatMoneySafe } from './format';
import type { CurrencyCode } from './types';

// The fund's net position. When the fund is itemised the net is DERIVED (assets minus liabilities) and shown read-only: there is no
// input for it anywhere on the screen. A fund that owes more than it owns shows a negative net, in words as well as colour.
export function SmsfNetPosition({
  assets,
  liabilities,
  currency,
  note,
}: {
  assets: number;
  liabilities: number;
  currency: CurrencyCode;
  note?: string;
}) {
  const net = Math.round((assets - liabilities) * 100) / 100;
  const underwater = net < 0;
  return (
    <div className="rounded-card border border-line bg-app p-3" aria-label="Net position of the fund">
      <h4 className="text-sm font-semibold text-ink">Net position (worked out for you)</h4>
      <dl className="mt-2 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted">Assets</dt>
          <dd className="font-semibold tabular-nums text-ink">{formatMoneySafe(assets, currency)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Liabilities</dt>
          <dd className="font-semibold tabular-nums text-ink">{formatMoneySafe(liabilities, currency)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Net (assets minus liabilities)</dt>
          <dd role="status" aria-live="polite" className={`font-semibold tabular-nums ${underwater ? 'text-risk' : 'text-ink'}`}>
            {formatMoneySafe(net, currency)}
            {underwater ? ' (the fund owes more than it owns)' : ''}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-muted">
        {note ?? 'You do not type the net: change an asset or a liability and it updates. This is the figure used in your family net worth.'}
      </p>
    </div>
  );
}
