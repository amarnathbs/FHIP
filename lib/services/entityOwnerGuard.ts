import { ENTITY_OWNER_TAGS } from '@/lib/engines/netWorthBasis';
import { bad } from '@/lib/api';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * PERSONAL REGISTERS ARE NEVER A ROUTE INTO AN ENTITY (PO review 20-10-2026, F21 / F22 / F23; entity design section 7.3, decision D6).
 * A debt, an income or an expense of an SMSF, family trust, HUF or company is entered on the ENTITY (Retirement > SMSF, or Companies & Trusts),
 * where it is scoped to that entity, kept out of personal totals and out of personal DTI / DSR. The personal Liabilities, Income and Expenses
 * registers therefore refuse an entity owner on a NEW row, and refuse CHANGING an existing row's owner TO an entity owner.
 *
 * An existing row that already carries an entity owner stays readable and editable in its other fields (its owner is unchanged, so nothing is
 * refused); the entity screens offer "Move into the fund" for it. This is the server half: the grid hides the same values from new selection.
 */
export const ENTITY_OWNER_REFUSED_CODE = 'ENTITY_OWNER_USE_ENTITIES';

export type EntityOwnerRegister = 'liabilities' | 'income' | 'expenses';

const WHAT: Record<EntityOwnerRegister, string> = {
  liabilities: 'Debts',
  income: 'Income',
  expenses: 'Expenses',
};

/** The plain-language refusal (what happened, why, what to do instead). */
export function entityOwnerRefusalMessage(register: EntityOwnerRegister): string {
  return `${WHAT[register]} of your SMSF, trust, HUF or company are not entered here, because this page is your personal finances. Enter them on the entity itself (Investment & Retirement > SMSF, or Companies & Trusts) so they are kept separate and never counted twice.`;
}

/** True when `nextOwner` is an entity owner that this write would newly introduce (a new row, or a change of owner TO an entity value). */
export function introducesEntityOwner(nextOwner: string | null | undefined, currentOwner?: string | null): boolean {
  if (nextOwner === null || nextOwner === undefined) return false;
  if (!ENTITY_OWNER_TAGS.has(nextOwner)) return false;
  return nextOwner !== currentOwner;
}

/** A coded 422 Response when the write would route an entity's money into a personal register, else null. */
export function entityOwnerRefusal(register: EntityOwnerRegister, nextOwner: string | null | undefined, currentOwner?: string | null): Response | null {
  return introducesEntityOwner(nextOwner, currentOwner) ? bad(entityOwnerRefusalMessage(register), 422, ENTITY_OWNER_REFUSED_CODE) : null;
}

/**
 * The owner an existing row already has under a catalogue item. The grid saves a catalogue row by POST (an upsert on user and master item key),
 * including an ordinary edit of a row the household already owns, so a POST for an existing entity-tagged row must not be refused: its owner is
 * unchanged. Null when there is no such row (a genuinely new row).
 */
export async function existingOwnerForMasterItem(
  supabase: SupabaseClient,
  table: 'liabilities' | 'income_sources' | 'expense_items',
  userId: string,
  masterItemKey: string | null | undefined,
): Promise<string | null> {
  if (!masterItemKey) return null;
  const { data } = await supabase.from(table).select('owner').eq('user_id', userId).eq('master_item_key', masterItemKey).maybeSingle();
  return (data as { owner?: string | null } | null)?.owner ?? null;
}

/**
 * The POST-side check: the database is only asked about an existing row when the request actually carries an entity owner, so an ordinary save
 * (the overwhelming majority) costs nothing extra.
 */
export async function refuseEntityOwnerOnSave(
  register: EntityOwnerRegister,
  nextOwner: string | null | undefined,
  lookupCurrentOwner: () => Promise<string | null>,
): Promise<Response | null> {
  if (!introducesEntityOwner(nextOwner)) return null;
  return entityOwnerRefusal(register, nextOwner, await lookupCurrentOwner());
}
