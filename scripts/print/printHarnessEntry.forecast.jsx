// Browser entry for the Consolidated Forecasting Report print view (app/(print)/forecast/report/print/page.tsx), fed from a fixture.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ForecastReportContent } from '@/components/forecast/ForecastReportContent';
import { PrintTabToolbar } from '@/components/reports/PrintTabToolbar';
import { ReportPrintFrame } from '@/components/reports/ReportPrintFrame';

const fx = window.__FIXTURE__;
createRoot(document.getElementById('root')).render(
  <ReportPrintFrame serverRender={Boolean(window.__SERVER__)} identity="Consolidated Forecasting Report">
    <PrintTabToolbar autoPrint={false} parentHref="/forecast/report" parentLabel="Forecasting Report" />
    <ForecastReportContent data={fx.data} />
  </ReportPrintFrame>,
);
window.__READY__ = true;
