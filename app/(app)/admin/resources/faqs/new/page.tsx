import { PageBackLink } from '@/components/navigation/PageBackLink';
import { redirect } from 'next/navigation';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageFaqs } from '@/lib/resources/permissions';
import { getResourceCategoriesForFilter } from '@/lib/resources/admin/queries';
import { createClient } from '@/lib/supabase/server';
import { FaqEditor } from '@/components/resources/faq/FaqEditor';

async function NewFaqPageContent() {
  const current = await requireResourceAdminAccess();
  if (!canManageFaqs(current)) redirect('/admin/resources/faqs');
  const supabase = await createClient();
  const categories = await getResourceCategoriesForFilter(supabase);
  return <FaqEditor faq={null} categories={categories} linkedPosts={[]} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (FAQs).
export default function NewFaqPage() {
  return (
    <>
      <PageBackLink href="/admin/resources/faqs" label="FAQs" />
      <NewFaqPageContent />
    </>
  );
}
