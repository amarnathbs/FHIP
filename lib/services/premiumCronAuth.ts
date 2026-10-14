// Server-only. The scheduled routes authenticate with the shared CRON_SECRET in the x-cron-secret header. This compares in
// constant time and only ever against the dedicated secret (no fallback to another variable).

import { timingSafeEqual } from 'node:crypto';
import { readPromoSecret } from '@/lib/services/promoSecrets';

export function cronSecretMatches(header: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const expected = readPromoSecret('cron', env);
  if (!expected || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
