'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

// App Review spec §15 — the real gap: the onboarding route group
// (app/(onboarding)/) deliberately has no AppShell (distraction-free wizard,
// see app/(app)/layout.tsx's own comment on why onboarding is split out),
// but that also meant it had literally no way to sign out — signOut() only
// existed inside AppShell, only mounted by app/(app)/layout.tsx. A user
// stuck mid-onboarding (e.g. by an error, or just wanting to leave and come
// back later) had no visible way to leave their session. This is a minimal
// top bar — not the full app chrome — giving onboarding exactly what the
// spec asks for: sign out, and a way to reach Account (proxy.ts exempts
// /profile from the onboarding-forced-redirect so this link actually works
// mid-onboarding) and help, without restoring the full financial-modules
// sidebar to a user who hasn't unlocked it yet.
export function OnboardingTopBar() {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="flex items-center justify-between border-b border-line bg-white px-4 py-3 sm:px-6">
      <span className="text-lg font-semibold text-trust">FHIP</span>
      <nav className="flex items-center gap-4 text-sm">
        <Link href="/profile" className="text-muted hover:text-trust hover:underline">
          Account
        </Link>
        <a
          href="mailto:support@financialhealthplatform.com"
          className="text-muted hover:text-trust hover:underline"
        >
          Need help?
        </a>
        <button onClick={() => void signOut()} className="font-medium text-trust hover:underline">
          Sign out
        </button>
      </nav>
    </header>
  );
}
