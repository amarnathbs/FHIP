// Browser entry for scripts/print/printLayoutCheck.ts: the REAL report components inside the same frame the print route uses
// (app/(print)/reports/[id]/print/page.tsx), fed from a fixture. No dev server, login or database.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReportPreview } from '@/components/reports/ReportPreview';
import { PrintTabToolbar } from '@/components/reports/PrintTabToolbar';
import { ReportPrintFrame } from '@/components/reports/ReportPrintFrame';
import { loadReportContent } from '@/lib/services/reportContentData';

const fx = window.__FIXTURE__;
const monthLabel = new Date(fx.report.report_month).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

async function main() {
  const content = await loadReportContent('en', { from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [] }) }) }) }) });
  const root = createRoot(document.getElementById('root'));
  root.render(
    <ReportPrintFrame serverRender={Boolean(window.__SERVER__)} identity={`Household Financial Health Report - ${monthLabel}`}>
      <PrintTabToolbar autoPrint={false} parentHref="/reports" parentLabel="Report" />
      <ReportPreview report={fx.report} sections={fx.sections} currency={fx.currency} content={content} />
    </ReportPrintFrame>,
  );
  window.__READY__ = true;
}
main();
