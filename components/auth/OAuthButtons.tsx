'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// Each provider below must be enabled in the Supabase dashboard
// (Authentication → Providers) with a Client ID/Secret from that
// provider's own developer console before these buttons will work —
// clicking one before that step returns a "provider is not enabled"
// error from Supabase, not a bug in this component. See the setup
// checklist this was delivered with for the exact steps per provider.
const PROVIDERS = [
  {
    id: 'google' as const,
    label: 'Google',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.87 2.7-6.62Z" />
        <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.85.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18Z" />
        <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33Z" />
        <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58Z" />
      </svg>
    ),
  },
  // Facebook temporarily removed (2026-08-11) — Meta's App Domains /
  // OAuth redirect validation kept rejecting the flow ("Can't load URL:
  // domain isn't included in app's domains") on the return leg from
  // Facebook's consent screen, even with every domain involved
  // (financialhealthplatform.com, app.financialhealthplatform.com, and
  // the Supabase project domain) correctly added and saved. Google and
  // LinkedIn were unaffected by this and both work end-to-end. Re-add
  // the entry below (with its icon, preserved in git history at this
  // commit) once the Meta-side issue is resolved — no other code
  // changes needed, this list is the only place a provider is toggled.
  {
    id: 'linkedin_oidc' as const,
    label: 'LinkedIn',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <rect width="18" height="18" rx="2" fill="#0A66C2" />
        <path
          fill="#fff"
          d="M5.2 7.14H2.6V15h2.6V7.14ZM3.9 6.02a1.51 1.51 0 1 0 0-3.02 1.51 1.51 0 0 0 0 3.02ZM15.4 15h-2.6v-4.02c0-.96-.02-2.2-1.34-2.2-1.34 0-1.55 1.05-1.55 2.13V15H7.31V7.14h2.5v1.07h.03c.35-.66 1.2-1.34 2.47-1.34 2.64 0 3.13 1.74 3.13 4V15Z"
        />
      </svg>
    ),
  },
];

export function OAuthButtons() {
  const supabase = createClient();
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(provider: (typeof PROVIDERS)[number]['id']) {
    setError(null);
    setLoadingProvider(provider);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    // On success the browser navigates away to the provider's consent
    // screen, so this only runs when signInWithOAuth itself failed
    // (most commonly: the provider isn't enabled in Supabase yet).
    if (error) {
      setLoadingProvider(null);
      setError(error.message);
    }
  }

  return (
    <div>
      <div className="flex flex-col gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => handleClick(p.id)}
            disabled={loadingProvider !== null}
            className="flex w-full items-center justify-center gap-2 rounded border px-4 py-2 font-medium text-gray-700 disabled:opacity-60"
          >
            {p.icon}
            {loadingProvider === p.id ? 'Redirecting...' : `Continue with ${p.label}`}
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-sm text-risk">{error}</p>}
      <div className="my-4 flex items-center gap-3 text-xs text-gray-400">
        <div className="h-px flex-1 bg-gray-200" />
        or
        <div className="h-px flex-1 bg-gray-200" />
      </div>
    </div>
  );
}
