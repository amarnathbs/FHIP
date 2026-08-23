import { ok, bad } from '@/lib/api';
import { listMasterItems, listMasterItemsIncludingInactive, type MasterItemCategory } from '@/lib/services/masterItems';

const VALID_CATEGORIES: MasterItemCategory[] = [
  'income',
  'expense',
  'asset',
  'liability',
  'investment',
  'retirement',
  'insurance',
];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const category = url.searchParams.get('category') as MasterItemCategory | null;
  if (!category || !VALID_CATEGORIES.includes(category)) return bad('invalid category', 422);
  // Chunk 3b prerequisite fix: FinancialDataGrid.tsx needs to resolve a
  // deprecated catalogue item's item_label for an orphaned saved row —
  // includeInactive=true opts into the unfiltered read. Default behaviour
  // (active-only) is unchanged for every other/existing caller.
  const includeInactive = url.searchParams.get('includeInactive') === 'true';
  const { data, error } = includeInactive ? await listMasterItemsIncludingInactive(category) : await listMasterItems(category);
  return error ? bad(error.message) : ok(data);
}
