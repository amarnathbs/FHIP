'use client';

// R1.4 minimal authoritative-source picker — spec §49-51. Select from
// existing resource_sources rows, or add a new one inline (title/publisher,
// URL, publication date, source type, public flag). URL is validated
// client-side for immediate feedback; the server (lib/resources/sources/
// mutations.ts createSource) is the actual enforcement boundary (spec §51:
// "Never trust client-side only").

import { useState } from 'react';
import { TextField, SelectField, CheckboxField } from '@/components/resources/editor/FormField';
import { isSafeSourceUrl } from '@/lib/resources/sources/validation';
import type { SourceOption } from '@/lib/resources/sources/types';

const SOURCE_TYPE_OPTIONS = [
  { value: 'regulator', label: 'Regulator / Government Authority' },
  { value: 'official_publication', label: 'Official Publication' },
  { value: 'news', label: 'News' },
  { value: 'fhip_internal', label: 'FHIP Internal' },
  { value: 'other', label: 'Other' },
];

export function SourcePicker({
  options,
  selectedIds,
  onChangeSelection,
  onSourceCreated,
}: {
  options: SourceOption[];
  selectedIds: string[];
  onChangeSelection: (ids: string[]) => void;
  onSourceCreated: (source: SourceOption) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [docTitle, setDocTitle] = useState('');
  const [url, setUrl] = useState('');
  const [sourceType, setSourceType] = useState('regulator');
  const [publicationDate, setPublicationDate] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const urlError = url.trim() && !isSafeSourceUrl(url) ? 'Enter a valid https:// URL.' : undefined;

  function toggle(id: string) {
    onChangeSelection(selectedIds.includes(id) ? selectedIds.filter((s) => s !== id) : [...selectedIds, id]);
  }

  async function submitNewSource() {
    setError(null);
    if (!name.trim()) {
      setError('A source name is required.');
      return;
    }
    if (url.trim() && !isSafeSourceUrl(url)) {
      setError('Enter a valid https:// URL.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/admin/resources/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_name: name, document_title: docTitle, url, source_type: sourceType, publication_date: publicationDate, is_public: isPublic }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not create this source.');
      const created: SourceOption = { id: json.data.id, source_name: name, document_title: docTitle || null, url: url || null, source_type: sourceType, publication_date: publicationDate || null, is_public: isPublic };
      onSourceCreated(created);
      onChangeSelection([...selectedIds, created.id]);
      setName('');
      setDocTitle('');
      setUrl('');
      setPublicationDate('');
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-ink">Official Sources</legend>
        {options.length === 0 ? (
          <p className="text-xs text-muted">No sources exist yet — add one below.</p>
        ) : (
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-compact border border-line p-2">
            {options.map((o) => (
              <label key={o.id} className="flex items-start gap-2 text-sm text-ink">
                <input type="checkbox" checked={selectedIds.includes(o.id)} onChange={() => toggle(o.id)} className="mt-0.5 h-4 w-4 rounded border-line text-trust focus:ring-trust" />
                <span>
                  <span className="block font-medium">{o.source_name}</span>
                  {o.url && <span className="block text-xs text-muted break-all">{o.url}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {!adding ? (
        <button type="button" onClick={() => setAdding(true)} className="text-sm font-semibold text-trust hover:underline">
          + Add a Source
        </button>
      ) : (
        <div className="rounded-compact border border-line bg-gray-50 p-3 space-y-3">
          {error && (
            <p role="alert" className="text-xs font-medium text-risk">
              {error}
            </p>
          )}
          <TextField label="Source Name / Authority" value={name} onChange={setName} required placeholder="e.g. Reserve Bank of Australia (RBA)" />
          <TextField label="Document Title (optional)" value={docTitle} onChange={setDocTitle} />
          <TextField label="URL" value={url} onChange={setUrl} placeholder="https://…" error={urlError} />
          <SelectField label="Source Type" value={sourceType} onChange={setSourceType} options={SOURCE_TYPE_OPTIONS} />
          <TextField label="Publication Date (optional)" value={publicationDate} onChange={setPublicationDate} placeholder="YYYY-MM-DD" />
          <CheckboxField label="Publicly citable" checked={isPublic} onChange={setIsPublic} />
          <div className="flex gap-2">
            <button type="button" disabled={saving} onClick={submitNewSource} className="rounded-full bg-trust px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? 'Adding…' : 'Add Source'}
            </button>
            <button type="button" onClick={() => setAdding(false)} className="rounded-full border border-line px-3 py-1.5 text-sm text-ink">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
