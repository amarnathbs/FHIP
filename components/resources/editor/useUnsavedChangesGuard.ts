'use client';

// R1.3 unsaved-change navigation guard — spec §42/§95/§117.
//
// Covers the three vectors spec §95 names explicitly:
//   1. tab close / reload            -> `beforeunload`
//   2. an in-app link click (Back,   -> document-level capturing click
//      breadcrumb, or any AppShell      listener on <a> elements. Deliberately
//      sidebar nav item)                document-level rather than only
//                                        wrapping this editor's own Back link,
//                                        so it also catches a click on the
//                                        global AppShell sidebar (spec §95:
//                                        "another Admin nav item") without
//                                        modifying AppShell itself.
//   3. browser Back/Forward button   -> `popstate` + the standard
//                                        push-back-then-confirm workaround
//                                        (Next.js client-side routing does
//                                        not fire `beforeunload` for this,
//                                        and `popstate` fires *after* the
//                                        URL has already changed, so the
//                                        only way to "cancel" it is to
//                                        immediately restore the URL and
//                                        ask, then navigate for real only on
//                                        confirmation).
//
// Does not block navigation once everything is saved (spec §95's own
// "do not block navigation after successful save").

import { useEffect, useRef, useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

export function useUnsavedChangesGuard(isDirty: boolean) {
  const router = useRouter();
  const isDirtyRef = useRef(isDirty);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const bypassRef = useRef(false);

  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!isDirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    function onClickCapture(e: MouseEvent) {
      if (!isDirtyRef.current || bypassRef.current) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') ?? '';
      if (!href || href.startsWith('#') || anchor.target === '_blank') return;
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return; // external links navigate normally
      if (url.pathname === window.location.pathname) return; // same-page anchors/query changes
      e.preventDefault();
      e.stopPropagation();
      setPendingHref(url.pathname + url.search);
    }
    document.addEventListener('click', onClickCapture, true);
    return () => document.removeEventListener('click', onClickCapture, true);
  }, []);

  useEffect(() => {
    // Push a marker state once so a Back press has our own popstate to
    // intercept first, then restore it here if the user cancels.
    function onPopState() {
      if (!isDirtyRef.current || bypassRef.current) return;
      // The URL already changed by the time this fires — push it back
      // immediately so the app stays put until the user decides.
      history.pushState(null, '', window.location.href);
      setPendingHref('__back__');
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const confirmNavigate = useCallback(() => {
    bypassRef.current = true;
    const href = pendingHref;
    setPendingHref(null);
    if (href === '__back__') {
      history.back();
    } else if (href) {
      router.push(href);
    }
    // Reset the bypass shortly after — a fresh navigation attempt after
    // this one should be guarded again if the user is still dirty on a new page.
    setTimeout(() => {
      bypassRef.current = false;
    }, 500);
  }, [pendingHref, router]);

  const cancelNavigate = useCallback(() => setPendingHref(null), []);

  return { promptOpen: pendingHref !== null, confirmNavigate, cancelNavigate };
}
