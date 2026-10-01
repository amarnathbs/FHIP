import { it } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildIndiaMfReport } from '@/lib/engines/investment-intelligence/indiaMfReport';
import { IndiaMfInvestmentReportSection } from '@/components/reports/IndiaMfInvestmentReportSection';
import { syntheticIndiaMfInput } from '../fixtures/indiaMfSynthetic';
it('render', () => {
  const report = buildIndiaMfReport(syntheticIndiaMfInput())!;
  const html = renderToStaticMarkup(React.createElement(IndiaMfInvestmentReportSection, { report, title: 'Mutual Fund Investment Report', narrative: 'Synthetic example narrative.', limitation: 'Observation only.' }));
  fs.writeFileSync(process.env.OUT_HTML!, html);
  fs.writeFileSync(process.env.OUT_HTML! + '.json', JSON.stringify(report, null, 1));
});
