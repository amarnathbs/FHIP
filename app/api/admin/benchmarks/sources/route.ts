import { requireAdmin, adminClient } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

export async function GET() {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const { data, error } = await adminClient().from('benchmark_sources').select('*').order('created_at', { ascending: false });
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request) {
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));
  if (!body.source_name || !body.source_type || !body.publisher || !body.source_title || !body.citation_text) {
    return bad('source_name, source_type, publisher, source_title and citation_text are required', 422);
  }
  const { data, error } = await adminClient()
    .from('benchmark_sources')
    .insert({ ...body, status: 'draft', created_by: user!.id })
    .select('*')
    .single();
  return error ? bad(error.message) : ok(data);
}
