'use client';

import { useEffect } from 'react';
import { applyPrintDocumentTitle } from '@/lib/reports/printDocumentTitle';

/**
 * Sets the page title of a report PRINT view to the report's name and period (lib/reports/printDocumentTitle.ts), so the file name
 * the browser proposes for "Save as PDF" is per report and per month instead of the app-wide "FHIP | Financial Health".
 * Renders nothing. It runs on mount, before the toolbar's automatic print (300 ms later), and PrintTabToolbar sets the same title again
 * right before every window.print(). The headless PDF renderer (?token=) gets it too, so the PDF's own title is the same.
 */
export function PrintDocumentTitle({ title }: { title: string }) {
  useEffect(() => {
    applyPrintDocumentTitle(document, title);
  }, [title]);
  return null;
}
