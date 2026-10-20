'use client';
// Document2 (4) F2. The shared table's scroll region, now with a mirrored sideways scrollbar ABOVE the table when (and only when) the table is wider
// than its box. The two bars are kept in step, so on a long table the right-hand columns are reachable from the top without first scrolling the page to
// the bottom of the table. The server markup is exactly the region it always was; the top bar appears after the first measurement in the browser.
import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { hasSidewaysOverflow, mirroredScrollLeft } from '@/lib/ui/dataTable';

export function ScrollRegion({ children, className, ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  const regionRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [overflowWidth, setOverflowWidth] = useState<number | null>(null);

  const measure = useCallback(() => {
    const el = regionRef.current;
    if (!el) return;
    setOverflowWidth(hasSidewaysOverflow(el.scrollWidth, el.clientWidth) ? el.scrollWidth : null);
  }, []);

  useEffect(() => {
    measure();
    const el = regionRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const table = el.firstElementChild;
    if (table) ro.observe(table);
    return () => ro.disconnect();
  }, [measure]);

  const follow = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to) return;
    const next = mirroredScrollLeft(from.scrollLeft, to.scrollLeft);
    if (next !== null) to.scrollLeft = next;
  };

  return (
    <>
      {overflowWidth !== null && (
        <div
          ref={barRef}
          aria-hidden="true"
          data-testid="table-top-scrollbar"
          className="fhip-table-topscroll"
          onScroll={() => follow(barRef.current, regionRef.current)}
        >
          <div style={{ width: overflowWidth, height: 1 }} />
        </div>
      )}
      <div {...rest} ref={regionRef} className={className} onScroll={() => follow(regionRef.current, barRef.current)}>
        {children}
      </div>
    </>
  );
}
