'use client';

import type { MouseEvent, ReactNode } from 'react';
import { openPrintTab } from '@/lib/reports/printTab';

/**
 * Opens a report print view in its own tab FROM A CLICK HANDLER, so the browser lets that tab close itself afterwards
 * (lib/reports/printTab.ts explains why a plain target="_blank" link cannot). A real <a href> remains as the no-JavaScript
 * fallback; with JavaScript the click is handled here. If the popup is blocked the print view opens in this tab instead.
 */
export function OpenPrintTabLink({ href, windowName, className, children }: { href: string; windowName: string; className?: string; children?: ReactNode }) {
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let "open in new tab" shortcuts behave normally
    e.preventDefault();
    openPrintTab(window, href, windowName);
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={onClick} className={className}>
      {children}
    </a>
  );
}
