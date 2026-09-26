/**
 * WP-15 (b) -- "Add your bank balance to Assets" (PO D-04).
 *
 *   GET                                  preview per bank account (writes nothing)
 *   POST { action: 'generate', accountId, targetAssetId? }
 *                                        persists the inert proposal for ONE
 *                                        account (targetAssetId = "this is my
 *                                        existing <asset>": update it instead)
 *   POST { action: 'apply', proposalId, decision }
 *                                        fdh15_apply_asset_proposal: re-derives
 *                                        the balance from the approved
 *                                        statement; one asset per account
 *
 * Until applied a closing balance is evidence only ("Bank balance per
 * statement -- not in Net Worth") and is never added to any total.
 */
import { z } from 'zod';
import { bad, ok } from '@/lib/api';
import { requireModuleCapability } from '@/lib/services/appCapability';
import { createClient } from '@/lib/supabase/server';
import {
  applyBankBalanceProposal,
  generateBankBalanceProposal,
  previewBankBalances,
  type PopulationClient,
} from '@/lib/import-bridge/populationProposalService';
import { toBankBalanceItemDto, type BankBalancesResponse } from '@/lib/import-bridge/populationProposalDto';
import { USER_APPLY_DECISIONS } from '@/lib/import-bridge/types';

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('generate'), accountId: z.string().uuid(), targetAssetId: z.string().uuid().nullable().optional() }),
  z.object({ action: z.literal('apply'), proposalId: z.string().uuid(), decision: z.enum(USER_APPLY_DECISIONS) }),
]);

export async function GET(request: Request) {
  const { user, blocked } = await requireModuleCapability('ASSETS', request);
  if (!user) return blocked!;
  const client = (await createClient()) as unknown as PopulationClient;
  const preview = await previewBankBalances(user.id, client);
  const body: BankBalancesResponse = preview.status === 'ok'
    ? { status: 'ok', reportingCurrency: preview.reportingCurrency, items: preview.items.map((i) => toBankBalanceItemDto(i)) }
    : { status: 'unavailable', reason: preview.reason };
  return ok(body);
}

export async function POST(request: Request) {
  const { user, blocked } = await requireModuleCapability('ASSETS', request);
  if (!user) return blocked!;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bad('The request was not understood.', 422);
  const client = (await createClient()) as unknown as PopulationClient;

  if (parsed.data.action === 'generate') {
    const generated = await generateBankBalanceProposal(user.id, client, parsed.data.accountId, parsed.data.targetAssetId ?? null);
    if (generated.status !== 'ok') return ok({ status: 'unavailable', reason: generated.reason });
    return ok({ status: 'ok', item: toBankBalanceItemDto(generated.item, generated.proposalId) });
  }

  const outcome = await applyBankBalanceProposal(client, { proposalId: parsed.data.proposalId, decision: parsed.data.decision });
  if (!outcome.ok) {
    const status = outcome.code === 'STALE_PROPOSAL' || outcome.code === 'ALREADY_APPLIED' ? 409 : outcome.code === 'WRITE_FAILED' ? 500 : 422;
    return Response.json({ error: outcome.error, code: outcome.code }, { status });
  }
  return ok(outcome);
}
