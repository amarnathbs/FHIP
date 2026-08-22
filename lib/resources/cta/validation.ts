// R1.6 CTA destination safety validation — spec §44-46, §52, §93, §105.
//
// Same platform-URL-parser approach as lib/resources/sources/validation.ts's
// isSafeSourceUrl() and lib/resources/video/youtube.ts, for the identical
// reason: a real URL parse's protocol check cannot be fooled by
// `javascript:alert(1)`, `data:text/html,...`, `\tjavascript:...` or a
// protocol-relative `//evil.example` the way a naive string-prefix check
// could be.

import { FHIP_MODULE_ROUTES } from '@/lib/resources/context/registry';
import type { CtaDestinationType } from './types';

const REGISTRATION_ROUTES = ['/signup', '/login'];

/** Rejects javascript:/data:/vbscript: and any other non-relative-path scheme trick for an "internal" destination (spec §45). */
export function isSafeInternalPath(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith('/')) return false; // no bare "resources/x", no scheme, no protocol-relative
  if (trimmed.startsWith('//')) return false; // protocol-relative URL (browser treats //evil.com as an external absolute URL)
  // Parsing against a fixed dummy origin: if the platform parser resolves a
  // different protocol/host than the dummy one (which a payload like
  // "/x\t:javascript:alert(1)" or embedded control characters could cause),
  // this is not a plain internal path.
  let url: URL;
  try {
    url = new URL(trimmed, 'https://internal.invalid');
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.host === 'internal.invalid';
}

export function isSafeExternalUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  return url.protocol === 'https:'; // spec §46: "only safe https: URLs"
}

export function isSafeYoutubeUrl(raw: string): boolean {
  if (!isSafeExternalUrl(raw)) return false;
  try {
    const host = new URL(raw.trim()).hostname.replace(/^www\./, '');
    return host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com';
  } catch {
    return false;
  }
}

export interface CtaDestinationCheck {
  valid: boolean;
  error?: string;
}

/**
 * The one function every CTA create/update route must call before writing
 * destination_url (spec §52/§93). Each destination_type gets a narrower
 * check than a blanket "not javascript:" — internal_resource must be a real
 * /resources/... path, fhip_module must be on the verified FHIP route
 * allowlist (spec §45: "must use approved FHIP routes"), registration is
 * restricted to /signup or /login, external/youtube require https:.
 */
export function validateCtaDestination(destinationType: CtaDestinationType, destinationUrl: string): CtaDestinationCheck {
  const url = destinationUrl.trim();
  if (!url) return { valid: false, error: 'Enter a destination.' };

  switch (destinationType) {
    case 'internal_resource':
      if (!isSafeInternalPath(url)) return { valid: false, error: 'Internal Resource destinations must be a relative path, e.g. /resources/emergency-fund-guide.' };
      if (!url.startsWith('/resources/')) return { valid: false, error: 'An "Another Resource" CTA must point at a /resources/... path.' };
      return { valid: true };
    case 'fhip_module':
      if (!isSafeInternalPath(url)) return { valid: false, error: 'FHIP Module destinations must be a relative path.' };
      if (!FHIP_MODULE_ROUTES.includes(url)) return { valid: false, error: `"${url}" is not a recognised FHIP module route.` };
      return { valid: true };
    case 'registration':
      if (!isSafeInternalPath(url)) return { valid: false, error: 'Registration destinations must be a relative path.' };
      if (!REGISTRATION_ROUTES.includes(url)) return { valid: false, error: 'Registration CTAs may only point to /signup or /login.' };
      return { valid: true };
    case 'external':
      if (!isSafeExternalUrl(url)) return { valid: false, error: 'Enter a valid https:// URL.' };
      return { valid: true };
    case 'youtube':
      if (!isSafeYoutubeUrl(url)) return { valid: false, error: 'Enter a valid https:// youtube.com or youtu.be URL.' };
      return { valid: true };
    default:
      return { valid: false, error: 'Unknown destination type.' };
  }
}

export interface CtaValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

export function validateCta(patch: { name: string; label: string; destination_type: CtaDestinationType; destination_url: string }): CtaValidationResult {
  const errors: Record<string, string> = {};
  if (!patch.name.trim()) errors.name = 'Enter an internal name.';
  if (!patch.label.trim()) errors.label = 'Enter a public label.'; // spec §52: "Prevent blank label"
  if (patch.label.trim().length > 60) errors.label = 'Keep the label short (60 characters or fewer) — this renders as button text.';
  const destCheck = validateCtaDestination(patch.destination_type, patch.destination_url);
  if (!destCheck.valid) errors.destination_url = destCheck.error ?? 'Invalid destination.';
  return { valid: Object.keys(errors).length === 0, errors };
}
