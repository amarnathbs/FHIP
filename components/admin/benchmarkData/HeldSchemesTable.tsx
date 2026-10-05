'use client';

// The held-schemes table, laid out to stay compact:
//   * the scheme name is the SHORT display name, clamped to two lines (line-clamp-2); the full name and the
//     name as printed on the statement live in the "Details" view and in a title tooltip, never as extra lines;
//   * the benchmark sentence is clamped to two lines with the full text in a title;
//   * columns have minimum widths, the table scrolls horizontally INSIDE its own container (never the page),
//     and the Action column is sticky on the right so it is always visible;
//   * rows stay about 2-3 lines tall.
// Dates are day-first via formatDate (INR, dd-mm-yyyy). Tooltips are `title`s for the mouse; the same text is
// reachable by keyboard through the Details button (aria-expanded).
import { useState } from 'react';
import type { HeldSchemeRow } from '@/lib/services/investment-intelligence/benchmarkData/heldSchemes';
import { formatDate } from './benchmarkDataUiLogic';
import { Btn, Chip, ScrollTable, Td, Th } from './ui';

/** Class names that carry the layout rules (the source-contract test pins them). */
/** The VISIBLE Action label: short and constant. The scheme name goes in aria-label and title only. */
export const HELD_ACTION_LABEL = 'Enter declared benchmark';

export const HELD_TABLE_LAYOUT = {
  nameClamp: 'line-clamp-2',
  textClamp: 'line-clamp-2',
  schemeMin: 'min-w-[17rem]',
  fundHouseMin: 'min-w-[7rem]',
  categoryMin: 'min-w-[8rem]',
  holdersMin: 'min-w-[6.5rem]',
  firstHeldMin: 'min-w-[6.5rem]',
  benchmarkMin: 'min-w-[17rem]',
  factsheetCheckMin: 'min-w-[11rem]',
  actionSticky: 'sticky right-0 z-10 w-[11.5rem] min-w-[11.5rem] border-l border-line',
  tableMin: 'min-w-[1150px]',
} as const;

const L = HELD_TABLE_LAYOUT;

/** "HDFC Mutual Fund" -> "HDFC". */
export function shortFundHouse(name: string | null): string {
  if (!name) return 'Unknown';
  return name.replace(/\s+mutual\s+fund\s*$/i, '').trim() || name;
}

export default function HeldSchemesTable({ rows, canPropose, onEnterDeclared }: { rows: HeldSchemeRow[]; canPropose: boolean; onEnterDeclared: (h: HeldSchemeRow) => void }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <ScrollTable label="Held schemes and the benchmark that applies" minWidth={L.tableMin}>
      <thead>
        <tr>
          <Th className={L.schemeMin}>Scheme</Th>
          <Th className={L.fundHouseMin}>Fund house</Th>
          <Th className={L.categoryMin}>Category</Th>
          <Th className={L.holdersMin}>Holders</Th>
          <Th className={L.firstHeldMin}>First held</Th>
          <Th className={L.benchmarkMin}>Benchmark that applies</Th>
          <Th className={L.factsheetCheckMin}>Last factsheet check</Th>
          <Th className={`bg-gray-50 ${L.actionSticky}`}>Action</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h) => {
          const isOpen = open.has(h.instrumentId);
          const tooltip = `${h.fullName}. ${h.planType}. As printed on the statement: ${h.originalName}`;
          const benchmarkText =
            h.benchmark.kind === 'declared'
              ? h.benchmark.label
              : h.benchmark.kind === 'declared_unsupported'
                ? `${h.benchmark.message}. No category benchmark and no comparison number are shown for this scheme.`
                : h.benchmark.kind === 'category_reference'
                ? `${h.benchmark.basisLabel}${h.benchmark.unsure ? '. Less certain choice for this category.' : ''}${h.status === 'proposal_waiting' ? ' A declared benchmark is waiting for review.' : ''}`
                : h.benchmark.message;
          const differs = h.benchmark.kind === 'category_reference' ? h.benchmark.declaredDiffers : null;
          return (
            <tr key={h.instrumentId}>
              <Td className={L.schemeMin}>
                <p className={`${L.nameClamp} font-medium text-ink`} title={tooltip}>
                  {h.displayName}
                </p>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                  <span>{h.planType === 'Not stated in the name' ? 'Plan not in name' : h.planType}</span>
                  <button type="button" onClick={() => toggle(h.instrumentId)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${h.displayName}`} className="font-semibold text-trust underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust">
                    {isOpen ? 'Hide details' : 'Details'}
                  </button>
                </div>
                {isOpen ? (
                  <dl className="mt-1 whitespace-normal break-words text-xs text-muted">
                    <dt className="font-semibold">Name</dt>
                    <dd>{h.fullName}{h.nameSource === 'scheme_master' ? ' (AMFI scheme name)' : ' (from the statement)'}</dd>
                    <dt className="mt-1 font-semibold">As printed on the statement</dt>
                    <dd>{h.originalName}</dd>
                  </dl>
                ) : null}
              </Td>
              <Td className={L.fundHouseMin}>
                <span className="block truncate" title={h.amcName ?? undefined}>{shortFundHouse(h.amcName)}</span>
              </Td>
              <Td className={L.categoryMin}>
                <span className="block">{h.category}</span>
                {h.categorySource === 'name_hint' ? <span className="block text-xs text-muted">Guessed from the name</span> : null}
              </Td>
              <Td className={L.holdersMin}>{h.holderCount === null ? <span className="text-xs text-muted">Fewer than 10 holders</span> : h.holderCount}</Td>
              <Td className={L.firstHeldMin}>{h.firstHeldDate ? formatDate(h.firstHeldDate) : <span className="text-xs text-muted">Not shown</span>}</Td>
              <Td className={L.benchmarkMin}>
                <div className="flex flex-wrap items-center gap-1">
                  {h.benchmark.kind === 'declared' ? (
                    <Chip label="Declared (admin)" tone="ok" />
                  ) : h.benchmark.kind === 'declared_unsupported' ? (
                    <Chip label={h.benchmark.status === 'declared_unsupported' ? 'Declared, cannot be compared' : 'Declared, awaiting review'} tone="warn" title={h.benchmark.message} />
                  ) : h.benchmark.kind === 'category_reference' ? (
                    <Chip label={`Category: ${h.benchmark.benchmarkLabel}`} tone="info" title={h.benchmark.benchmarkLabel} />
                  ) : (
                    <Chip label="No benchmark for this category" tone="neutral" />
                  )}
                  {differs ? <Chip label="Declared differs - enter declared" tone="warn" title={`Declared benchmark differs from category benchmark - enter declared. The fund's own document names ${differs.declaredName} (${differs.evidenceRef}; evidence: ${differs.evidenceStatus}).`} /> : null}
                </div>
                <p className={`${L.textClamp} mt-1 whitespace-normal text-xs text-muted`} title={differs ? `${benchmarkText} Declared benchmark differs from category benchmark - enter declared (${differs.declaredName}).` : benchmarkText}>
                  {differs ? `Declared benchmark differs from category benchmark - enter declared (its document names ${differs.declaredName}).` : benchmarkText}
                </p>
              </Td>
              <Td className={L.factsheetCheckMin}>
                {h.factsheetCheck ? (
                  <>
                    <span className="block">{formatDate(h.factsheetCheck.checkedAt)}</span>
                    <p className={`${L.textClamp} whitespace-normal text-xs text-muted`} title={`${h.factsheetCheck.result}${h.factsheetCheck.documentDate ? `; document dated ${formatDate(h.factsheetCheck.documentDate)}` : ''}`}>
                      {h.factsheetCheck.result}
                      {h.factsheetCheck.documentDate ? `; document dated ${formatDate(h.factsheetCheck.documentDate)}` : ''}
                    </p>
                  </>
                ) : (
                  <span className="text-xs text-muted">Never checked</span>
                )}
              </Td>
              <Td className={`bg-white ${L.actionSticky}`}>
                {canPropose && h.status === 'not_mapped' ? (
                  <Btn kind="secondary" nowrap onClick={() => onEnterDeclared(h)} ariaLabel={`Enter declared benchmark from factsheet for ${h.displayName}`} title={`Enter the declared benchmark from the factsheet for ${h.fullName}`}>
                    {HELD_ACTION_LABEL}
                  </Btn>
                ) : null}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </ScrollTable>
  );
}
