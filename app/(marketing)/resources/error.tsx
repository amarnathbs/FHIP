'use client';

import { PublicErrorState } from '@/components/resources/public/PublicStates';

export default function ResourcesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <PublicErrorState message={error.message || 'An unexpected error occurred.'} onRetry={reset} />
    </div>
  );
}
