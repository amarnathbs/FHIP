// The ONE shared table mechanism for the whole app, customer and Admin (Product Owner 08-10-2026).
//
//   <DataTable label="Recent import jobs" className="text-sm">
//     <thead><tr><DataTh>Status</DataTh><DataTh kind="num">Rows</DataTh><DataTh kind="action">Details</DataTh></tr></thead>
//     <tbody><tr><DataTd kind="status"><Chip/></DataTd><DataTd kind="num">12</DataTd><DataTd kind="action"><button/></DataTd></tr></tbody>
//   </DataTable>
//
// What it gives every table (rules in lib/ui/dataTable.ts, styles under `.fhip-table*` in app/globals.css):
//   * One labelled, keyboard-focusable scroll REGION around the table. The table fills it and shrinks to it; the sideways scroll
//     appears only when the columns genuinely cannot fit, and it stays inside the region (the page never scrolls sideways).
//   * Compact, readable defaults: header cells do not squeeze to slivers, number/date/status/action cells never wrap, buttons and
//     links in a cell stay on one line.
//   * Below 768 px the first column and every `action` column are sticky, so a row's name and its action stay on screen.
//   * Opt-in per column: `kind="clamp"` clamps long descriptive text to two lines with an accessible "Show more" button
//     (components/ui/ClampText.tsx); `num` / `date` / `status` / `action` keep the cell single-line.
//   * No vertical scroll area is added (the page scrolls once), and a long secondary table can offer a jump link past itself.
//
// It renders the real <table>, so every existing attribute, test id and aria label on the table is passed straight through and
// raw <thead>/<tr>/<th>/<td> children keep working unchanged: migrating a table is replacing the <table> tag with <DataTable>.
// A raw <table> outside this file fails tests/unit/dataTableGuard.test.ts.
//
// No 'use client': usable from a server page.tsx. Only <ClampText> (used by kind="clamp") is a client component.
import type { ComponentPropsWithoutRef, HTMLAttributes, ReactNode } from 'react';
import { ClampText } from '@/components/ui/ClampText';
import { cellClass, headerClass, shouldOfferJumpLink, type CellKind } from '@/lib/ui/dataTable';

export interface DataTableProps extends Omit<ComponentPropsWithoutRef<'table'>, 'children'> {
  /** Accessible name of the scroll region around the table (required: a scrollable region without a name is not usable). */
  label: string;
  children: ReactNode;
  /** Extra classes for the scroll region (for example a border and rounded corners). */
  wrapperClassName?: string;
  /** Extra attributes for the scroll region, for example a `data-testid`. */
  wrapperProps?: HTMLAttributes<HTMLDivElement> & { [dataAttr: `data-${string}`]: string | undefined };
  /** Keep the first column on screen when the region scrolls sideways below 768 px. Default true. */
  stickyFirstColumn?: boolean;
  /** For a long table that is not the primary content: a link past the table, shown when `rowCount` is long enough. */
  jumpTo?: { href: string; label: string };
  /** Number of body rows, used only to decide whether to show the jump link. */
  rowCount?: number;
}

export function DataTable({ label, children, className = '', wrapperClassName = '', wrapperProps, stickyFirstColumn = true, jumpTo, rowCount, ...tableProps }: DataTableProps) {
  return (
    <>
      {jumpTo && shouldOfferJumpLink(rowCount, true) ? (
        <p className="fhip-table-jump">
          <a href={jumpTo.href} className="fhip-table-jump-link">
            {jumpTo.label}
          </a>
        </p>
      ) : null}
      <div {...wrapperProps} role="region" aria-label={label} tabIndex={0} className={`fhip-table-wrap ${wrapperClassName}`.trim()}>
        <table {...tableProps} data-sticky-first={stickyFirstColumn ? 'true' : undefined} className={`fhip-table ${className}`.trim()}>
          {children}
        </table>
      </div>
    </>
  );
}

type CellProps<T extends 'td' | 'th'> = Omit<ComponentPropsWithoutRef<T>, 'children'> & {
  /** `clamp` = descriptive text, two lines then "Show more". `num` / `date` / `status` / `action` = single-line, never clamped. */
  kind?: CellKind;
  children?: ReactNode;
};

export function DataTh({ kind = 'text', className = '', scope = 'col', ...rest }: CellProps<'th'>) {
  return <th scope={scope} {...rest} data-cell-kind={kind} className={headerClass(kind, className)} />;
}

export interface DataTdProps extends CellProps<'td'> {
  /** Lines shown by a `clamp` cell. Default two (the Product Owner rule). */
  lines?: number;
  /** Narrowest a `clamp` cell may be squeezed to, in characters. */
  minCh?: number;
  /** Widest a `clamp` cell may grow to, in characters. */
  maxCh?: number;
}

export function DataTd({ kind = 'text', className = '', children, lines, minCh, maxCh, ...rest }: DataTdProps) {
  return (
    <td {...rest} data-cell-kind={kind} className={cellClass(kind, className)}>
      {kind === 'clamp' ? (
        <ClampText lines={lines} minCh={minCh} maxCh={maxCh}>
          {children}
        </ClampText>
      ) : (
        children
      )}
    </td>
  );
}

/** Text that must never break: a date, a time, an identifier. (A browser would otherwise break "06-10-2026" at its hyphens.) */
export function NoWrap({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`whitespace-nowrap ${className}`.trim()}>{children}</span>;
}

/**
 * A date range such as "06-10-2026 to 05-10-2036". Each end is unbreakable; the only place it may break is after " to " (between the two dates), so it is
 * never more than two lines and a date is never split at a hyphen. The text is exactly `${from} to ${to}`.
 */
export function DateRange({ from, to }: { from: ReactNode; to: ReactNode }) {
  return (
    <>
      <NoWrap>{from} to</NoWrap> <NoWrap>{to}</NoWrap>
    </>
  );
}

/**
 * An already-formatted date-and-time such as "08-10-2026 02:37 UTC". The date and the time are each unbreakable and the only
 * break allowed is between them, so a squeezed column shows two short lines rather than a date broken at its hyphens. The text is
 * unchanged, so the day-first wording rules are untouched.
 */
export function DateTimeText({ value }: { value: string }) {
  const at = value.indexOf(' ');
  if (at < 0) return <NoWrap>{value}</NoWrap>;
  return (
    <>
      <NoWrap>{value.slice(0, at)}</NoWrap> <NoWrap>{value.slice(at + 1)}</NoWrap>
    </>
  );
}

export default DataTable;
