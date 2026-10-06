import { PageBackLink } from '@/components/navigation/PageBackLink';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AdminBenchmarksClient } from '@/components/admin/AdminBenchmarksClient';

async function AdminBenchmarksPageContent() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: adminRow } = await supabase.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!adminRow) redirect('/dashboard');

  return <AdminBenchmarksClient />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Dashboard).
export default function AdminBenchmarksPage() {
  return (
    <>
      <PageBackLink href="/dashboard" label="Dashboard" />
      <AdminBenchmarksPageContent />
    </>
  );
}
