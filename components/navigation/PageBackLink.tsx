// The ONE shared back / return control for every page of the app (PO review
// 06-10-2026, finding F6: "all pages do have the button to return back ... also
// for all future pages").
//
// Contract (keep this API stable, other branches import it):
//
//   <PageBackLink href="/admin/resources" label="Resources" />
//
// renders a visible, keyboard-focusable link reading "Back to Resources" that
// navigates to the page's PARENT in the app hierarchy.
//
// Design rules:
//  - A real Next <Link> to an explicit parent href. NOT router.back() or
//    window.history tricks: those break deep links (a page opened from an e-mail
//    or a bookmark has no history to go back to) and behave differently per
//    entry path. The parent is a property of the page, not of how it was opened.
//  - No 'use client': it is a plain server-renderable component, usable from a
//    server page.tsx and from any client component alike.
//  - Unsaved-changes safety needs nothing extra here: the editors already mount
//    components/resources/editor/useUnsavedChangesGuard, whose document-level
//    capturing click listener intercepts every in-page <a href> (including this
//    one) and asks for confirmation while the form is dirty.
//  - Where it is NOT used: top-level landing / dashboard, auth pages, print
//    targets and the mandatory onboarding gates. Those exemptions are the
//    explicit allow-list in tests/unit/pageBackLinkGuard.test.ts; anything else
//    without this component fails that test.
//
// Documented in docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md (section 18) and
// docs/ux/BACK_NAVIGATION_INVENTORY.md.

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export interface PageBackLinkProps {
  /** The parent page this control returns to, e.g. "/admin/resources". */
  href: string;
  /** The parent's name WITHOUT the "Back to" prefix, e.g. "Resources". */
  label: string;
  /** Optional layout tweak only (spacing); never used to hide the control. */
  className?: string;
}

export function PageBackLink({ href, label, className }: PageBackLinkProps) {
  return (
    <nav aria-label="Back navigation" className={className ?? 'mb-4'} data-testid="page-back-nav">
      <Link
        href={href}
        data-testid="page-back-link"
        className="inline-flex min-h-11 items-center gap-1.5 rounded text-sm font-semibold text-primary-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        <span>Back to {label}</span>
      </Link>
    </nav>
  );
}
