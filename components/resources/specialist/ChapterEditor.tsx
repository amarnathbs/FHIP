'use client';

// R1.4 Video chapter management — spec §20, §79. Add/Edit/Reorder/Delete,
// no drag-and-drop (spec §79: "Do not rely on drag-only reordering" — this
// build has no drag interaction at all, so keyboard/click Move Up/Move Down
// buttons are the only way to reorder, same principle as R1.3's BlockEditor).

import { TextField } from '@/components/resources/editor/FormField';
import { createChapter, isValidChapterTimestamp, type VideoChapter } from '@/lib/resources/video/youtube';

export function ChapterEditor({ chapters, onChange, errors }: { chapters: VideoChapter[]; onChange: (chapters: VideoChapter[]) => void; errors?: Record<string, string> }) {
  function update(index: number, patch: Partial<VideoChapter>) {
    const next = [...chapters];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  }
  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= chapters.length) return;
    const next = [...chapters];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }
  function remove(index: number) {
    onChange(chapters.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-3">
      {chapters.length === 0 && <p className="text-sm text-muted">No chapters added yet.</p>}
      <ul className="space-y-3">
        {chapters.map((c, i) => {
          const invalidTimestamp = c.timestamp.trim() !== '' && !isValidChapterTimestamp(c.timestamp);
          return (
            <li key={c.id} className="rounded-compact border border-line p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_1fr]">
                <TextField
                  label={`Chapter ${i + 1} timestamp`}
                  value={c.timestamp}
                  onChange={(v) => update(i, { timestamp: v })}
                  placeholder="00:00"
                  hint="mm:ss or h:mm:ss"
                  error={invalidTimestamp ? 'Enter a valid timestamp, e.g. 02:15.' : errors?.[c.id]}
                />
                <TextField label={`Chapter ${i + 1} title`} value={c.title} onChange={(v) => update(i, { title: v })} placeholder="e.g. Why emergency funds matter" />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move chapter ${i + 1} up`} className="rounded border border-line px-2 py-1 text-xs text-ink disabled:opacity-40">
                  Move Up
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === chapters.length - 1}
                  aria-label={`Move chapter ${i + 1} down`}
                  className="rounded border border-line px-2 py-1 text-xs text-ink disabled:opacity-40"
                >
                  Move Down
                </button>
                <button type="button" onClick={() => remove(i)} aria-label={`Delete chapter ${i + 1}`} className="rounded border border-line px-2 py-1 text-xs text-risk hover:bg-risk/5">
                  Delete Chapter
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={() => onChange([...chapters, createChapter()])} className="text-sm font-semibold text-trust hover:underline">
        + Add Chapter
      </button>
    </div>
  );
}
