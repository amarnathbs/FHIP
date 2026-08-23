import Link from 'next/link';

// Spec §71/§72/§86: the exact same not-found result whether a slug never
// existed or exists but isn't currently public — no distinguishing wording
// ("this article exists but hasn't been published") anywhere on this page.
export default function ResourcesNotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
      <p className="text-sm font-semibold uppercase tracking-wide text-muted">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">We couldn&rsquo;t find that page.</h1>
      <p className="mt-2 text-muted">The page you&rsquo;re looking for doesn&rsquo;t exist or is no longer available.</p>
      <Link href="/resources" className="mt-6 inline-block rounded-compact bg-trust px-4 py-2 font-semibold text-white hover:bg-trust-700">
        Back to Resources
      </Link>
    </div>
  );
}
