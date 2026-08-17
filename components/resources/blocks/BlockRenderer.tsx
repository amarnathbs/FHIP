// Read-only structured-block renderer — spec §64: "Create a reusable
// renderer for supported block types. This renderer should later be
// reusable by R1.5 public pages... Separate editor representation from
// read-only renderer." This component is that renderer. It is used by the
// Admin preview (R1.3) and is intentionally free of any editor/admin-only
// concern (no edit handlers, no Supabase calls) so R1.5's public page can
// import it unchanged.
//
// Deliberately not `dangerouslySetInnerHTML` anywhere — every piece of text
// goes through `InlineMarkup`, which only ever emits <strong>/<em>/<a>/text
// React nodes from the restrained markdown-lite syntax (see
// lib/resources/editor/richtext.ts's header for the full rationale). A
// block whose stored text literally contains `<script>...</script>` renders
// as the literal visible characters `<script>...</script>`, never as an
// executed script — there is no code path in this component that could
// interpret it as markup.

import { parseInlineMarkup } from '@/lib/resources/editor/richtext';
import { isKnownBlockType, BLOCK_TYPE_LABELS, type AnyBlock, type ParagraphData, type HeadingData, type ListData, type CalloutLikeData, type QuoteData, type TableData } from '@/lib/resources/editor/blocks';

export function InlineMarkup({ text }: { text: string }) {
  const segments = parseInlineMarkup(text || '');
  return (
    <>
      {segments.map((s, i) => {
        if (s.kind === 'bold') return <strong key={i}>{s.text}</strong>;
        if (s.kind === 'italic') return <em key={i}>{s.text}</em>;
        if (s.kind === 'link')
          return (
            <a key={i} href={s.href} target="_blank" rel="noopener noreferrer nofollow" className="text-trust underline underline-offset-2">
              {s.text}
            </a>
          );
        return <span key={i}>{s.text}</span>;
      })}
    </>
  );
}

// Shared "emphasis card" look for callout/example/warning/fhip_context —
// distinguished by an accessible label prefix, not colour alone (spec §7/
// the same colour-is-never-the-only-signal rule ResourceBadges already follows).
function EmphasisCard({ label, tone, text }: { label: string; tone: 'trust' | 'attention' | 'risk' | 'ai'; text: string }) {
  const toneClasses: Record<string, string> = {
    trust: 'border-trust/30 bg-trust/5',
    attention: 'border-attention/30 bg-attention/5',
    risk: 'border-risk/30 bg-risk/5',
    ai: 'border-ai/30 bg-ai/5',
  };
  return (
    <div className={`rounded-card border p-4 ${toneClasses[tone]}`}>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="text-sm leading-relaxed text-ink">
        <InlineMarkup text={text} />
      </p>
    </div>
  );
}

function RenderBlock({ block }: { block: AnyBlock }) {
  if (!isKnownBlockType(block.type)) {
    // Forward-compatibility (spec §25): never crash on, or silently drop, a
    // block type this build doesn't understand.
    return (
      <div className="rounded-card border border-dashed border-line bg-gray-50 p-3 text-xs text-muted" role="note">
        Unsupported block type: {block.type}
      </div>
    );
  }

  switch (block.type) {
    case 'paragraph': {
      const d = block.data as ParagraphData;
      if (!d.text?.trim()) return null;
      return (
        <p className="text-sm leading-relaxed text-ink">
          <InlineMarkup text={d.text} />
        </p>
      );
    }
    case 'heading': {
      const d = block.data as HeadingData;
      if (!d.text?.trim()) return null;
      const Tag = (`h${d.level}` as unknown) as 'h2' | 'h3' | 'h4';
      const sizeClass = d.level === 2 ? 'text-xl' : d.level === 3 ? 'text-lg' : 'text-base';
      return (
        <Tag className={`${sizeClass} font-semibold text-ink`}>
          <InlineMarkup text={d.text} />
        </Tag>
      );
    }
    case 'bulleted_list': {
      const d = block.data as ListData;
      const items = (d.items ?? []).filter((i) => i.trim());
      if (items.length === 0) return null;
      return (
        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink">
          {items.map((item, i) => (
            <li key={i}>
              <InlineMarkup text={item} />
            </li>
          ))}
        </ul>
      );
    }
    case 'numbered_list': {
      const d = block.data as ListData;
      const items = (d.items ?? []).filter((i) => i.trim());
      if (items.length === 0) return null;
      return (
        <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-ink">
          {items.map((item, i) => (
            <li key={i}>
              <InlineMarkup text={item} />
            </li>
          ))}
        </ol>
      );
    }
    case 'key_takeaways': {
      const d = block.data as ListData;
      const items = (d.items ?? []).filter((i) => i.trim());
      if (items.length === 0) return null;
      return (
        <div className="rounded-card border border-positive/30 bg-positive/5 p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-positive">Key Takeaways</p>
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink">
            {items.map((item, i) => (
              <li key={i}>
                <InlineMarkup text={item} />
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case 'callout': {
      const d = block.data as CalloutLikeData;
      if (!d.text?.trim()) return null;
      return <EmphasisCard label="Callout" tone="trust" text={d.text} />;
    }
    case 'example': {
      const d = block.data as CalloutLikeData;
      if (!d.text?.trim()) return null;
      return <EmphasisCard label="Example" tone="ai" text={d.text} />;
    }
    case 'warning': {
      const d = block.data as CalloutLikeData;
      if (!d.text?.trim()) return null;
      return <EmphasisCard label="Important" tone="risk" text={d.text} />;
    }
    case 'fhip_context': {
      const d = block.data as CalloutLikeData;
      if (!d.text?.trim()) return null;
      return <EmphasisCard label="What This Means in FHIP" tone="attention" text={d.text} />;
    }
    case 'quote': {
      const d = block.data as QuoteData;
      if (!d.text?.trim()) return null;
      return (
        <blockquote className="border-l-4 border-line pl-4 text-sm italic leading-relaxed text-ink">
          <InlineMarkup text={d.text} />
          {d.attribution?.trim() && <footer className="mt-1 text-xs not-italic text-muted">— {d.attribution}</footer>}
        </blockquote>
      );
    }
    case 'divider':
      return <hr className="border-line" />;
    case 'table': {
      const d = block.data as TableData;
      const headers = (d.headers ?? []).filter((h) => h.trim());
      const rows = d.rows ?? [];
      if (headers.length === 0 && rows.length === 0) return null;
      return (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            {headers.length > 0 && (
              <thead>
                <tr>
                  {headers.map((h, i) => (
                    <th key={i} className="border-b border-line px-3 py-2 text-left font-semibold text-ink">
                      <InlineMarkup text={h} />
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="border-b border-line px-3 py-2 text-ink">
                      <InlineMarkup text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      return null;
  }
}

export function BlockRenderer({ blocks }: { blocks: AnyBlock[] }) {
  if (!blocks || blocks.length === 0) {
    return <p className="text-sm text-muted">This Resource has no content blocks yet.</p>;
  }
  return (
    <div className="space-y-4">
      {blocks.map((b) => (
        <RenderBlock key={b.id} block={b} />
      ))}
    </div>
  );
}

export { BLOCK_TYPE_LABELS };
