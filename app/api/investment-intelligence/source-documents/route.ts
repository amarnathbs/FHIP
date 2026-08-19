import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { iiSourceDocumentUploadMetaSchema } from '@/lib/validation/investment-intelligence';
import { validateUploadedFile, generateObjectKey, uploadSourceDocumentObject } from '@/lib/services/investment-intelligence/storage';
import { createHash } from 'crypto';

// Real upload path: multipart form-data with a "file" part and a "meta"
// JSON part. Service-role storage write happens only AFTER an
// authenticated, RLS-checked request has been validated here — never a
// direct client-to-bucket upload (spec section 14).
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('ii_source_documents')
    .select('id, status, original_filename, document_type, uploaded_at, checksum, country_code')
    .eq('user_id', user.id)
    .order('uploaded_at', { ascending: false });
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const form = await req.formData().catch(() => null);
  if (!form) return bad('Expected multipart/form-data with "file" and "meta" fields', 422);

  const file = form.get('file');
  const metaRaw = form.get('meta');
  if (!(file instanceof File)) return bad('Missing file', 422);
  if (typeof metaRaw !== 'string') return bad('Missing meta', 422);

  let meta: unknown;
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    return bad('Invalid meta JSON', 422);
  }
  const parsedMeta = iiSourceDocumentUploadMetaSchema.safeParse(meta);
  if (!parsedMeta.success) return bad(parsedMeta.error.message, 422);

  const validation = validateUploadedFile({ filename: file.name, mimeType: file.type, sizeBytes: file.size });
  if (!validation.ok) return bad(validation.error!, 422);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const checksum = createHash('sha256').update(bytes).digest('hex');

  const supabase = await createClient();

  // Re-upload detection (unique(user_id, checksum) where checksum is not
  // null) — deterministic, explainable behaviour for the identical file
  // uploaded twice (spec section 31).
  const { data: existing } = await supabase.from('ii_source_documents').select('id, status').eq('user_id', user.id).eq('checksum', checksum).maybeSingle();
  if (existing) return ok({ ...existing, deduplicated: true });

  const objectKey = generateObjectKey(user.id, file.name);
  const { error: uploadErr } = await uploadSourceDocumentObject(objectKey, bytes, file.type);
  if (uploadErr) return bad(`Storage upload failed: ${uploadErr}`, 500);

  // Resolve source_id from source_key (reference lookup, not a write).
  let sourceId: string | null = null;
  {
    const { data: sourceRow } = await supabase.from('ii_sources').select('id').eq('source_key', 'manual').maybeSingle();
    sourceId = (sourceRow?.id as string) ?? null;
  }

  const { data: doc, error: insertErr } = await supabase
    .from('ii_source_documents')
    .insert({
      user_id: user.id,
      owner_member_id: parsedMeta.data.ownerMemberId ?? null,
      country_code: parsedMeta.data.countryCode,
      source_id: sourceId,
      status: 'uploaded',
      checksum,
      storage_path: objectKey,
      original_filename: file.name,
      mime_type: file.type,
      file_size: file.size,
      document_type: parsedMeta.data.documentType,
      statement_period_start: parsedMeta.data.statementPeriodStart ?? null,
      statement_period_end: parsedMeta.data.statementPeriodEnd ?? null,
      statement_as_of_date: parsedMeta.data.statementAsOfDate ?? null,
    })
    .select()
    .single();
  if (insertErr || !doc) return bad(insertErr?.message ?? 'Could not record uploaded document', 500);

  await emitAuditEvent({
    userId: user.id,
    eventType: 'upload',
    subjectType: 'ii_source_documents',
    subjectId: doc.id as string,
    actorType: 'user',
    actorId: user.id,
    metadata: { sourceDocumentId: doc.id, originalFilename: file.name, fileSize: file.size },
  });

  return ok(doc);
}
