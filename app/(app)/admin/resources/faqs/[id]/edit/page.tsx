import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { getFaqById, getFaqLinkedPosts } from '@/lib/resources/faq/queries';
import { getResourceCategoriesForFilter } from '@/lib/resources/admin/queries';
import { FaqEditor } from '@/components/resources/faq/FaqEditor';

export default async function FaqEditPage({ params }: { params: Promise<{ id: string }> }) {
  await requireResourceAdminAccess();
  const { id } = await params;
  const supabase = await createClient();

  const faq = await getFaqById(supabase, id);
  if (!faq) notFound();

  const [categories, linkedPosts] = await Promise.all([getResourceCategoriesForFilter(supabase), getFaqLinkedPosts(supabase, id)]);

  return <FaqEditor faq={faq} categories={categories} linkedPosts={linkedPosts} />;
}
