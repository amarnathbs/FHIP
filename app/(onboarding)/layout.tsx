import { OnboardingTopBar } from '@/components/ui/OnboardingTopBar';

// App Review spec §15 — fixes the real gap found: onboarding previously had
// no layout at all (fell through to the bare root layout), so it never
// rendered any sign-out control. This stays deliberately minimal (a thin top
// bar, not the full AppShell sidebar) so the wizard is still the
// distraction-free flow it was designed to be — see app/(app)/layout.tsx's
// comment for why onboarding was split into its own route group in the
// first place.
export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <OnboardingTopBar />
      <main>{children}</main>
    </div>
  );
}
