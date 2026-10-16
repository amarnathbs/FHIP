// PO decision 16-10-2026: reached from Create Resource (its parent), not from a sidebar group.
// Resources Bulk Upload -- the shared entry: "What would you like to upload?". Both cards lead to the SAME
// importer; the choice only decides which canonical adapter reads the file.

import Link from 'next/link';

const CARDS: { type: 'article' | 'money_update'; title: string; blurb: string; button: string }[] = [
  { type: 'article', title: 'Articles', blurb: 'Finished articles: quick answer, key takeaways, main content, example and what it means for financial health.', button: 'Upload Articles' },
  { type: 'money_update', title: 'Money Updates', blurb: 'Finished Money Updates: event date, five sections, review or expiry date and official sources.', button: 'Upload Money Updates' },
];

export function BulkUploadChooser() {
  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/admin/resources" className="hover:text-trust hover:underline">
          Resources
        </Link>{' '}
        &gt;{' '}
        <Link href="/admin/resources/content/new" className="hover:text-trust hover:underline">
          Create Resource
        </Link>{' '}
        &gt; <span className="text-ink">Bulk Upload</span>
      </nav>
      <header>
        <h1 className="text-2xl font-semibold text-ink">Bulk Upload Resources</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Create many Resources from one spreadsheet. Every uploaded item becomes a <strong>private draft</strong>: nothing is published, scheduled or approved by uploading. Manual creation in the normal editors stays exactly as it was.
        </p>
      </header>

      <section aria-labelledby="choose-h">
        <h2 id="choose-h" className="text-lg font-semibold text-ink">
          What would you like to upload?
        </h2>
        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
          {CARDS.map((c) => (
            <div key={c.type} className="rounded-card border border-line bg-white p-5">
              <h3 className="text-base font-semibold text-ink">{c.title}</h3>
              <p className="mt-1 text-sm text-muted">{c.blurb}</p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Link href={`/admin/resources/import/upload?type=${c.type}`} className="inline-flex min-h-11 items-center rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90">
                  {c.button}
                </Link>
                <a href={`/api/admin/resources/import/templates?type=${c.type}&format=xlsx`} className="inline-flex min-h-11 items-center text-sm font-semibold text-trust hover:underline">
                  Excel template
                </a>
                <a href={`/api/admin/resources/import/templates?type=${c.type}&format=csv`} className="inline-flex min-h-11 items-center text-sm font-semibold text-trust hover:underline">
                  CSV template
                </a>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
