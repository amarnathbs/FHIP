import { PageBackLink } from '@/components/navigation/PageBackLink';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { InvestmentIntelligenceSubNav } from '@/components/investment-intelligence/InvestmentIntelligenceSubNav';
import { ResolutionDetailClient } from '@/components/pc5/ResolutionDetailClient';
import { getUserHomeCountry } from '@/lib/services/jurisdiction';
import { dateFormatKeyForCountry } from '@/lib/engines/date';
import { PC5_RESOLUTIONS_BASE } from '@/lib/pc5/deepLinks';

/**
 * PC5 (M4) — K.14's destination. A deep link from the Review Centre lands
 * HERE, on the one case, with everything needed to decide it — never on a
 * statement list the user would then have to search.
 */
async function ResolutionDetailPageContent({ params }: { params: Promise<{ itemId: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { itemId } = await params;
  // Dates on this page follow the user's own country (dd/mm/yyyy AU, dd-mm-yyyy India).
  const dateCurrency = dateFormatKeyForCountry(await getUserHomeCountry(user.id, supabase));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <Link href={PC5_RESOLUTIONS_BASE} className="text-sm text-brand underline">
          ← All statement questions
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-ink">Answer this question</h1>
      </header>
      <InvestmentIntelligenceSubNav />
      {/* Ownership is proven server-side by the API this component calls —
          the item id in the URL is never treated as proof of access, and a
          cross-user id returns 404 rather than 403 so the route cannot be
          used to discover which items exist. */}
      <ResolutionDetailClient itemId={itemId} dateCurrency={dateCurrency} />
    </div>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (statement questions).
export default function ResolutionDetailPage(props: Parameters<typeof ResolutionDetailPageContent>[0]) {
  return (
    <>
      <PageBackLink href="/investment-intelligence/resolutions" label="statement questions" />
      <ResolutionDetailPageContent {...props} />
    </>
  );
}
