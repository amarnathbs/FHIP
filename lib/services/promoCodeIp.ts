// Server-only helper (uses node:crypto) — kept out of promoCodes.ts so client components can import that module safely.

import { createHmac } from 'node:crypto';

/**
 * IP-equivalent for per-network rate limiting: an HMAC of the first
 * X-Forwarded-For hop, so the raw address is never stored. Returns null when no
 * secret is configured (then only the per-user limit applies). The HMAC key is
 * PROMO_IP_HASH_SECRET, falling back to CRON_SECRET.
 */
export function hashClientIp(headers: Pick<Headers, 'get'>, env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.PROMO_IP_HASH_SECRET || env.CRON_SECRET;
  if (!secret) return null;
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip')?.trim() || '';
  if (!forwarded) return null;
  return createHmac('sha256', secret).update(forwarded).digest('hex');
}
