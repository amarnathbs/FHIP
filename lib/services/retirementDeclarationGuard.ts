import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * PO-D24-02 (Product Owner, 21-10-2026): the server-side invariant behind "I don't have any retirement savings".
 *
 * The declaration cannot be SAVED as true while the person holds an active personal retirement account or an active SMSF. The grid
 * already disables the tick (Document2 (4) F17), but a UI guard alone is not an invariant: a direct call to the profile or section-status API
 * would still write the contradiction. This module is the one rule, used by BOTH canonical write paths:
 *   - PUT /api/user/profile                (user_profiles.not_applicable_retirement = true)
 *   - PUT /api/user/section-status         (section retirement, status not_applicable)
 * and mirrored in the database by migration 0298 (a trigger that refuses the same transition for any other writer, a direct REST call included).
 *
 * What counts as a blocker:
 *   - every ACTIVE retirement_accounts row of the person (is_active is not false), except the SMSF fund's own mirror row (master_item_key smsf),
 *     which is counted once, as the SMSF below;
 *   - every ACTIVE SMSF fund of the person (smsf_funds.is_active is not false), whatever its mode: its value (the derived Detailed net, or the
 *     approved Summary figure) is part of the person's retirement picture, so it contradicts "no retirement savings" exactly as an account does.
 * An inactive account or fund is ignored: the person removed it, so the declaration is true again.
 *
 * Clearing the declaration (false / null) is never refused.
 */
export const RETIREMENT_DECLARATION_CONFLICT_CODE = 'RETIREMENT_DECLARATION_CONFLICT';

export interface RetirementDeclarationBlockers {
  activeAccounts: number;
  activeSmsfFunds: number;
  total: number;
}

type Row = Record<string, unknown>;

/** Counts what contradicts the declaration, reading only the caller's own rows (RLS scopes the request client; the user_id filter is explicit as well). */
export async function loadRetirementDeclarationBlockers(client: SupabaseClient, userId: string): Promise<RetirementDeclarationBlockers> {
  const [accounts, funds] = await Promise.all([
    client.from('retirement_accounts').select('id, master_item_key, is_active').eq('user_id', userId),
    client.from('smsf_funds').select('id, is_active').eq('user_id', userId),
  ]);
  if (accounts.error) throw new Error(accounts.error.message);
  if (funds.error) throw new Error(funds.error.message);
  const activeAccounts = ((accounts.data as Row[] | null) ?? []).filter((r) => r.is_active !== false && r.master_item_key !== 'smsf').length;
  const activeSmsfFunds = ((funds.data as Row[] | null) ?? []).filter((r) => r.is_active !== false).length;
  return { activeAccounts, activeSmsfFunds, total: activeAccounts + activeSmsfFunds };
}

/** What happened, why, and how to fix it, in plain words. */
export function retirementDeclarationRefusalMessage(blockers: RetirementDeclarationBlockers): string {
  const parts: string[] = [];
  if (blockers.activeAccounts > 0) parts.push(`${blockers.activeAccounts} active retirement account${blockers.activeAccounts === 1 ? '' : 's'}`);
  if (blockers.activeSmsfFunds > 0) parts.push(blockers.activeSmsfFunds === 1 ? 'an active SMSF' : `${blockers.activeSmsfFunds} active SMSFs`);
  const held = parts.join(' and ');
  return `This was not saved. You have ${held}, so "I don't have any retirement savings" would contradict what you have entered, and your retirement figures would be counted while you say you have none. Remove or deactivate ${blockers.total === 1 ? 'it' : 'them'} first (Investment & Retirement > Retirement), then confirm you have none.`;
}

/** The 409 the two routes return. `error` carries the readable text because the grid shows it as is. */
export function retirementDeclarationConflictResponse(blockers: RetirementDeclarationBlockers): Response {
  const message = retirementDeclarationRefusalMessage(blockers);
  return Response.json({ error: message, message, code: RETIREMENT_DECLARATION_CONFLICT_CODE, blockers }, { status: 409 });
}

/** The Response to send when the declaration conflicts with what is held, otherwise null. Reads the caller's rows. */
export async function refuseRetirementDeclarationIfConflicting(client: SupabaseClient, userId: string): Promise<Response | null> {
  const blockers = await loadRetirementDeclarationBlockers(client, userId);
  return blockers.total > 0 ? retirementDeclarationConflictResponse(blockers) : null;
}

/** True when a database error is the 0298 trigger refusing the same transition (the route then answers with the same readable 409). */
export function isRetirementDeclarationDbRefusal(error: { message?: string } | null | undefined): boolean {
  return Boolean(error?.message && error.message.includes(RETIREMENT_DECLARATION_CONFLICT_CODE));
}
