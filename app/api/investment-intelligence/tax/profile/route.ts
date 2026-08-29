import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { loadTaxProfile, saveTaxProfile } from '@/lib/services/investment-intelligence/taxRepository';

// Investment Intelligence R6-FINAL — explicit tax-profile GET/PUT
// (spec Sections 20-23).
//
// EXPLICIT-ONLY: taxpayerType/taxResidencyStatus are set ONLY by a
// deliberate PUT from the user. Nothing here infers residency from any
// other field (nationality, address, portfolio country, household
// currency). See lib/engines/investment-intelligence/tax/taxProfile.ts's
// header for the full rationale.
//
// GRACEFUL DEGRADATION: migration 0060 (ii_tax_profiles) is not yet applied
// to every environment — GET returns `{ profile: null, persistenceAvailable
// : false }` rather than a 500 when the table is missing; PUT returns an
// explicit 503 with a clear message rather than silently no-op'ing.

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { profile, available } = await loadTaxProfile(supabase, user.id);
  return ok({ profile, persistenceAvailable: available });
}

const VALID_TAXPAYER_TYPES = new Set(['RESIDENT_INDIVIDUAL', 'RESIDENT_HUF', 'NON_RESIDENT_INDIVIDUAL']);

export async function PUT(request: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  let body: { taxpayerType?: string; taxYear?: string | null };
  try {
    body = await request.json();
  } catch {
    return bad('Invalid JSON body.');
  }

  if (!body.taxpayerType || !VALID_TAXPAYER_TYPES.has(body.taxpayerType)) {
    return bad('taxpayerType is required and must be one of RESIDENT_INDIVIDUAL, RESIDENT_HUF, NON_RESIDENT_INDIVIDUAL.');
  }
  if (body.taxYear !== undefined && body.taxYear !== null && !/^\d{4}-\d{2}$/.test(body.taxYear)) {
    return bad('taxYear must be in "YYYY-YY" format (e.g. "2025-26"), or omitted.');
  }

  const result = await saveTaxProfile(user.id, {
    taxpayerType: body.taxpayerType as 'RESIDENT_INDIVIDUAL' | 'RESIDENT_HUF' | 'NON_RESIDENT_INDIVIDUAL',
    taxYear: body.taxYear ?? null,
  });

  if (!result.saved) {
    return bad(result.error ?? 'Could not save tax profile.', 503);
  }
  return ok({ saved: true });
}
