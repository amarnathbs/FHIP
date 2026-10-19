import FundAnalyticsPrintDocument from '@/components/reports/FundAnalyticsPrintDocument';
import type { FundPagePlan } from '@/lib/config/nav2/printLayout';
import type { FundAnalyticsReport } from '@/lib/engines/nav2/fundAnalyticsReport';
import { versionMadeLinePrint } from '@/lib/engines/nav2/reportWording';
import { combinedIntroLine, combinedPageRulesCss } from '@/lib/reports/fundAnalyticsCombinedPrint';

// SEVERAL saved Fund analytics reports as ONE document (one print job, so the browser's "Save as PDF" writes one file). Each report is rendered by the
// unchanged FundAnalyticsPrintDocument (its own cover, summary, notes, funds and comparison; nothing in a saved report is altered or merged with another).
// What this adds, and nothing else:
//   * a one-line explanation at the start (how many reports, how many funds, and that funds are compared only within the same report);
//   * one NAMED PAGE per report, so the second and later reports start on a fresh page and each page's running header names its own report's version;
//   * the page counter is the document's own: "Page n of N" runs across all reports (CSS counters page/pages are document-wide).
// Server-rendered HTML like the single document (charts are inline SVG), so what is printed is what the person's browser lays out.

export interface CombinedPart {
  report: FundAnalyticsReport;
  version: { versionNumber: number; createdAt: string };
}

export default function FundAnalyticsCombinedPrintDocument({ parts, pagesPerFund, timeZone = null }: { parts: CombinedPart[]; pagesPerFund?: FundPagePlan; timeZone?: string | null }) {
  const fundCount = new Set(parts.flatMap((p) => p.report.schemes.map((s) => s.instrumentId))).size;
  const lines = parts.map((p) => versionMadeLinePrint(p.version.versionNumber, p.version.createdAt, p.report.displayCurrency, timeZone));
  return (
    <div className="fa-combined" data-fa-combined-reports={parts.length}>
      {/* plain text only (cssText removes every character that could end the rule or the element); dangerouslySetInnerHTML so React does not turn a quote into &quot; inside CSS */}
      <style dangerouslySetInnerHTML={{ __html: combinedPageRulesCss(lines) }} />
      {parts.map((p, i) => (
        <div key={p.report.schemes.map((s) => s.instrumentId).join('|') + i} className={`fa-combined-part fa-combined-part-${i + 1}`} data-fa-part={i + 1}>
          {i === 0 && (
            <p className="fa-combined-intro" data-testid="fa-combined-intro">
              {combinedIntroLine(parts.length, fundCount)}
            </p>
          )}
          <FundAnalyticsPrintDocument report={p.report} version={p.version} pagesPerFund={pagesPerFund} timeZone={timeZone} combinedPart />
        </div>
      ))}
    </div>
  );
}
