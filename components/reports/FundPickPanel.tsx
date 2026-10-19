import { Btn, CheckField } from '@/components/admin/benchmarkData/ui';
import { rupees } from '@/lib/engines/nav2/presentation';
import { boxDisabled, clearAll, selectLargest, toggleFund, type PickState } from '@/lib/reports/fundPicker';

/**
 * "Choose up to N funds for this report" (shown when a person holds more funds than one report covers). Presentational: the parent owns the state and the
 * Generate request. Two real buttons sit above the list: "Clear all" and "Select the N largest" (restores the default); both are the shared Btn (44 px
 * high, focus ring). The selection rules are in lib/reports/fundPicker.ts, so the maximum is enforced in one place.
 */
export function FundPickPanel({
  pick,
  onChange,
  busy,
  onGenerate,
  reportCount,
  onGenerateAll,
}: {
  pick: PickState;
  onChange: (next: PickState) => void;
  busy: boolean;
  onGenerate: (ids: string[]) => void;
  /** How many reports "Generate all my funds" would make (shown on the button); with onGenerateAll. */
  reportCount?: number;
  /** One click for every held fund: the screen makes the reports one after the other, at most `pick.max` funds each. */
  onGenerateAll?: () => void;
}) {
  return (
    <fieldset className="rounded-card border border-line p-4 text-sm text-ink" data-testid="fund-pick">
      <legend className="px-1 font-medium">Choose up to {pick.max} funds for this report</legend>
      <p className="text-muted">
        You hold {pick.heldFundCount} funds. The {pick.max} largest by current value are ticked; untick some and tick others if you prefer. You can make a second report for the rest.
      </p>
      <div className="mt-3 flex flex-wrap gap-2" data-testid="fund-pick-actions">
        <Btn kind="secondary" disabled={pick.chosen.length === 0} onClick={() => onChange(clearAll(pick))}>
          Clear all
        </Btn>
        <Btn kind="secondary" onClick={() => onChange(selectLargest(pick))}>
          Select the {pick.max} largest
        </Btn>
      </div>
      <ul className="mt-3 space-y-1">
        {pick.candidates.map((c) => (
          <li key={c.instrumentId}>
            <CheckField
              label={
                <>
                  {c.schemeName}
                  {c.currentValue !== null && <span className="text-muted"> - {rupees(c.currentValue)}</span>}
                </>
              }
              checked={pick.chosen.includes(c.instrumentId)}
              disabled={boxDisabled(pick, c.instrumentId)}
              onChange={(v) => onChange(toggleFund(pick, c.instrumentId, v))}
            />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-muted" aria-live="polite" data-testid="fund-pick-count">
        {pick.chosen.length} of {pick.max} chosen
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Btn kind="primary" busy={busy} disabled={pick.chosen.length === 0} onClick={() => onGenerate(pick.chosen)}>
          Generate a report for these funds
        </Btn>
        {onGenerateAll && (
          <Btn kind="secondary" busy={busy} onClick={onGenerateAll}>
            Generate all my funds{reportCount ? ` (${reportCount} reports)` : ''}
          </Btn>
        )}
      </div>
    </fieldset>
  );
}
