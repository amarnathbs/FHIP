'use client';

import { useEffect, useState } from 'react';
import { ALL_OWNER_CLASSES, CONSOLIDATED_CHIP_LABEL, ownerClassOptionLabel, type OwnerClassOption } from './ownerClassUi';

// Investment Intelligence -- owner-class selector (2026-10-01, PO decision).
//
// Every analysis tab can be viewed per OWNER CLASS: personal (per household member),
// joint, each trust / HUF / company, shared-with-an-entity, unallocated. The default is
// the explicit "Consolidated (macro view only)" option, labelled as such: entity-owned
// holdings are never presented as part of a personal total. Choosing a class re-runs the
// same certified analysis on that class's accounts only (see ownerClassScope.ts); the
// parent re-mounts its content with `key={ownerClass}`, so nothing here sets state in an
// effect on the parent's behalf.

export function OwnerClassBar({ value, onChange, classes: preloaded }: { value: string; onChange: (key: string) => void; classes?: OwnerClassOption[] }) {
  const [classes, setClasses] = useState<OwnerClassOption[] | null>(preloaded ?? null);

  useEffect(() => {
    if (preloaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/investment-intelligence/owner-classes');
        const json = await res.json();
        if (!cancelled) setClasses(res.ok ? ((json.data?.classes ?? []) as OwnerClassOption[]) : []);
      } catch {
        if (!cancelled) setClasses([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [preloaded]);

  // Nothing to choose between: one class (or none) means the page is the whole picture already.
  if (!classes || classes.length < 2) return null;

  const chip = (key: string, label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => onChange(key)}
      aria-pressed={value === key}
      className={`min-h-9 rounded-full px-3 py-1 text-xs ${value === key ? 'bg-ink text-white' : 'bg-gray-100 text-muted hover:bg-gray-200'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="mb-4 rounded-card border border-line bg-white p-3" data-testid="owner-class-bar">
      <p className="text-xs uppercase tracking-wide text-muted">View by owner class</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {chip(ALL_OWNER_CLASSES, CONSOLIDATED_CHIP_LABEL)}
        {classes.map((c) => chip(c.key, ownerClassOptionLabel(c)))}
      </div>
      <p className="mt-2 text-xs text-muted">
        {value === ALL_OWNER_CLASSES
          ? 'You are looking at the consolidated macro view. Trust, HUF and company holdings are kept in their own owner classes and are not part of your personal total: pick a class to see it on its own.'
          : 'Showing this owner class only. Its figures come from the same analysis, run on this class’s accounts alone; they are not added to any other class.'}
      </p>
    </div>
  );
}
