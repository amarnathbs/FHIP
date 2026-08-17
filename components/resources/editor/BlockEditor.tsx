'use client';

// R1.3 structured content block editor — spec §22-31, §86-88, §122.
//
// Controlled-React-inputs block editor (spec §32) — no TipTap/ProseMirror/
// Lexical/Slate. Every block is a plain data object edited through ordinary
// form controls; Move Up/Move Down are always present (spec §88: "Move Up /
// Move Down buttons are mandatory if drag-and-drop is implemented" — this
// build has no drag-and-drop at all, so these are the *only* reordering
// method, which trivially satisfies "keyboard users must not depend on
// drag-and-drop").

import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TextField, TextAreaField, SelectField } from './FormField';
import {
  createBlock,
  isKnownBlockType,
  blockHasMeaningfulContent,
  BLOCK_TYPE_LABELS,
  BLOCK_MENU_GROUPS,
  type AnyBlock,
  type BlockType,
  type ParagraphData,
  type HeadingData,
  type ListData,
  type CalloutLikeData,
  type QuoteData,
  type TableData,
} from '@/lib/resources/editor/blocks';

const RICH_TEXT_HINT = 'You can use **bold**, _italic_, and [link text](https://example.com).';

function ItemListEditor({ items, onChange, itemLabel }: { items: string[]; onChange: (items: string[]) => void; itemLabel: string }) {
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2">
          <TextField
            label={`${itemLabel} ${i + 1}`}
            value={item}
            onChange={(v) => {
              const next = [...items];
              next[i] = v;
              onChange(next);
            }}
            id={undefined}
          />
          <button
            type="button"
            onClick={() => onChange(items.filter((_, idx) => idx !== i))}
            disabled={items.length <= 1}
            aria-label={`Remove ${itemLabel.toLowerCase()} ${i + 1}`}
            className="mt-6 shrink-0 rounded-compact border border-line px-2 py-1 text-xs text-muted hover:border-risk hover:text-risk disabled:opacity-40"
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, ''])} className="text-sm font-semibold text-trust hover:underline">
        + Add {itemLabel.toLowerCase()}
      </button>
    </div>
  );
}

function BlockBody({ block, onChange }: { block: AnyBlock; onChange: (data: unknown) => void }) {
  if (!isKnownBlockType(block.type)) {
    return (
      <div className="rounded border border-dashed border-line bg-gray-50 p-3 text-xs text-muted">
        This block&apos;s type (&quot;{block.type}&quot;) isn&apos;t supported by this editor build. Its data is preserved and will not be modified unless you delete this block.
      </div>
    );
  }

  switch (block.type) {
    case 'paragraph': {
      const d = block.data as ParagraphData;
      return <TextAreaField label="Text" value={d.text} onChange={(text) => onChange({ text })} hint={RICH_TEXT_HINT} rows={4} />;
    }
    case 'heading': {
      const d = block.data as HeadingData;
      return (
        <div className="grid grid-cols-[120px_1fr] gap-3">
          <SelectField
            label="Level"
            value={String(d.level)}
            onChange={(v) => onChange({ ...d, level: Number(v) as 2 | 3 | 4 })}
            options={[
              { value: '2', label: 'H2' },
              { value: '3', label: 'H3' },
              { value: '4', label: 'H4' },
            ]}
          />
          <TextField label="Heading text" value={d.text} onChange={(text) => onChange({ ...d, text })} hint="Body headings start at H2 — the page title is always H1." />
        </div>
      );
    }
    case 'bulleted_list':
    case 'numbered_list': {
      const d = block.data as ListData;
      return <ItemListEditor items={d.items} onChange={(items) => onChange({ items })} itemLabel="Item" />;
    }
    case 'key_takeaways': {
      const d = block.data as ListData;
      return <ItemListEditor items={d.items} onChange={(items) => onChange({ items })} itemLabel="Takeaway" />;
    }
    case 'callout':
    case 'example':
    case 'warning':
    case 'fhip_context': {
      const d = block.data as CalloutLikeData;
      return <TextAreaField label="Text" value={d.text} onChange={(text) => onChange({ text })} hint={RICH_TEXT_HINT} rows={3} />;
    }
    case 'quote': {
      const d = block.data as QuoteData;
      return (
        <div className="space-y-3">
          <TextAreaField label="Quote" value={d.text} onChange={(text) => onChange({ ...d, text })} hint={RICH_TEXT_HINT} rows={2} />
          <TextField label="Attribution (optional)" value={d.attribution ?? ''} onChange={(attribution) => onChange({ ...d, attribution })} />
        </div>
      );
    }
    case 'divider':
      return <p className="text-xs text-muted">Visual divider — no content to edit.</p>;
    case 'table': {
      const d = block.data as TableData;
      const setHeader = (i: number, v: string) => {
        const headers = [...d.headers];
        headers[i] = v;
        onChange({ ...d, headers });
      };
      const setCell = (ri: number, ci: number, v: string) => {
        const rows = d.rows.map((r) => [...r]);
        rows[ri][ci] = v;
        onChange({ ...d, rows });
      };
      const addColumn = () => onChange({ headers: [...d.headers, ''], rows: d.rows.map((r) => [...r, '']) });
      const addRow = () => onChange({ ...d, rows: [...d.rows, d.headers.map(() => '')] });
      const removeRow = (ri: number) => onChange({ ...d, rows: d.rows.filter((_, i) => i !== ri) });
      return (
        <div className="space-y-2 overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr>
                {d.headers.map((h, i) => (
                  <th key={i} className="p-1">
                    <input
                      aria-label={`Column ${i + 1} header`}
                      value={h}
                      onChange={(e) => setHeader(i, e.target.value)}
                      className="w-full rounded border border-line px-2 py-1 text-xs font-semibold"
                      placeholder={`Column ${i + 1}`}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="p-1">
                      <input
                        aria-label={`Row ${ri + 1}, column ${ci + 1}`}
                        value={cell}
                        onChange={(e) => setCell(ri, ci, e.target.value)}
                        className="w-full rounded border border-line px-2 py-1 text-xs"
                      />
                    </td>
                  ))}
                  <td>
                    <button type="button" onClick={() => removeRow(ri)} aria-label={`Remove row ${ri + 1}`} className="text-xs text-muted hover:text-risk">
                      Remove row
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-3">
            <button type="button" onClick={addColumn} className="text-xs font-semibold text-trust hover:underline">
              + Add column
            </button>
            <button type="button" onClick={addRow} className="text-xs font-semibold text-trust hover:underline">
              + Add row
            </button>
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}

function IconButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-compact border border-line px-2 py-1 text-xs text-muted hover:border-trust hover:text-trust disabled:opacity-30"
    >
      {label}
    </button>
  );
}

export function BlockEditor({ blocks, onChange }: { blocks: AnyBlock[]; onChange: (blocks: AnyBlock[]) => void }) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [pendingDeleteIndex, setPendingDeleteIndex] = useState<number | null>(null);

  function updateAt(index: number, data: unknown) {
    const next = blocks.map((b, i) => (i === index ? { ...b, data } : b));
    onChange(next);
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function duplicate(index: number) {
    const source = blocks[index];
    const copy: AnyBlock = { ...source, id: `${source.id}-copy-${Date.now()}` };
    const next = [...blocks];
    next.splice(index + 1, 0, copy);
    onChange(next);
  }

  function requestDelete(index: number) {
    if (blockHasMeaningfulContent(blocks[index])) {
      setPendingDeleteIndex(index);
    } else {
      onChange(blocks.filter((_, i) => i !== index));
    }
  }

  function confirmDelete() {
    if (pendingDeleteIndex === null) return;
    onChange(blocks.filter((_, i) => i !== pendingDeleteIndex));
    setPendingDeleteIndex(null);
  }

  function addBlock(type: BlockType) {
    onChange([...blocks, createBlock(type)]);
    setAddMenuOpen(false);
  }

  return (
    <div className="space-y-4">
      {blocks.length === 0 && <p className="text-sm text-muted">No content blocks yet. Use &quot;Add Block&quot; below to start.</p>}

      <ul className="space-y-4" aria-label="Content blocks">
        {blocks.map((b, i) => {
          const typeLabel = isKnownBlockType(b.type) ? BLOCK_TYPE_LABELS[b.type] : b.type;
          return (
            <li key={b.id} className="rounded-card border border-line bg-white p-4" aria-label={`${typeLabel} block ${i + 1}`}>
              <div className="mb-3 flex items-center justify-between border-b border-line pb-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                  {typeLabel} block {i + 1}
                </span>
                <div className="flex gap-1.5">
                  <IconButton label={`Move ${typeLabel} block ${i + 1} up`} onClick={() => move(i, -1)} disabled={i === 0} />
                  <IconButton label={`Move ${typeLabel} block ${i + 1} down`} onClick={() => move(i, 1)} disabled={i === blocks.length - 1} />
                  <IconButton label={`Duplicate ${typeLabel} block ${i + 1}`} onClick={() => duplicate(i)} />
                  <IconButton label={`Delete ${typeLabel} block ${i + 1}`} onClick={() => requestDelete(i)} />
                </div>
              </div>
              <BlockBody block={b} onChange={(data) => updateAt(i, data)} />
            </li>
          );
        })}
      </ul>

      <div>
        <button type="button" onClick={() => setAddMenuOpen((v) => !v)} aria-expanded={addMenuOpen} aria-controls="add-block-menu" className="rounded-full border border-trust px-4 py-2 text-sm font-semibold text-trust hover:bg-trust/5">
          + Add Block
        </button>
        {addMenuOpen && (
          <div id="add-block-menu" className="mt-3 rounded-card border border-line bg-white p-4">
            {BLOCK_MENU_GROUPS.map((group) => (
              <div key={group.label} className="mb-3 last:mb-0">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{group.label}</p>
                <div className="flex flex-wrap gap-2">
                  {group.types.map((t) => (
                    <button key={t} type="button" onClick={() => addBlock(t)} className="rounded-full border border-line px-3 py-1.5 text-sm text-ink hover:border-trust hover:text-trust">
                      {BLOCK_TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDeleteIndex !== null}
        title="Delete this block?"
        message="This block has content. Deleting it can't be undone once you save."
        confirmLabel="Delete Block"
        cancelLabel="Keep Block"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeleteIndex(null)}
      />
    </div>
  );
}
