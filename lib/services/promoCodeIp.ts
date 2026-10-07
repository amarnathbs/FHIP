// Server-only helper (uses node:crypto) — kept out of promoCodes.ts so client components can import that module safely.
//
// CLIENT NETWORK ADDRESS FOR THE REDEMPTION RATE LIMIT (hardening 0264 item 6)
//
// THE PROBLEM. The earlier code keyed the per-network limit on the FIRST X-Forwarded-For hop. That hop is whatever
// the CLIENT sent: a caller who writes "X-Forwarded-For: <random>" gets a fresh bucket per request and the
// per-network limit is gone.
//
// THE CONTRACT WE ASSUME (UNVERIFIED, mark in the report): the app is served by AWS Amplify Hosting, which sits
// behind CloudFront. CloudFront APPENDS the address it saw on the TCP connection to the X-Forwarded-For value it
// received, so the LEFT side of the list is untrusted (the client chose it) and the RIGHT side is written by
// infrastructure we trust. The address of the real client is therefore counted FROM THE RIGHT: with N trusted hops
// (PROMO_TRUSTED_PROXY_HOPS, default 1) it is entry number N from the end. Whether Amplify adds a second internal
// hop (which would make N = 2) CANNOT be proven from this repository (there is no deployed header capture in it).
// The DEV proof script (scripts/promo_xff_contract_probe.md) shows how to prove it with real requests.
//
// WHAT HAPPENS WHEN WE ARE NOT SURE. The result is null ("no trustworthy network address"), and the redemption
// function then applies only the PER-USER limit, which is authoritative and cannot be forged (the user comes from the
// verified session). A null is returned when: no secret is set (the feature refuses earlier), the header is absent,
// shorter than the trusted hop count, malformed, or the chosen entry is not a public routable address (a wrong hop
// count would otherwise put every user in the same private-address bucket and lock everyone out together).
//
// The raw address is never stored: only a keyed hash (PROMO_IP_HASH_SECRET, no fallback).

import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { readPromoSecret } from '@/lib/services/promoSecrets';

type Env = Record<string, string | undefined>;

export const DEFAULT_TRUSTED_PROXY_HOPS = 1;
export const MAX_TRUSTED_PROXY_HOPS = 5;

export function trustedProxyHops(env: Env = process.env): number | null {
  const raw = (env.PROMO_TRUSTED_PROXY_HOPS ?? '').trim();
  if (raw === '') return DEFAULT_TRUSTED_PROXY_HOPS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_TRUSTED_PROXY_HOPS ? n : null; // invalid setting: no trustworthy address
}

/** Removes an IPv4 port or IPv6 brackets and port. Returns null for anything that is not an IP literal. */
function cleanIp(entry: string): string | null {
  let v = entry.trim();
  const bracket = /^\[([0-9a-fA-F:.]+)\](?::\d{1,5})?$/.exec(v);
  if (bracket) v = bracket[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(v)) v = v.slice(0, v.lastIndexOf(':'));
  const kind = isIP(v);
  return kind === 0 ? null : v.toLowerCase();
}

/** True for loopback, private, link-local, unspecified, CGNAT, documentation-free ranges that cannot be a public client. */
export function isNonPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return isIP(v.slice(7)) === 4 ? isNonPublicAddress(v.slice(7)) : true;
  return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/**
 * The client address chosen from the RIGHT of X-Forwarded-For (see the header), or null when it cannot be trusted.
 * Never reads X-Real-IP or any other header a client can set.
 */
export function clientIpFromHeaders(headers: Pick<Headers, 'get'>, env: Env = process.env): string | null {
  const hops = trustedProxyHops(env);
  if (hops === null) return null;
  const raw = headers.get('x-forwarded-for');
  if (!raw) return null;
  const entries = raw.split(',').map((e) => e.trim()).filter((e) => e !== '');
  if (entries.length < hops) return null;
  const ip = cleanIp(entries[entries.length - hops]);
  if (!ip || isNonPublicAddress(ip)) return null;
  return ip;
}

/** Keyed hash of the trusted client address, or null (then only the per-user limit applies). */
export function hashClientIp(headers: Pick<Headers, 'get'>, env: Env = process.env): string | null {
  const secret = readPromoSecret('ip', env);
  if (!secret) return null;
  const ip = clientIpFromHeaders(headers, env);
  if (!ip) return null;
  return createHmac('sha256', secret).update(`promo-ip:${ip}`).digest('hex');
}
