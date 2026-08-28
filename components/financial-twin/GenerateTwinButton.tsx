'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function GenerateTwinButton({ label = 'Generate Financial Twin' }: { label?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/financial-twin/generate', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not generate Financial Twin');
      // G0-JA-1 Wave 1 (JA-D1): the API's distinguishable unavailable-state
      // contract — never render this as a generic failure, and never fall
      // through to router.refresh() as if a comparison were generated.
      if (json.data?.status === 'country_unresolved') {
        throw new Error(json.data.message ?? 'Country confirmation required before this comparison can be generated.');
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={generate} disabled={loading} className="rounded bg-trust px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-60">
        {loading ? 'Generating…' : label}
      </button>
      {error && <p className="mt-2 text-xs text-risk">{error}</p>}
    </div>
  );
}
