'use client';

import { useId, type ReactNode } from 'react';
import { FieldShell, INPUT_BASE } from '@/components/admin/benchmarkData/ui';

/** A file chooser that looks like a control: a bordered box with a styled "Choose file" button and a visible focus ring (shared admin kit tokens). */
export function FileField({ label, accept, onFile, hint, error, fileName, disabled }: { label: string; accept?: string; onFile: (file: File | null) => void; hint?: ReactNode; error?: string | null; fileName?: string; disabled?: boolean }) {
  const id = useId();
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <input
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        className={`${INPUT_BASE} ${error ? 'border-risk ring-1 ring-risk' : 'border-line'} cursor-pointer file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-trust file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white`}
      />
      {fileName ? <p className="mt-1 text-xs text-muted">Chosen: {fileName}</p> : null}
    </FieldShell>
  );
}
