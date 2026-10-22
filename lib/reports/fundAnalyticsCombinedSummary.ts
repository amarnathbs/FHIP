// ONE CONSOLIDATED FRONT SECTION for a combined Fund analytics print (PO decision 20-10-2026, follow-up). A combined document used to repeat each report's own
// cover (summary table, notes, "How to read"). It now has ONE front section built ONLY from what the saved reports already hold (report_json): the summary rows are
// the reports' own figures (no recomputation, no new data), and the notes are the reports' own notes, merged without inventing anything:
//   * a note whose text is identical in every report is printed ONCE;
//   * a note that differs between reports is printed with the reports it belongs to named ("Report 1 (Version 4): ...");
//   * two notes are RESTATED for the whole document, from the reports' own numbers: "This report covers X of your Y ..." and "Figures are as at ...";
//   * a note about one named fund ("Price history for <fund> could not be loaded ...") is kept as it is.
// Pure (no React, no globals) so the rules are unit-tested.
import type { FundAnalyticsReport } from '@/lib/engines/nav2/fundAnalyticsReport';
import { figuresAsAtNote } from '@/lib/engines/nav2/reportWording';

export interface CombinedPartInput {
  report: FundAnalyticsReport;
  version: { versionNumber: number; createdAt: string };
}

// the exact sentences the report engine writes (lib/engines/nav2/reportWording.ts coversSomeFundsNote / figuresAsAtNote and fundAnalyticsReport.ts)
const AS_AT = /^Figures are as at (.+?)\. Prices are published by AMFI\. This is information, not a recommendation to buy, sell or switch\.$/;
const COVERS = /^This report covers (\d+) of your (\d+) Indian mutual funds, as you chose\. The others can go in a second report\.$/;
const PRICE_HISTORY = /^Price history for .+ could not be loaded \(.*\); its figures are marked not available\.$/;
/** The note the fund pages point to ("see note 1") for the risk-free rate. */
export const RISK_FREE_NOTE = /^(Risk-free rate|Sharpe and Sortino compare)/i;

export interface MergedNote {
  /** The note as printed. */
  text: string;
  /** The (0-based) reports it applies to. */
  parts: number[];
}

export interface MergedNotes {
  notes: MergedNote[];
  /** For each report, the number (1-based) of the merged note its fund pages point to for the risk-free rate; null when it has none. */
  riskFreeNoteByPart: Array<number | null>;
}

const versionOf = (p: CombinedPartInput) => p.version.versionNumber;

/** "Report 1 (Version 4)", "Reports 1 and 2 (Versions 4 and 5)", "Reports 1, 2 and 3 (Versions 4, 5 and 6)". */
export function reportsLabel(parts: readonly CombinedPartInput[], indices: readonly number[]): string {
  const list = (xs: readonly (string | number)[]) => (xs.length <= 1 ? String(xs[0]) : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const nums = [...indices].sort((a, b) => a - b);
  return `${nums.length === 1 ? 'Report' : 'Reports'} ${list(nums.map((i) => i + 1))} (${nums.length === 1 ? 'Version' : 'Versions'} ${list(nums.map((i) => versionOf(parts[i])))})`;
}

/** How many funds the reports cover together, and how many the household holds, from the reports' own numbers. `heldFundCount` is null when the reports disagree. */
export function coverage(parts: readonly CombinedPartInput[]): { covered: number; heldFundCount: number | null } {
  const covered = new Set(parts.flatMap((p) => p.report.schemes.map((s) => s.instrumentId))).size;
  const helds = parts.map((p) => p.report.selection?.heldFundCount ?? p.report.schemes.length);
  return { covered, heldFundCount: helds.every((h) => h === helds[0]) ? helds[0] : null };
}

/** The reports' notes as ONE list (see the header of this file). `duplicateFunds`: names of funds that more than one report covers (a plain note is added, nothing else). */
export function mergeNotes(parts: readonly CombinedPartInput[], duplicateFunds: readonly string[] = []): MergedNotes {
  type Slot = { kind: 'plain' | 'price' | 'covers' | 'asat'; text: string; parts: Set<number> };
  const slots: Slot[] = [];
  const covers: Array<{ chosen: number; held: number } | undefined> = [];
  const asAt: Array<string | undefined> = [];
  let coversSlot: Slot | null = null;
  let asAtSlot: Slot | null = null;
  parts.forEach((p, i) => {
    for (const n of p.report.notes) {
      const a = AS_AT.exec(n);
      if (a) {
        asAt[i] = a[1];
        asAtSlot ??= { kind: 'asat', text: '', parts: new Set() };
        asAtSlot.parts.add(i);
        continue;
      }
      const c = COVERS.exec(n);
      if (c) {
        covers[i] = { chosen: Number(c[1]), held: Number(c[2]) };
        if (!coversSlot) {
          coversSlot = { kind: 'covers', text: '', parts: new Set() };
          slots.push(coversSlot); // keeps the place where the first report had it
        }
        coversSlot.parts.add(i);
        continue;
      }
      let s = slots.find((x) => x.kind !== 'covers' && x.text === n);
      if (!s) {
        s = { kind: PRICE_HISTORY.test(n) ? 'price' : 'plain', text: n, parts: new Set() };
        // a variant of a note another report already has (the same sentence with other numbers) is listed right after it, so the two values read together
        const shape = (t: string) => t.replace(/\d+/g, '#');
        let at = -1;
        slots.forEach((x, k) => {
          if (x.kind === s!.kind && x.kind === 'plain' && shape(x.text) === shape(n)) at = k;
        });
        if (at >= 0) slots.splice(at + 1, 0, s);
        else slots.push(s);
      }
      s.parts.add(i);
    }
  });

  const all = parts.map((_, i) => i);
  const out: MergedNote[] = [];
  const push = (text: string, ps: readonly number[]) => out.push({ text, parts: [...ps] });
  for (const s of slots) {
    const ps = [...s.parts].sort((a, b) => a - b);
    if (s.kind === 'price') push(s.text, ps); // about one named fund: it says whose it is
    else if (s.kind === 'plain') push(ps.length === parts.length ? s.text : `${reportsLabel(parts, ps)}: ${s.text}`, ps);
    else if (s.kind === 'covers') {
      const held = coverage(parts).heldFundCount;
      const { covered } = coverage(parts);
      const heldEveryReport = ps.every((i) => covers[i]?.held === held);
      if (held !== null && heldEveryReport && ps.length === parts.length && covered <= held) {
        // restated for the whole document from the reports' own numbers
        push(
          covered < held
            ? `This document covers ${covered} of your ${held} Indian mutual funds in ${parts.length} reports. The others can go in another report.`
            : `This document covers all ${held} of your Indian mutual funds in ${parts.length} reports.`,
          all,
        );
      } else {
        // the reports disagree (or only some of them carry the note): each report's own sentence, with the report named
        for (const i of ps) push(`${reportsLabel(parts, [i])}: This report covers ${covers[i]!.chosen} of your ${covers[i]!.held} Indian mutual funds.`, [i]);
      }
    }
  }
  if (duplicateFunds.length > 0) {
    push(`${duplicateFunds.join('; ')} ${duplicateFunds.length === 1 ? 'is' : 'are'} covered by more than one of these reports. The table at the front shows each fund once, from the first report that has it; each report's own pages show its own figures.`, all);
  }
  if (asAtSlot) {
    const ps = [...(asAtSlot as Slot).parts].sort((a, b) => a - b);
    const dates = ps.map((i) => asAt[i] as string);
    if (ps.length === parts.length && dates.every((d) => d === dates[0])) push(figuresAsAtNote(dates[0]), ps);
    else push(figuresAsAtNote(ps.map((i) => `${asAt[i]} (report ${i + 1}, Version ${versionOf(parts[i])})`).join('; ')), ps);
  }

  const riskFreeNoteByPart = parts.map((_, i) => {
    // the first merged note that carries this report's risk-free sentence (a labelled one starts with the label, so test the sentence after it)
    const idx = out.findIndex((n) => n.parts.includes(i) && RISK_FREE_NOTE.test(n.text.replace(/^Reports? [^:]*\): /, '')));
    return idx >= 0 ? idx + 1 : null;
  });
  return { notes: out, riskFreeNoteByPart };
}

export interface FrontRow {
  partIndex: number;
  schemeIndex: number;
}

/** Every fund of every report exactly once, the largest current value first (a fund with no value last; ties keep report order, then the report's own fund order). A fund that two reports cover is listed once, from the first report. */
export function frontRows(parts: readonly CombinedPartInput[]): { rows: FrontRow[]; duplicateFunds: string[] } {
  const seen = new Set<string>();
  const dup: string[] = [];
  const rows: Array<FrontRow & { value: number | null; order: number }> = [];
  let order = 0;
  parts.forEach((p, partIndex) =>
    p.report.schemes.forEach((s, schemeIndex) => {
      if (seen.has(s.instrumentId)) {
        if (!dup.includes(s.schemeName)) dup.push(s.schemeName);
        return;
      }
      seen.add(s.instrumentId);
      const cv = s.analytics.investor?.currentValue;
      rows.push({ partIndex, schemeIndex, value: cv && cv.state === 'available' ? cv.value.value : null, order: order++ });
    }),
  );
  rows.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || a.order - b.order);
  return { rows: rows.map(({ partIndex, schemeIndex }) => ({ partIndex, schemeIndex })), duplicateFunds: dup };
}

/** What differs between the reports that a reader must see plainly (never merged silently). */
export function differences(parts: readonly CombinedPartInput[]): { asOf: boolean; period: boolean } {
  return { asOf: new Set(parts.map((p) => p.report.asOfDate)).size > 1, period: new Set(parts.map((p) => p.report.periodChoice)).size > 1 };
}

/** The methodology text ("How this was calculated"): once when every report's text is identical (and not empty), else per report. */
export function calculationMode(parts: readonly CombinedPartInput[]): 'once' | 'per_report' | 'none' {
  const texts = parts.map((p) => JSON.stringify(p.report.calculationNotes ?? []));
  if (parts.every((p) => (p.report.calculationNotes ?? []).length === 0)) return 'none';
  return texts.every((t) => t === texts[0]) ? 'once' : 'per_report';
}
