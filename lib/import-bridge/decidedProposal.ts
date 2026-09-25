/**
 * "Apply exactly once" for a statement (2026-09-25).
 *
 * A byte-identical re-upload now leads the user back to the ORIGINAL statement
 * (the FDH identical-upload rule, identicalUpload.ts). If that statement's
 * comparison was already applied (or dismissed with "keep my existing"),
 * generating a fresh proposal would offer the same statement for a second
 * canonical write -- and "Add as new" would create a second copy of the
 * account. The proposal routes ask this first and answer with the decision
 * already made instead.
 */

import { createClient } from '@/lib/supabase/server';

export type ProposalSourceColumn = 'source_liability_statement_id' | 'source_retirement_statement_id';

export interface DecidedProposal {
  proposalId: string;
  status: 'applied' | 'dismissed';
  decidedAt: string | null;
}

export async function findDecidedProposalForStatement(
  userId: string,
  sourceColumn: ProposalSourceColumn,
  statementId: string,
): Promise<DecidedProposal | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fhip_import_proposals')
    .select('id, status, applied_at, dismissed_at')
    .eq('user_id', userId)
    .eq(sourceColumn, statementId)
    .in('status', ['applied', 'dismissed'])
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as { id: string; status: 'applied' | 'dismissed'; applied_at: string | null; dismissed_at: string | null } | null;
  if (!row) return null;
  return { proposalId: row.id, status: row.status, decidedAt: row.applied_at ?? row.dismissed_at };
}

/** The 409 body both proposal routes answer with. */
export function alreadyDecidedResponse(decided: DecidedProposal, noun: string): Response {
  return Response.json(
    {
      error: 'already_decided',
      message:
        decided.status === 'applied'
          ? `This statement has already been added to your ${noun}.`
          : `You already chose to keep your existing ${noun} for this statement.`,
      outcome: decided.status === 'applied' ? 'applied' : 'kept_existing',
      proposal_id: decided.proposalId,
    },
    { status: 409 },
  );
}
