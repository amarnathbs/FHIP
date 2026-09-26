/**
 * WP-15 (a) -- "Update your planned expenses from your actual spending".
 *
 *   GET                         preview only (writes nothing)
 *   POST { action: 'generate' } persists inert proposals, one per planned item
 *                               that would change; returns them with ids
 *   POST { action: 'apply', decisions: [{ proposalId, decision }] }
 *                               applies the ticked items as ONE all-or-nothing
 *                               batch through fdh15_apply_expense_proposals
 *
 * Nothing is copied transaction-by-transaction: a proposal is one monthly
 * average per planned item (expense_items), and only the user's Apply writes.
 */
import { z } from 'zod';
import { bad, ok } from '@/lib/api';
import { requireModuleCapability } from '@/lib/services/appCapability';
import { createClient } from '@/lib/supabase/server';
import {
  applyExpenseProposals,
  generateExpenseProposals,
  previewExpensePopulation,
  type PopulationClient,
} from '@/lib/import-bridge/populationProposalService';
import { toPlannedFromActualsDto } from '@/lib/import-bridge/populationProposalDto';
import { USER_APPLY_DECISIONS } from '@/lib/import-bridge/types';

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('generate') }),
  z.object({
    action: z.literal('apply'),
    decisions: z
      .array(z.object({ proposalId: z.string().uuid(), decision: z.enum(USER_APPLY_DECISIONS), selectedFields: z.array(z.string()).max(20).optional() }))
      .min(1)
      .max(200),
  }),
]);

export async function GET(request: Request) {
  const { user, blocked } = await requireModuleCapability('EXPENSES', request);
  if (!user) return blocked!;
  const client = (await createClient()) as unknown as PopulationClient;
  const preview = await previewExpensePopulation(user.id, client);
  return ok(preview.status === 'ok' ? toPlannedFromActualsDto(preview, {}) : { status: 'unavailable', reason: preview.reason });
}

export async function POST(request: Request) {
  const { user, blocked } = await requireModuleCapability('EXPENSES', request);
  if (!user) return blocked!;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bad('The request was not understood.', 422);
  const client = (await createClient()) as unknown as PopulationClient;

  if (parsed.data.action === 'generate') {
    const generated = await generateExpenseProposals(user.id, client);
    if (generated.status !== 'ok') return ok({ status: 'unavailable', reason: generated.reason });
    return ok(toPlannedFromActualsDto(generated, generated.proposalIds));
  }

  const outcome = await applyExpenseProposals(client, parsed.data.decisions);
  if (!outcome.ok) {
    const status = outcome.code === 'STALE_PROPOSAL' || outcome.code === 'ALREADY_APPLIED' ? 409 : outcome.code === 'WRITE_FAILED' ? 500 : 422;
    return Response.json({ error: outcome.error, code: outcome.code, proposalId: outcome.proposalId ?? null, rolledBack: outcome.rolledBack ?? false }, { status });
  }
  return ok(outcome);
}
