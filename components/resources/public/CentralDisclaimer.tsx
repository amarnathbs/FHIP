// Spec §57: "Use the centrally managed Resources disclaimer/settings where
// implemented. Do not copy/paste separate disclaimer wording into each
// public component." Every content-type detail page renders this one
// component (which itself calls the one shared getCentralDisclaimer()
// query) rather than each page carrying its own copy of the wording.

import { getCentralDisclaimer } from '@/lib/resources/public/queries';
import type { SupabaseClient } from '@supabase/supabase-js';

// `prominent` (spec §57: "Money Updates may require a more prominent
// time-sensitive disclaimer if existing settings support it") switches the
// visual treatment only — the wording itself still comes from the one
// central source, never a second hard-coded string.
export async function CentralDisclaimer({ supabase, prominent }: { supabase: SupabaseClient; prominent?: boolean }) {
  const text = await getCentralDisclaimer(supabase);
  return (
    <p role="note" className={prominent ? 'rounded-card border border-attention/30 bg-attention/5 p-4 text-sm text-attention' : 'text-xs text-muted'}>
      {text}
    </p>
  );
}
