import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AdminBenchmarksClient } from '@/components/admin/AdminBenchmarksClient';

export default async function AdminBenchmarksPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: adminRow } = await supabase.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!adminRow) redirect('/dashboard');

  return <AdminBenchmarksClient />;
}
