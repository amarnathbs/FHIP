'use client';

// Social sharing for a public Resource detail page. Client component (needs
// navigator.share/clipboard/window interactions) rendered inside the
// otherwise-server ResourceDetailHeader.
//
// The Share button ALWAYS opens the dropdown: direct share links for the
// platforms this content actually gets shared to, plus a "Copy link" that works
// regardless of platform support. 2026-10-01: it used to hand straight off to
// the Web Share API whenever the browser exposed it -- which includes Edge and
// Chrome on Windows -- and that opens the OS share sheet, whose targets
// (LinkedIn, Facebook, X, WhatsApp, Gmail ...) are whatever apps happen to be
// installed on that machine, and often do nothing. The reliable web links were
// therefore never shown. The native sheet is now an optional "More options..."
// entry, offered only where the browser supports it.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Share2, Copy, Check, Mail } from 'lucide-react';

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

// Exported for tests/unit/shareButton.test.ts.
export function canUseNativeShare(nav: { share?: unknown } | undefined): boolean {
  return !!nav && typeof nav.share === 'function';
}

export function ShareButton({ url, title }: { url: string; title: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Server snapshot is false so server and first client render match.
  const nativeShare = useSyncExternalStore(
    () => () => {},
    () => canUseNativeShare(typeof navigator !== 'undefined' ? navigator : undefined),
    () => false,
  );
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setMenuOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuOpen]);

  function handleShareClick() {
    setMenuOpen((open) => !open);
  }

  async function handleNativeShare() {
    setMenuOpen(false);
    try {
      await navigator.share({ title, url });
    } catch {
      // User cancelled the OS share sheet, or it failed; the dropdown's own
      // links and Copy link remain available from the button.
    }
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable/denied — the dropdown's direct share
      // links still work, so this is a soft failure, not a dead end.
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleShareClick}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-xs font-medium text-ink hover:bg-trust/5"
      >
        <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
        Share
      </button>
      {menuOpen && (
        <div role="menu" aria-label="Share this article" className="absolute right-0 z-10 mt-2 w-48 rounded-card border border-line bg-white py-1 shadow-lg">
          {buildShareLinks(url, title).map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              role="menuitem"
              className="block px-3 py-2 text-sm text-ink hover:bg-trust/5"
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </a>
          ))}
          <a
            href={`mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`}
            role="menuitem"
            className="flex items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-trust/5"
            onClick={() => setMenuOpen(false)}
          >
            <Mail className="h-3.5 w-3.5" aria-hidden="true" />
            Email
          </a>
          {nativeShare && (
            <button
              type="button"
              role="menuitem"
              onClick={handleNativeShare}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-trust/5"
            >
              <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
              More options…
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={handleCopyLink}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-trust/5"
          >
            {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            {copied ? 'Copied!' : 'Copy link'}
          </button>
        </div>
      )}
    </div>
  );
}
