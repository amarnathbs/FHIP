import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import {
  createEntityExpense,
  createEntityIncome,
  entityCashFlowError,
  listEntityExpenses,
  listEntityIncome,
  resolveEntityScope,
  retireEntityExpense,
  retireEntityIncome,
  updateEntityExpense,
  updateEntityIncome,
} from '@/lib/services/entityCashFlowData';
import { entityExpenseSchema, entityExpenseUpdateSchema, entityIncomeSchema, entityIncomeUpdateSchema } from '@/lib/validation/entityCashFlow';

// The route handlers for entity-level income and expenses, shared by the SMSF routes (/api/smsf/[id]/...) and the Company / Family Trust / HUF
// routes (/api/business-entities/[id]/...). One behaviour in two places would drift, so there is one implementation. Every handler resolves the
// entity as the caller's own FIRST: an entity of another household answers 404, exactly like one that does not exist (non-enumerating).

type Kind = 'smsf' | 'business';
type Ctx = { params: Promise<{ id: string; itemId?: string }> };

async function start(kind: Kind, ctx: Ctx) {
  const { id, itemId } = await ctx.params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return { denied: unauthenticated! } as const;
  const supabase = await createClient();
  const scope = await resolveEntityScope(kind, id, user.id, supabase);
  if (!scope) return { denied: bad('Not found', 404) } as const;
  return { user, supabase, scope, itemId } as const;
}

function fail(error: { message: string; code?: string | null }) {
  const e = entityCashFlowError(error);
  return bad(e.message, e.status, e.errorCode);
}

export function entityIncomeHandlers(kind: Kind) {
  return {
    async GET(_req: Request, ctx: Ctx) {
      const s = await start(kind, ctx);
      if ('denied' in s) return s.denied;
      const { data, error } = await listEntityIncome(s.scope, s.user.id, s.supabase);
      return error ? fail(error) : ok(data);
    },
    async POST(req: Request, ctx: Ctx) {
      const s = await start(kind, ctx);
      if ('denied' in s) return s.denied;
      const parsed = entityIncomeSchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return badValidation(parsed.error, 422);
      const { data, error } = await createEntityIncome(s.scope, s.user.id, parsed.data, s.supabase);
      return error ? fail(error) : ok(data);
    },
    async PATCH(req: Request, ctx: Ctx) {
      const s = await start(kind, ctx);
      if ('denied' in s) return s.denied;
      const parsed = entityIncomeUpdateSchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return badValidation(parsed.error, 422);
      if (parsed.data.income_type === 'rent' && parsed.data.amount !== undefined && !(parsed.data.amount > 0)) {
        return bad('Enter the rent amount and how often it is paid.', 422, 'ENTITY_RENT_NEEDS_AMOUNT');
      }
      const { data, error } = await updateEntityIncome(s.scope, s.itemId!, s.user.id, parsed.data, s.supabase);
      return error ? fail(error) : ok(data);
    },
    async DELETE(_req: Request, ctx: Ctx) {
      const s = await start(kind, ctx);
      if ('denied' in s) return s.denied;
      const { error } = await retireEntityIncome(s.scope, s.itemId!, s.user.id, s.supabase);
      return error ? fail(error) : ok({ archived: true });
    },
  };
}

export function entityExpenseHandlers(kind: Kind) {
  return {
    async GET(_req: Request, ctx: Ctx) {
      const s = await start(kind, ctx);
      if ('denied' in s) return s.denied;
      const { data, error } = await listEntityExpenses(s.scope, s.user.id, s.supabase);
      return error ? fail(error) : ok(data);
    },
    async POST(req: Request, ctx: Ctx) {
      const s = await start(kind, ctx);
      if ('denied' in s) return s.denied;
      const parsed = entityExpenseSchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return badValidation(parsed.error, 422);
      const { data, error } = await createEntityExpense(s.scope, s.user.id, parsed.data, s.supabase);
      return error ? fail(error) : ok(data);
    },
    async PATCH(req: Request, ctx: Ctx) {
      const s = await start(kind, ctx);
      if ('denied' in s) return s.denied;
      const parsed = entityExpenseUpdateSchema.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return badValidation(parsed.error, 422);
      const { data, error } = await updateEntityExpense(s.scope, s.itemId!, s.user.id, parsed.data, s.supabase);
      return error ? fail(error) : ok(data);
    },
    async DELETE(_req: Request, ctx: Ctx) {
      const s = await start(kind, ctx);
      if ('denied' in s) return s.denied;
      const { error } = await retireEntityExpense(s.scope, s.itemId!, s.user.id, s.supabase);
      return error ? fail(error) : ok({ archived: true });
    },
  };
}

/** A database refusal of an entity write as a coded response: ENTITY_BOTH_REPRESENTATIONS and friends keep their code, plain wording, never raw SQL. */
export function entityErrorResponse(error: { message: string; code?: string | null }) {
  return fail(error);
}
