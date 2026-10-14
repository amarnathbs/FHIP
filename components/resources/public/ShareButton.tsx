'use client';

// Social sharing for a public Resource detail page. Client component (needs
// navigator.share/clipboard/window interactions) rendered inside the
// otherwise-server ResourceDetailHeader.
//
// Share journey (all rules live in lib/resources/public/share.ts and are
// unit-tested; this file is the thin DOM wrapper):
//   * Touch devices that expose the Web Share API (iPhone/Android browsers):
//     the tap calls navigator.share({ title, text, url }) directly, inside the
//     user gesture. Dismissing the sheet (AbortError) is silent. If the browser
//     refuses for any other reason, the in-page panel below opens instead.
//   * Everything else (desktop, or no Web Share API): the tap opens the in-page
//     panel -- direct share links for the platforms this content actually gets
//     shared to, Email, and a "Copy link" that works regardless of platform
//     support. 2026-10-01: desktop Edge/Chrome expose navigator.share too, and
//     handing straight to the OS sheet hid these reliable links, so on desktop
//     the OS sheet is only an optional "More options..." entry.
//   * The panel is a bottom sheet on phones (always inside the viewport) and an
//     anchored popover from the `sm` breakpoint up. 2026-10-13: it used to be a
//     48-rem `absolute right-0` menu under a button that wrapped to the LEFT of
//     the header row on narrow screens, so on a phone the menu extended past
//     the left edge of the screen and was clipped.
//
// The URL shared is exactly the `url` prop (the page's canonical public
// Resource URL); nothing here reads window.location.

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Share2, Copy, Check, Mail, X } from 'lucide-react';
import {
  buildShareData,
  canUseNativeShare,
  copyTextToClipboard,
  isSharePayloadSupported,
  prefersNativeShare,
  shareViaNavigator,
  type NativeShareOutcome,
  type ResourceShareData,
} from '@/lib/resources/public/share';

export { canUseNativeShare };

// Exported for tests/unit/shareButton.test.ts — the actual link-building
// logic is what's worth testing directly; the surrounding component is a
// thin DOM/event wrapper (matches this project's existing convention of
// testing grid/engine logic directly rather than via a React render harness).
export function buildShareLinks(url: string, title: string) {
  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title);
  return [
    { label: 'X (Twitter)', href: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}` },
    { label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}` },
    { label: 'LinkedIn', href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}` },
    { label: 'WhatsApp', href: `https://wa.me/?text=${encodedTitle}%20${encodedUrl}` },
  ];
}

export function buildEmailShareHref(url: string, title: string): string {
  return `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`;
}

// Hidden-textarea copy for contexts without navigator.clipboard.writeText
// (older WebViews, insecure origins). Must run inside the user's tap.
function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(area);
  }
}

const ITEM_CLASS =
  'flex min-h-11 w-full items-center gap-2 px-4 py-3 text-left text-sm text-ink hover:bg-trust/5 focus-visible:bg-trust/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-trust sm:min-h-0 sm:px-3 sm:py-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-3';

type CopyState = 'idle' | 'copied' | 'failed';

export function ShareButton({ url, title, excerpt }: { url: string; title: string; excerpt?: string | null }) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  // Server snapshot is false so server and first client render match.
  const nativeShare = useSyncExternalStore(
    () => () => {},
    () => canUseNativeShare(typeof navigator !== 'undefined' ? navigator : undefined),
    () => false,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelId = useId();

  function closePanel(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  // Outside tap and Escape close the panel; focus moves to the first action on
  // open and returns to the Share button on Escape / close / choosing an item.
  useEffect(() => {
    if (!open) return;
    function handleOutside(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('keydown', handleEscape);
    // The anchored popover (>= sm, incl. a phone in landscape) hangs below the
    // button, which can sit near the bottom of the screen: bring it fully on screen.
    panelRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    panelRef.current?.querySelector<HTMLElement>('[data-share-initial]')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  async function shareNatively(data: ResourceShareData): Promise<NativeShareOutcome> {
    return shareViaNavigator(navigator as unknown as { share: (d: ResourceShareData) => Promise<void> }, data);
  }

  function handleShareClick() {
    if (open) {
      closePanel(true);
      return;
    }
    const data = buildShareData({ title, excerpt, url });
    if (prefersNativeShare({ nav: navigator, matchMedia: (q) => window.matchMedia(q) }) && isSharePayloadSupported(navigator, data)) {
      // Called synchronously from the tap so the browser's user-activation
      // requirement is met. If the browser refuses, show the in-page panel.
      void shareNatively(data).then((outcome) => {
        if (outcome === 'failed') setOpen(true);
      });
      return;
    }
    setOpen(true);
  }

  async function handleMoreOptions() {
    setOpen(false);
    await shareNatively(buildShareData({ title, excerpt, url }));
    triggerRef.current?.focus();
  }

  async function handleCopyLink() {
    const ok = await copyTextToClipboard(url, { clipboard: navigator.clipboard, legacyCopy });
    setCopyState(ok ? 'copied' : 'failed');
    if (copyTimer.current) clearTimeout(copyTimer.current);
    if (ok) copyTimer.current = setTimeout(() => setCopyState('idle'), 2500);
  }

  const items = buildShareLinks(url, title);

  return (
    <div ref={containerRef} className="relative ml-auto">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleShareClick}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="flex min-h-11 items-center gap-1.5 rounded-full border border-line px-4 py-2 text-xs font-medium text-ink hover:bg-trust/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-trust focus-visible:ring-offset-2 sm:min-h-0 sm:px-3 sm:py-1"
      >
        <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
        Share
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copyState === 'copied' ? 'Link copied' : copyState === 'failed' ? 'Could not copy the link automatically' : ''}
      </span>
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30 sm:hidden" onClick={() => closePanel(true)} aria-hidden="true" />
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label="Share this article"
            className="fixed bottom-[max(0.5rem,env(safe-area-inset-bottom))] left-[max(0.5rem,env(safe-area-inset-left))] right-[max(0.5rem,env(safe-area-inset-right))] z-50 mx-auto max-h-[80vh] max-w-sm overflow-y-auto rounded-card border border-line bg-white py-1 shadow-lg sm:absolute sm:inset-auto sm:right-0 sm:z-10 sm:mx-0 sm:mt-2 sm:max-h-none sm:w-48 sm:max-w-[calc(100vw-2rem)] sm:overflow-visible"
          >
            <div className="flex items-center justify-between px-4 pb-1 pt-2 sm:hidden">
              <p className="text-sm font-semibold text-ink">Share this article</p>
              <button
                type="button"
                onClick={() => closePanel(true)}
                aria-label="Close share options"
                className="flex h-11 w-11 items-center justify-center rounded-full text-ink hover:bg-trust/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-trust"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <button type="button" data-share-initial onClick={handleCopyLink} className={ITEM_CLASS}>
              {copyState === 'copied' ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
              {copyState === 'copied' ? 'Link copied' : 'Copy link'}
            </button>
            {copyState === 'failed' && (
              <div className="px-4 pb-2 sm:px-3">
                <p className="text-xs text-muted">Could not copy automatically. Select and copy this link:</p>
                <input
                  readOnly
                  value={url}
                  aria-label="Article link"
                  onFocus={(event) => event.currentTarget.select()}
                  className="mt-1 w-full rounded-compact border border-line px-2 py-1 text-xs text-ink"
                />
              </div>
            )}
            <a href={buildEmailShareHref(url, title)} className={ITEM_CLASS} onClick={() => closePanel(true)}>
              <Mail className="h-3.5 w-3.5" aria-hidden="true" />
              Email
            </a>
            {items.map((link) => (
              <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className={ITEM_CLASS} onClick={() => closePanel(true)}>
                {link.label}
              </a>
            ))}
            {nativeShare && (
              <button type="button" onClick={handleMoreOptions} className={ITEM_CLASS}>
                <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
                More options…
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
