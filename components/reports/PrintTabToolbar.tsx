'use client';

import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';
import { createPrintTabController, type PrintWindowLike } from '@/lib/reports/printTab';
import { applyPrintDocumentTitle } from '@/lib/reports/printDocumentTitle';

/**
 * The toolbar of every report PRINT view a person can reach (Net Worth Statement, Monthly Report print route, Forecasting report
 * print route). Behaviour and the browser rules behind it: lib/reports/printTab.ts.
 *
 *  - It is hidden when printing (`no-print`), so no navigation control ever appears on the paper or in the PDF.
 *  - "Print / Save as PDF" opens the print dialog; when the view was opened with print=1 it opens it once on its own.
 *  - When the app opened this tab, the tab closes itself after the print dialog is dismissed.
 *  - "Close this tab" tries window.close(); if the browser refuses (a tab the app did not open), it says so in a status message
 *    ("You can close this tab now.") and offers a link back to the parent page. There is no "Back to Dashboard" here.
 */
/** The status line: empty until the browser refuses to close the tab, then a plain message and a link back to the parent page. */
export function PrintTabStatus({
  refused,
  parentHref,
  parentLabel,
  linkRef,
}: {
  refused: boolean;
  parentHref: string;
  parentLabel: string;
  linkRef?: RefObject<HTMLAnchorElement>;
}) {
  return (
    <div role="status" aria-live="polite" className="text-sm text-gray-800" data-testid="print-tab-status">
      {refused ? (
        <p>
          You can close this tab now.{' '}
          <a ref={linkRef} href={parentHref} className="font-medium text-trust underline">
            Back to {parentLabel}
          </a>
        </p>
      ) : null}
    </div>
  );
}

export function PrintTabToolbar({
  autoPrint,
  parentHref,
  parentLabel,
  documentTitle,
}: {
  autoPrint: boolean;
  /** Where the fallback link goes, e.g. "/reports". */
  parentHref: string;
  /** The parent's name without "Back to", e.g. "Reports". */
  parentLabel: string;
  /** The report's print title (lib/reports/printDocumentTitle.ts): set on the page right before the print dialog opens, which is when Chrome reads it as the saved file name. */
  documentTitle?: string;
}) {
  const controller = useMemo(
    () =>
      typeof window === 'undefined'
        ? null
        : createPrintTabController(window as unknown as PrintWindowLike, {
            autoPrint,
            beforePrint: documentTitle ? () => applyPrintDocumentTitle(document, documentTitle) : undefined,
          }),
    [autoPrint, documentTitle],
  );
  useEffect(() => controller?.start(), [controller]);
  const state = useSyncExternalStore(
    (cb) => controller?.subscribe(cb) ?? (() => undefined),
    () => controller?.getState() ?? 'idle',
    () => 'idle' as const,
  );
  const refused = state === 'close_refused';
  const backRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (refused) backRef.current?.focus();
  }, [refused]);

  return (
    <div className="no-print mb-4 space-y-2" data-testid="print-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => controller?.print()} className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          Print / Save as PDF
        </button>
        <button
          type="button"
          onClick={() => controller?.requestClose()}
          className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Close this tab
        </button>
        <span className="text-xs text-gray-600">Choose &ldquo;Save as PDF&rdquo; as the destination to keep a copy. A4, portrait.</span>
      </div>
      <PrintTabStatus refused={refused} parentHref={parentHref} parentLabel={parentLabel} linkRef={backRef} />
    </div>
  );
}
