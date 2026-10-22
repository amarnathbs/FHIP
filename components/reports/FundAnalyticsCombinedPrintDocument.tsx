import { FundAnalyticsCombinedFront, FundAnalyticsCombinedPartBody } from '@/components/reports/FundAnalyticsPrintDocument';
import type { FundPagePlan } from '@/lib/config/nav2/printLayout';
import { versionMadeLinePrint } from '@/lib/engines/nav2/reportWording';
import { combinedIntroLine, combinedPageRulesCss, versionsPhrase } from '@/lib/reports/fundAnalyticsCombinedPrint';
import { coverage, mergeNotes, type CombinedPartInput } from '@/lib/reports/fundAnalyticsCombinedSummary';

// SEVERAL saved Fund analytics reports as ONE document (one print job, so the browser's "Save as PDF" writes one file). Nothing in a saved report is altered:
//   * FRONT SECTION (once): the one-line explanation, then ONE table "All your funds at a glance" with every fund of every report (largest first), ONE merged list
//     of notes, ONE "How to read this report" (and the method note, when the reports' texts are identical). The per-report covers are NOT printed.
//     Built only from the reports' saved rows and notes (lib/reports/fundAnalyticsCombinedSummary.ts); differences (as-at date, period) are shown plainly.
//   * then each report's FUND PAGES and its own comparison (labelled "Comparing the funds in report 1 (Version 4)"), each report on a fresh page;
//   * one NAMED PAGE per section: each page's running header names its own report's version (the front: "Versions 4 and 5"), and the page counter is the
//     document's own, so "Page n of N" runs across everything.
// Server-rendered HTML like the single document (charts are inline SVG), so what is printed is what the person's browser lays out.

export type CombinedPart = CombinedPartInput;

export default function FundAnalyticsCombinedPrintDocument({ parts, pagesPerFund, timeZone = null }: { parts: CombinedPart[]; pagesPerFund?: FundPagePlan; timeZone?: string | null }) {
  const fundCount = coverage(parts).covered;
  const lines = parts.map((p) => versionMadeLinePrint(p.version.versionNumber, p.version.createdAt, p.report.displayCurrency, timeZone));
  const { riskFreeNoteByPart } = mergeNotes(parts);
  return (
    <div className="fa-combined" data-fa-combined-reports={parts.length}>
      {/* plain text only (cssText removes every character that could end the rule or the element); dangerouslySetInnerHTML so React does not turn a quote into &quot; inside CSS */}
      <style dangerouslySetInnerHTML={{ __html: combinedPageRulesCss(versionsPhrase(parts.map((p) => p.version.versionNumber)), lines) }} />
      <div className="fa-combined-front" data-fa-front-section="true">
        <p className="fa-combined-intro" data-testid="fa-combined-intro">
          {combinedIntroLine(parts.length, fundCount)}
        </p>
        <FundAnalyticsCombinedFront parts={parts} timeZone={timeZone} />
      </div>
      {parts.map((_, i) => (
        <div key={i} className={`fa-combined-part fa-combined-part-${i + 1}`} data-fa-part={i + 1}>
          <FundAnalyticsCombinedPartBody parts={parts} index={i} riskFreeNote={riskFreeNoteByPart[i]} pagesPerFund={pagesPerFund} />
        </div>
      ))}
    </div>
  );
}
