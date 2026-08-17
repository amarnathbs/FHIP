'use client';

// R1.4 Glossary aliases/synonyms editor — spec §26. A simple chip-list with
// a real text input + Add button (no comma-typing-triggers-a-chip magic that
// would be hard to explain to a screen reader) — every alias is individually
// removable via a labelled button (spec §121: no unlabeled interactive
// controls).

import { useState } from 'react';

export function AliasesEditor({ aliases, onChange }: { aliases: string[]; onChange: (aliases: string[]) => void }) {
  const [draft, setDraft] = useState('');

  function add() {
    const cleaned = draft.trim();
    if (!cleaned) return;
    if (aliases.some((a) => a.toLowerCase() === cleaned.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange([...aliases, cleaned]);
    setDraft('');
  }

  return (
    <div>
      <label htmlFor="glossary-alias-input" className="block text-sm font-medium text-ink">
        Aliases / Search Synonyms
      </label>
      <p className="mt-0.5 text-xs text-muted">e.g. Emergency Fund, Rainy Day Fund, Cash Buffer</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {aliases.map((a, i) => (
          <span key={`${a}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-ink">
            {a}
            <button type="button" onClick={() => onChange(aliases.filter((_, idx) => idx !== i))} aria-label={`Remove alias ${a}`} className="text-muted hover:text-risk">
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          id="glossary-alias-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add an alias…"
          className="block w-full max-w-xs rounded-compact border border-line px-3 py-2 text-sm text-ink focus:border-trust focus:outline-none focus:ring-1 focus:ring-trust"
        />
        <button type="button" onClick={add} className="rounded-compact border border-line px-3 py-2 text-sm font-semibold text-ink hover:bg-gray-50">
          Add
        </button>
      </div>
    </div>
  );
}
