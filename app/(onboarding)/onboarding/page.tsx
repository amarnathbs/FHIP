import { OnboardingWizard } from './OnboardingWizard';

// NEVER make this a static page again (26-11-2026). With no per-user code Next.js built it as static and sent `s-maxage=31536000`; the CDN in front of production saved the blank wizard and served it to
// users with complete profiles without running proxy.ts. force-dynamic makes Next send `private, no-store`. scripts/check-protected-routes-dynamic.mjs fails if any signed-in page is static.
export const dynamic = 'force-dynamic';

export default function OnboardingPage() {
  return <OnboardingWizard />;
}
