import { AppShell } from '@/components/ui/AppShell';

// AppShell lives here (not wrapped individually in each page.tsx) so the
// sidebar survives client-side navigation instead of unmounting and
// remounting on every route change — the previous per-page wrapping pattern
// meant AppShell's open-dropdown/scroll state reset on every click, even
// though the code looked like it should persist. onboarding is deliberately
// NOT under this route group (moved to app/(onboarding)/) since it's a
// distraction-free wizard flow that has never shown the app chrome.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
