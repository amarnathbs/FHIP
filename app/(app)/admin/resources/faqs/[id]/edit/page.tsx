import { PageBackLink } from '@/components/navigation/PageBackLink';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { getFaqById, getFaqLinkedPosts } from '@/lib/resources/faq/queries';
import { getResourceCategoriesForFilter } from '@/lib/resources/admin/queries';
import { FaqEditor } from '@/components/resources/faq/FaqEditor';

async function FaqEditPageContent({ params }: { params: Promise<{ id: string }> }) {
  await requireResourceAdminAccess();
  const { id } = await params;
  const supabase = await createClient();

  const faq = await getFaqById(supabase, id);
  if (!faq) notFound();

  const [categories, linkedPosts] = await Promise.all([getResourceCategoriesForFilter(supabase), getFaqLinkedPosts(supabase, id)]);

  return <FaqEditor faq={faq} categories={categories} linkedPosts={linkedPosts} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (FAQs).
export default function FaqEditPage(props: Parameters<typeof FaqEditPageContent>[0]) {
  return (
    <>
      <PageBackLink href="/admin/resources/faqs" label="FAQs" />
      <FaqEditPageContent {...props} />
    </>
  );
}
