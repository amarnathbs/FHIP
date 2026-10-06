// Shared plumbing for the Planning Benchmarks upload API routes. Every route is thin:
// capability guard FIRST (before the body is read) -> validate -> one service call under the CALLER'S session
// client -> typed response. The service-role client is never imported by any upload route.
import { z } from 'zod';
import { bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { requirePlanningBenchmarkCapability, type PlanningBenchmarkCapability } from './guards';
import { MappingRpcFailure, RpcFailure, UploadDependencyError, rpcFailureResponse } from './uploadService';

export const UuidSchema = z.string().uuid();

export async function guarded(cap: PlanningBenchmarkCapability) {
  const r = await requirePlanningBenchmarkCapability(cap);
  if (r.forbidden || !r.user) return { ok: false as const, response: r.forbidden ?? bad('unauthenticated', 401) };
  return { ok: true as const, user: r.user, flags: r.flags, supabase: await createClient() };
}

export async function idParam(params: Promise<{ id: string }>): Promise<{ ok: true; id: string } | { ok: false; response: Response }> {
  const { id } = await params;
  const p = UuidSchema.safeParse(id);
  return p.success ? { ok: true, id: p.data } : { ok: false, response: bad('Invalid id', 422) };
}

export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: badValidation(parsed.error, 422) };
  return { ok: true, data: parsed.data };
}

/** Runs a service call and turns a failure into an explicit, safe response (never a partial success, never raw database text). */
export async function failClosed<T>(fn: () => Promise<T>, onOk: (v: T) => Response): Promise<Response> {
  try {
    return onOk(await fn());
  } catch (e) {
    if (e instanceof RpcFailure) return rpcFailureResponse(e.error, e instanceof MappingRpcFailure ? 'mapping' : 'upload');
    if (e instanceof UploadDependencyError) {
      return Response.json({ error: 'The upload service returned an unexpected result or is not available. Nothing was changed.', code: 'DEPENDENCY_UNAVAILABLE' }, { status: 503 });
    }
    throw e;
  }
}
