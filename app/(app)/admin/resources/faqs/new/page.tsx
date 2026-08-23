import { redirect } from 'next/navigation';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageFaqs } from '@/lib/resources/permissions';
import { getResourceCategoriesForFilter } from '@/lib/resources/admin/queries';
import { createClient } from '@/lib/supabase/server';
import { FaqEditor } from '@/components/resources/faq/FaqEditor';

export default async function NewFaqPage() {
  const current = await requireResourceAdminAccess();
  if (!canManageFaqs(current)) redirect('/admin/resources/faqs');
  const supabase = await createClient();
  const categories = await getResourceCategoriesForFilter(supabase);
  return <FaqEditor faq={null} categories={categories} linkedPosts={[]} />;
}
