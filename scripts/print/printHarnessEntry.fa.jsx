// Browser entry for the Fund analytics print view (app/(print)/reports/fund-analytics/print/page.tsx), fed from a fixture. No dev server,
// login or database: the REAL FundAnalyticsPrintDocument inside the same toolbar + document the route renders.
import React from 'react';
import { createRoot } from 'react-dom/client';
import FundAnalyticsPrintDocument from '@/components/reports/FundAnalyticsPrintDocument';
import { PrintTabToolbar } from '@/components/reports/PrintTabToolbar';

const fx = window.__FIXTURE__;
createRoot(document.getElementById('root')).render(
  <>
    <PrintTabToolbar autoPrint={false} parentHref="/reports/fund-analytics" parentLabel="Fund Analytics" />
    <FundAnalyticsPrintDocument report={fx.report} version={fx.version} pagesPerFund={fx.plan ?? 1} serverRender={Boolean(window.__SERVER__)} />
  </>,
);
window.__READY__ = true;
