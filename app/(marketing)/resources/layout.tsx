import { PublicResourcesNav, PublicResourcesFooter } from '@/components/resources/public/PublicResourcesNav';

// Spec §79: "a readable editorial column rather than full-screen long
// lines... single-column at tablet/mobile... do not copy the Admin
// editor's two-column layout." max-w-6xl on the shell, individual detail
// pages narrow further to a reading column inside this.
export default function PublicResourcesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-app">
      {/* No app-wide skip-to-content pattern exists yet (checked — spec
          §97 only requires testing one "if existing"); adding a small,
          section-scoped one here is a safe accessibility improvement that
          doesn't touch anything outside /resources. */}
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-compact focus:bg-trust focus:px-4 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <PublicResourcesNav />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <PublicResourcesFooter />
    </div>
  );
}
