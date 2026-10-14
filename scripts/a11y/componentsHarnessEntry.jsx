// Browser entry for scripts/a11y/componentsCheck.mjs: the REAL shared PageBackLink and the REAL day-first date field
// (components/resources/editor/FormField.tsx DateTextField -> components/ui/DateInput.tsx) on a page shaped like the Money Update editor.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PageBackLink } from '@/components/navigation/PageBackLink';
import { DateTextField, TextField } from '@/components/resources/editor/FormField';

function Page() {
  const [iso, setIso] = useState('');
  const [title, setTitle] = useState('India Inflation Update');
  return (
    <main className="mx-auto max-w-3xl px-4 py-8" style={{ background: '#F5F7FA' }}>
      <PageBackLink href="/admin/resources/money-updates" label="Money Updates" />
      <h1 className="text-xl font-semibold text-ink">Money Update editor (harness)</h1>
      <div className="mt-4 space-y-4">
        <TextField label="Title" value={title} onChange={setTitle} />
        <DateTextField label="Event Date" value={iso} onChange={setIso} required hint="The real-world date this development occurred." />
        <p data-testid="iso-state">state:{iso}</p>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Page />);
