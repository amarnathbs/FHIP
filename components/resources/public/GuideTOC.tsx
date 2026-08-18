// Spec §30-31: "On this page" navigation auto-derived from a Guide's own
// H2/H3 heading blocks — never a second, manually-maintained TOC field.
// Anchors point at the block's own stable id (see BlockRenderer.tsx's
// heading case). Plain <a href="#id"> links — keyboard accessible and
// functional with zero client JS (spec §31: "keyboard accessible"; §78:
// progressive enhancement). Mobile collapses into a native <details>
// disclosure (spec §31: "Mobile: TOC may collapse into 'On this page'
// disclosure").

import type { AnyBlock, HeadingData } from '@/lib/resources/editor/blocks';

export interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3 | 4;
}

export function deriveTocFromBlocks(blocks: AnyBlock[]): TocEntry[] {
  return blocks
    .filter((b): b is AnyBlock & { type: 'heading' } => b.type === 'heading')
    .map((b) => {
      const d = b.data as HeadingData;
      return { id: b.id, text: d.text, level: d.level };
    })
    .filter((e) => e.text?.trim());
}

function TocList({ entries }: { entries: TocEntry[] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {entries.map((e) => (
        <li key={e.id} style={{ paddingLeft: e.level === 3 ? '0.75rem' : e.level === 4 ? '1.5rem' : 0 }}>
          <a href={`#${e.id}`} className="text-muted hover:text-trust hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust">
            {e.text}
          </a>
        </li>
      ))}
    </ul>
  );
}

// Split into two single-purpose components rather than one component that
// renders both variants internally (`hidden lg:block` / `lg:hidden`) — a
// prior version did that and was called twice (once inline in the article
// body for mobile, once again in the desktop <aside>), which meant the
// "desktop nav" half of the FIRST call had nothing hiding it at lg+ widths
// and rendered a visible duplicate TOC inline above the article body.
// Confirmed live via DOM inspection during the R1.5 responsive pass at
// 1024px before this fix (2 <nav aria-label="On this page"> elements both
// visible). Each of these two components is now rendered exactly once, in
// exactly the layout slot it belongs to — see app/(marketing)/resources/[slug]/page.tsx.

// Desktop/tablet: persistent sidebar block (spec §79: "optional content/
// sidebar arrangement for TOC/metadata at desktop"). Render this only
// inside the <aside> column.
export function GuideTocDesktop({ entries }: { entries: TocEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <nav aria-label="On this page">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">On this page</p>
      <TocList entries={entries} />
    </nav>
  );
}

// Mobile/tablet: collapsible disclosure (spec §31). Render this only inline
// in the article body, hidden at lg+ via its own class (the desktop
// sidebar takes over at that width instead).
export function GuideTocMobile({ entries }: { entries: TocEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <details className="rounded-card border border-line bg-white p-3 lg:hidden">
      <summary className="cursor-pointer list-none text-sm font-semibold text-ink marker:content-none">On this page</summary>
      <div className="mt-2">
        <TocList entries={entries} />
      </div>
    </details>
  );
}
