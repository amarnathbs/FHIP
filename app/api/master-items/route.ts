import { ok, bad } from '@/lib/api';
import { listMasterItems, type MasterItemCategory } from '@/lib/services/masterItems';

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
  const category = new URL(req.url).searchParams.get('category') as MasterItemCategory | null;
  if (!category || !VALID_CATEGORIES.includes(category)) return bad('invalid category', 422);
  const { data, error } = await listMasterItems(category);
  return error ? bad(error.message) : ok(data);
}
