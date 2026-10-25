import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { switchSmsfRecordingMode } from '@/lib/services/smsfData';
import { smsfRpcError } from '@/lib/services/smsfErrors';
import { smsfSwitchModeSchema } from '@/lib/validation/smsf';

// Itemised OR net value only (migration 0290). PREVIEW-FIRST: with `confirm` false (the default) NOTHING changes and the response
// is { status: 'preview', net_before, net_after, variance, ... }; with `confirm` true the new representation is applied and the old
// one retired in one transaction, with a history row. The database enforces the rule; a client that skips this route is refused.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = smsfSwitchModeSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  const supabase = await createClient();
  const { data, error } = await switchSmsfRecordingMode(id, parsed.data, supabase);
  if (error) {
    const e = smsfRpcError(error);
    return bad(e.message, e.status, e.errorCode);
  }
  return ok(data);
}
