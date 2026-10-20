import type { ReactNode } from 'react';

/**
 * The page frame of every report PRINT view (Monthly Report, Forecasting report): one place, so the two routes and the layout check
 * (scripts/print/printLayoutCheck.ts) all use the same wrapper.
 *
 *  - On screen it is the narrow, centred reading column the print tab always had.
 *  - On paper (`print:`) the column limit and the padding go: the report uses the whole text width the @page margin leaves
 *    (app/globals.css, `@page report`, 12 mm), instead of a 768 px column floating in white margins.
 *  - `identity` is the report's name and period for the running header (a CSS custom property read by the page margin box). It is plain text
 *    from the report itself (title and month): nothing the person typed, no figures, no ISO dates.
 *  - `serverRender` is true for the headless PDF renderer (?token=): it fixes its own margins and draws its own "Page n of N" footer, so the
 *    page margin boxes are switched off there (otherwise every page would carry two footers).
 */
export function reportPrintIdentity(identity: string): string {
  // Only characters that could end the rule early or break the CSS string are replaced; the text is a title and a month name.
  return identity.replace(/[<>"'{};\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}

const NO_MARGIN_BOXES = '@media print{@page report{@top-left{content:none}@top-right{content:none}@bottom-left{content:none}@bottom-right{content:none}}}';

export function ReportPrintFrame({ identity, serverRender = false, children }: { identity: string; serverRender?: boolean; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl p-6 print:max-w-none print:p-0">
      <style>{`html{--report-print-identity:"${reportPrintIdentity(identity)}"}${serverRender ? NO_MARGIN_BOXES : ''}`}</style>
      {children}
    </div>
  );
}
