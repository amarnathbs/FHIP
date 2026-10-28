'use client';

/**
 * Bank statement CSV -- "tell us which column is which" (28-10-2026).
 *
 * Shown when an uploaded CSV's layout is not one the importer recognises (or when a mapping the person gave read the file wrongly and they
 * want to change it). Before this step existed the import ended on a red message and a "Try again" button: a dead end for every bank whose
 * export is not on the importer's list.
 *
 * What it does, in order: lists every column found in THIS file with a few sample values; asks which column is the date, the description
 * and the amount (separate Debit and Credit columns, one signed Amount column, or an Amount column plus a Debit/Credit marker), with
 * optional Balance, Reference, extra description and a second date; suggests columns from the headings but never accepts them silently;
 * shows the first rows exactly as the importer will read them (the same `normalizeRow` the import uses), dates day-first; asks for the date
 * style when the values themselves do not prove it; and only then enables Continue. Continue calls the existing map route (`onConfirm`),
 * and the import carries on from the stored file without a second upload.
 *
 * `BankCsvMappingForm` is the presentational part (everything the person sees, driven by props, renders on the server for the tests).
 * `BankCsvMappingStep` loads the file's columns and sends the answer.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AMOUNT_STYLE_LABELS,
  adviseDateFormat,
  checkMapping,
  draftForStyle,
  EMPTY_DRAFT,
  fieldDefinitions,
  formatDayFirst,
  formatMoney,
  mappingProblems,
  suggestMapping,
  toMapRequest,
  type AmountStyle,
  type MapRequestBody,
  type MappingDraft,
  type MappingField,
} from '@/lib/financial-data-hub/bank-csv/mappingAssist';
import { DATE_FORMAT_LABELS, SUPPORTED_DATE_FORMATS, type SupportedDateFormat } from '@/lib/financial-data-hub/bank-csv/dateFormats';

export interface MappingSample {
  header: string[];
  rows: string[][];
  total_rows: number;
  delimiter: string;
}

export interface MappingFormState {
  draft: MappingDraft;
  style: AmountStyle | null;
  dateFormat: SupportedDateFormat | null;
  /** Fields still showing the pre-selection the headings suggested, not yet touched by the person. */
  suggested: MappingField[];
  allowShared: boolean;
  remember: boolean;
  checked: boolean;
}

const STYLES: AmountStyle[] = ['debit_credit_columns', 'single_signed', 'dr_cr_indicator'];

/** The starting state: header-word suggestions pre-selected, and the date style only when the values prove it. Nothing is accepted. */
export function initialMappingState(sample: MappingSample): MappingFormState {
  const suggestion = suggestMapping(sample.header, sample.rows);
  const advice = adviseDateFormat(sample.header, sample.rows, suggestion.draft.transactionDate);
  const style = suggestion.amountStyle;
  const draft = style ? draftForStyle(suggestion.draft, style) : suggestion.draft;
  return {
    draft,
    style,
    dateFormat: advice.proven,
    suggested: (Object.keys(draft) as MappingField[]).filter((k) => draft[k]),
    allowShared: false,
    remember: true,
    checked: false,
  };
}

function sampleValues(sample: MappingSample, columnIndex: number): string[] {
  const seen: string[] = [];
  for (const row of sample.rows) {
    const v = (row[columnIndex] ?? '').trim();
    if (v && !seen.includes(v)) seen.push(v);
    if (seen.length === 3) break;
  }
  return seen;
}

/** Every date style worth offering for the chosen date column: the ones that read all its values, one per distinct reading. */
function dateStyleOptions(groups: SupportedDateFormat[][]): SupportedDateFormat[] {
  if (groups.length === 0) return [...SUPPORTED_DATE_FORMATS];
  return groups.map((g) => g[0]);
}

export function BankCsvMappingForm({
  sample,
  country,
  mode,
  busy,
  error,
  state,
  onChange,
  onConfirm,
  onCancel,
}: {
  sample: MappingSample;
  country: 'AU' | 'IN';
  mode: 'new' | 'change';
  busy: boolean;
  error: string | null;
  state: MappingFormState;
  onChange: (next: MappingFormState) => void;
  onConfirm: (body: MapRequestBody) => void;
  onCancel: () => void;
}) {
  const { header, rows } = sample;
  const { draft, style, dateFormat, suggested, allowShared, remember, checked } = state;
  const defs = style ? fieldDefinitions(style) : null;
  const dateColumn = draft.transactionDate; // a column heading, not a date
  const advice = useMemo(() => adviseDateFormat(header, rows, draft.transactionDate), [header, rows, draft.transactionDate]);
  const problems = useMemo(() => mappingProblems(header, draft, style, dateFormat, { allowSharedColumns: allowShared }), [header, draft, style, dateFormat, allowShared]);
  const check = useMemo(
    () => (style && dateFormat && problems.length === 0 ? checkMapping(header, rows, draft, style, dateFormat) : null),
    [header, rows, draft, style, dateFormat, problems.length],
  );
  const assignedTo = useMemo(() => {
    const out = new Map<string, string[]>();
    if (!defs) return out;
    for (const f of [...defs.required, ...defs.optional]) {
      const column = draft[f.key];
      if (column) out.set(column, [...(out.get(column) ?? []), f.label]);
    }
    return out;
  }, [defs, draft]);

  const unreadable = check !== null && check.looked > 0 && check.readable === 0;
  const blockers: string[] = problems.map((p) => p.message);
  if (unreadable) blockers.push('None of the rows checked can be read with this assignment. Change the columns or the date style until the preview shows your transactions.');
  if (check && !unreadable && !checked) blockers.push('Tick the box below once you have checked that the preview matches your file.');
  const canContinue = blockers.length === 0 && check !== null && !busy;

  function setField(key: MappingField, column: string) {
    onChange({
      ...state,
      draft: { ...draft, [key]: column || null },
      suggested: suggested.filter((k) => k !== key),
      checked: false,
      // The date style follows the date column: proven again for the new column, or asked.
      dateFormat: key === 'transactionDate' ? adviseDateFormat(header, rows, column || null).proven : dateFormat,
    });
  }
  function setStyle(next: AmountStyle) {
    onChange({ ...state, style: next, draft: draftForStyle(draft, next), checked: false });
  }

  const fieldRow = (key: MappingField, label: string, help: string, required: boolean) => {
    const value = draft[key] ?? '';
    const fieldProblem = problems.find((p) => p.field === key);
    return (
      <div key={key} className="grid gap-1 sm:grid-cols-[14rem_1fr] sm:items-start" data-testid={`map-field-${key}`}>
        <label htmlFor={`map-${key}`} className="text-sm font-medium text-gray-800">
          {label}{' '}
          <span className={required ? 'text-xs font-semibold text-red-700' : 'text-xs font-normal text-gray-500'}>{required ? '(required)' : '(optional)'}</span>
        </label>
        <div>
          <select
            id={`map-${key}`}
            value={value}
            onChange={(e) => setField(key, e.target.value)}
            aria-invalid={Boolean(fieldProblem)}
            aria-describedby={`map-${key}-help`}
            className={`w-full rounded border px-2 py-1 text-sm ${fieldProblem ? 'border-red-400' : 'border-gray-300'}`}
          >
            <option value="">{required ? 'Choose a column' : 'Not used'}</option>
            {header.map((h, i) => {
              const duplicateName = header.filter((x) => x === h).length > 1;
              const blank = !h.trim();
              return (
                <option key={`${i}-${h}`} value={h} disabled={blank || duplicateName}>
                  {blank ? `Column ${i + 1} (no heading, cannot be used)` : duplicateName ? `${h} (name used twice, cannot be used)` : h}
                </option>
              );
            })}
          </select>
          <p id={`map-${key}-help`} className="mt-0.5 text-xs text-gray-600">
            {help}
            {value && suggested.includes(key) ? <span className="ml-1 font-medium text-blue-800">Suggested from the column heading. Check it.</span> : null}
          </p>
          {fieldProblem ? <p className="mt-0.5 text-xs text-red-700">{fieldProblem.message}</p> : null}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5" data-testid="bank-csv-mapping-step">
      <div>
        <h3 className="text-base font-semibold text-gray-900">{mode === 'change' ? 'Change which column is which' : 'Tell us which column is which'}</h3>
        <p className="mt-1 text-sm text-gray-700">
          {mode === 'change'
            ? 'Choose the columns again. Your file is already uploaded, so you do not need to upload it again. The lines read the first time are replaced; nothing you approved is touched.'
            : 'We could read your file, but we do not recognise its layout, which happens with many banks. Match each column in your file to what we need and check the preview. Your file is already uploaded, so the import carries on as soon as you continue. You do not need to upload it again.'}
        </p>
      </div>

      <section aria-labelledby="map-found">
        <h4 id="map-found" className="text-sm font-semibold text-gray-900">
          Columns found in your file ({header.length}), with sample values
        </h4>
        <div className="mt-2 max-h-72 overflow-auto rounded border border-gray-200">
          <table className="min-w-full text-left text-xs">
            <thead className="sticky top-0 bg-gray-50 text-gray-600">
              <tr>
                <th scope="col" className="px-2 py-1">#</th>
                <th scope="col" className="px-2 py-1">Column heading</th>
                <th scope="col" className="px-2 py-1">Sample values</th>
                <th scope="col" className="px-2 py-1">Used for</th>
              </tr>
            </thead>
            <tbody>
              {header.map((h, i) => (
                <tr key={`${i}-${h}`} className="border-t border-gray-100 align-top">
                  <td className="px-2 py-1 text-gray-500">{i + 1}</td>
                  <td className="px-2 py-1 font-medium text-gray-900">{h || <span className="font-normal text-gray-500">(no heading)</span>}</td>
                  <td className="px-2 py-1 text-gray-700">
                    {sampleValues(sample, i).map((v) => (
                      <span key={v} className="mr-1 inline-block rounded bg-gray-100 px-1.5 py-0.5">{v}</span>
                    ))}
                  </td>
                  <td className="px-2 py-1 text-gray-700">{(assignedTo.get(h) ?? []).join(', ') || <span className="text-gray-400">Not used</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-gray-600">Columns you do not use are ignored (for example an account number: the account was chosen before you uploaded).</p>
      </section>

      <section aria-labelledby="map-style" className="space-y-2">
        <h4 id="map-style" className="text-sm font-semibold text-gray-900">How does your file show the amount?</h4>
        <div role="radiogroup" aria-labelledby="map-style" className="space-y-1">
          {STYLES.map((s) => (
            <label key={s} className="flex items-start gap-2 text-sm text-gray-800">
              <input type="radio" name="amount-style" value={s} checked={style === s} onChange={() => setStyle(s)} className="mt-1" />
              <span>{AMOUNT_STYLE_LABELS[s]}</span>
            </label>
          ))}
        </div>
        {!style ? <p className="text-xs text-red-700">The column headings do not tell us. Choose the way your file shows the amount.</p> : null}
      </section>

      {defs ? (
        <section aria-labelledby="map-fields" className="space-y-3">
          <h4 id="map-fields" className="text-sm font-semibold text-gray-900">Match your columns to what we need</h4>
          {defs.required.map((f) => fieldRow(f.key, f.label, f.help, true))}
          {defs.optional.map((f) => fieldRow(f.key, f.label, f.help, false))}
          <label className="flex items-start gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={allowShared} onChange={(e) => onChange({ ...state, allowShared: e.target.checked, checked: false })} className="mt-0.5" />
            <span>Allow one column to be used for two fields (only if your file really holds two things in one column).</span>
          </label>
        </section>
      ) : null}

      {dateColumn ? (
        <section aria-labelledby="map-dates" className="space-y-2" data-testid="map-date-style">
          <h4 id="map-dates" className="text-sm font-semibold text-gray-900">How does your file write dates?</h4>
          {advice.proven ? (
            <p className="text-sm text-gray-800">
              Every date in &quot;{dateColumn}&quot; reads only one way: <strong>{DATE_FORMAT_LABELS[advice.proven]}</strong>. There is no doubt about the order.
            </p>
          ) : advice.unreadable ? (
            <p className="text-sm text-red-700">
              We cannot read the dates in &quot;{dateColumn}&quot; (for example &quot;{advice.firstUnreadable}&quot;) in any date style we support. Check that this is the right column, or choose the closest style below.
            </p>
          ) : advice.groups.length > 1 ? (
            <p className="text-sm text-amber-900">
              The dates in &quot;{dateColumn}&quot; could mean different days depending on the order, so we will not guess. Choose how your bank writes them.
            </p>
          ) : null}
          {!advice.proven ? (
            <select
              aria-label="Date style"
              value={dateFormat ?? ''}
              onChange={(e) => onChange({ ...state, dateFormat: (e.target.value || null) as SupportedDateFormat | null, checked: false })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="">Choose a date style</option>
              {dateStyleOptions(advice.groups).map((f) => (
                <option key={f} value={f}>{DATE_FORMAT_LABELS[f]}</option>
              ))}
            </select>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="map-preview" data-testid="map-preview">
        <h4 id="map-preview" className="text-sm font-semibold text-gray-900">How we will read your first rows</h4>
        {check ? (
          <>
            <div className="mt-2 overflow-x-auto rounded border border-gray-200">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th scope="col" className="px-2 py-1">Row</th>
                    <th scope="col" className="px-2 py-1">Date</th>
                    <th scope="col" className="px-2 py-1">Description</th>
                    <th scope="col" className="px-2 py-1 text-right">Money out</th>
                    <th scope="col" className="px-2 py-1 text-right">Money in</th>
                    {draft.balance ? <th scope="col" className="px-2 py-1 text-right">Balance</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {check.lines.map((l) => (
                    <tr key={l.rowNumber} className={`border-t border-gray-100 ${l.ok ? '' : 'bg-red-50'}`}>
                      <td className="px-2 py-1 text-gray-500">{l.rowNumber}</td>
                      {l.ok ? (
                        <>
                          <td className="px-2 py-1 whitespace-nowrap">{formatDayFirst(l.dateIso, country)}</td>
                          <td className="px-2 py-1">{l.description}</td>
                          <td className="px-2 py-1 text-right">{l.direction === 'debit' ? formatMoney(l.amount, country) : ''}</td>
                          <td className="px-2 py-1 text-right">{l.direction === 'credit' ? formatMoney(l.amount, country) : ''}</td>
                          {draft.balance ? <td className="px-2 py-1 text-right">{formatMoney(l.balance, country)}</td> : null}
                        </>
                      ) : (
                        <td className="px-2 py-1 text-red-800" colSpan={draft.balance ? 5 : 4}>
                          Cannot be read: {l.reason}.
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-xs text-gray-600">
              {check.readable} of the first {check.looked} rows can be read{sample.total_rows > check.looked ? ` (your file has ${sample.total_rows} rows in all)` : ''}.
            </p>
            {check.warnings.map((w) => (
              <p key={w} className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">{w}</p>
            ))}
          </>
        ) : (
          <p className="mt-1 text-sm text-gray-600">The preview appears here once the required fields and the date style are chosen.</p>
        )}
      </section>

      {check && !unreadable ? (
        <label className="flex items-start gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={checked} onChange={(e) => onChange({ ...state, checked: e.target.checked })} className="mt-0.5" />
          <span>I have checked the preview above and it matches my file.</span>
        </label>
      ) : null}

      <label className="flex items-start gap-2 text-sm text-gray-800">
        <input type="checkbox" checked={remember} onChange={(e) => onChange({ ...state, remember: e.target.checked })} className="mt-0.5" />
        <span>
          Remember this layout. The next time you upload a file with exactly these columns, we will read it the same way and will not ask again. You can always change it afterwards.
        </span>
      </label>

      {error ? (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p>
      ) : null}

      {!canContinue && blockers.length > 0 ? (
        <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800" data-testid="map-blockers">
          <p className="font-medium">Before you can continue:</p>
          <ul className="mt-1 list-disc pl-5">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!canContinue}
          onClick={() => style && dateFormat && onConfirm(toMapRequest(draft, style, dateFormat, sample.delimiter, { remember, allowSharedColumns: allowShared }))}
          className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
          data-testid="map-continue"
        >
          {busy ? 'Saving...' : 'Continue with these columns'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="rounded border border-gray-300 px-3 py-1 text-sm">
          Cancel and start again
        </button>
      </div>
    </div>
  );
}

/**
 * Loads the file's columns, shows the form, sends the answer to the map route. `onConfirmed` is called once the mapping is saved; the caller
 * then carries on with the import (no second upload).
 */
export function BankCsvMappingStep({
  documentId,
  country,
  mode,
  onConfirmed,
  onCancel,
}: {
  documentId: string;
  country: 'AU' | 'IN';
  mode: 'new' | 'change';
  onConfirmed: (result: { remembered: boolean }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [sample, setSample] = useState<MappingSample | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<MappingFormState>({ draft: EMPTY_DRAFT, style: null, dateFormat: null, suggested: [], allowShared: false, remember: true, checked: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/financial-data-hub/bank-csv/${documentId}/columns`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !json.data) {
          setLoadError((json.message as string | undefined) ?? (json.error as string | undefined) ?? 'We could not read the columns of your file.');
          return;
        }
        const s = json.data as MappingSample;
        setSample(s);
        setState(initialMappingState(s));
      } catch {
        if (!cancelled) setLoadError('We could not reach the server to read the columns of your file. Check your connection and try again.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId, reload]);

  async function confirm(body: MapRequestBody) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/financial-data-hub/bank-csv/${documentId}/map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((json.message as string | undefined) ?? (json.error as string | undefined) ?? 'We could not save this column choice. Please check it and try again.');
        setBusy(false);
        return;
      }
      await onConfirmed({ remembered: body.save_as_reusable_template });
    } catch {
      setError('We could not reach the server to save your choice. Check your connection and press Continue again.');
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="space-y-3" data-testid="bank-csv-mapping-load-error">
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{loadError}</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => {
              setLoadError(null);
              setReload((n) => n + 1);
            }} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Try again
          </button>
          <button type="button" onClick={onCancel} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Cancel and start again
          </button>
        </div>
      </div>
    );
  }
  if (!sample) return <p className="text-sm text-gray-600">Reading the columns of your file...</p>;
  return <BankCsvMappingForm sample={sample} country={country} mode={mode} busy={busy} error={error} state={state} onChange={setState} onConfirm={confirm} onCancel={onCancel} />;
}
