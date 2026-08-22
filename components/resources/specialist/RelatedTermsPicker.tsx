'use client';

// R1.4 Glossary Related Terms picker — spec §30: relationships, not free
// text. Self-reference is excluded from `options` by the caller (the
// options query already excludes the current term's own id); duplicate
// pairs and self-reference are also guarded server-side by
// resource_related_content's own DB constraints.

import type { RelatedOption } from '@/lib/resources/editor/types';

export function RelatedTermsPicker({ options, selected, onChange }: { options: RelatedOption[]; selected: string[]; onChange: (ids: string[]) => void }) {
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  }
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-ink">Related Terms</legend>
      {options.length === 0 ? (
        <p className="text-xs text-muted">No other glossary terms exist yet.</p>
      ) : (
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-compact border border-line p-2">
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} className="h-4 w-4 rounded border-line text-trust focus:ring-trust" />
              {o.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
