import { bad } from '@/lib/api';
import { guardTemplateDownload } from '@/lib/resources/import/access';
import { buildTemplateCsv, buildTemplateXlsx, templateFileName, type TemplateLookups } from '@/lib/resources/import/template-generator';
import { isImportContentType } from '@/lib/resources/import/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/admin/resources/import/templates?type=article|money_update&format=xlsx|csv
// Four downloads. Headers come from the SAME canonical schema the parser reads (template/parser drift is
// impossible). The XLSX Lookup_Values sheet lists the live categories, tags, authors and CTAs so a person can copy
// exact values; it is reference only and never imported.
export async function GET(request: Request) {
  const g = await guardTemplateDownload();
  if (!g.ok) return g.response;

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type');
  const format = searchParams.get('format');
  if (!isImportContentType(type)) return bad('Choose a type: article or money_update.', 400);
  if (format !== 'xlsx' && format !== 'csv') return bad('Choose a format: xlsx or csv.', 400);

  const fileName = templateFileName(type, format);
  const common = { 'Content-Disposition': `attachment; filename="${fileName}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

  if (format === 'csv') {
    return new Response(buildTemplateCsv(type), { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', ...common } });
  }

  try {
    const [cats, tags, authors, ctas] = await Promise.all([
      g.supabase.from('resource_categories').select('name, slug').eq('is_active', true).order('name').limit(1000),
      g.supabase.from('resource_tags').select('name, slug').eq('is_active', true).order('name').limit(1000),
      g.supabase.from('resource_authors').select('display_name, slug').eq('is_active', true).order('display_name').limit(1000),
      g.supabase.from('resource_ctas').select('name').eq('is_active', true).order('name').limit(1000),
    ]);
    const lookups: TemplateLookups = {
      categories: (cats.data ?? []) as TemplateLookups['categories'],
      tags: (tags.data ?? []) as TemplateLookups['tags'],
      authors: (authors.data ?? []) as TemplateLookups['authors'],
      ctas: (ctas.data ?? []) as TemplateLookups['ctas'],
    };
    const bytes = await buildTemplateXlsx(type, lookups);
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ...common },
    });
  } catch (err) {
    console.error('Resources import template error:', err);
    return bad('Could not build the template.', 500);
  }
}
