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

export function GuideTOC({ entries }: { entries: TocEntry[] }) {
  if (entries.length === 0) return null;

  const list = (
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

  return (
    <>
      {/* Desktop/tablet: persistent sidebar block (spec §79: "optional content/sidebar arrangement for TOC/metadata at desktop"). */}
      <nav aria-label="On this page" className="hidden lg:block">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">On this page</p>
        {list}
      </nav>

      {/* Mobile/tablet: collapsible disclosure (spec §31). */}
      <details className="rounded-card border border-line bg-white p-3 lg:hidden">
        <summary className="cursor-pointer list-none text-sm font-semibold text-ink marker:content-none">On this page</summary>
        <div className="mt-2">{list}</div>
      </details>
    </>
  );
}
