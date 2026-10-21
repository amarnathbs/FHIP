import { createClient } from '@/lib/supabase/server';
import { profileSchema } from '@/lib/validation/profile';
import { ok, bad, badValidation } from '@/lib/api';
import { recordCountryAuditEvent, recordReportingCurrencyAuditEvent } from '@/lib/services/countryAudit';
import {
  isRetirementDeclarationDbRefusal,
  loadRetirementDeclarationBlockers,
  refuseRetirementDeclarationIfConflicting,
  retirementDeclarationConflictResponse,
} from '@/lib/services/retirementDeclarationGuard';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { data, error } = await supabase.from('user_profiles').select('*').eq('user_id', user.id).single();
  return error ? bad(error.message) : ok(data);
}

export async function PUT(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  // profileSchema has no country_confirmed_at/country_source field at all —
  // zod's default (non-strict) object parsing drops any unrecognised key
  // from the parsed output, so a forged client attempt to set either column
  // through this general endpoint is structurally impossible (spec 8.2:
  // "forged country_confirmed_at", "client cannot mark country_source=
  // ADMIN_CORRECTED"). The only legitimate way to set them is
  // POST /api/user/country/confirm.
  const parsed = profileSchema.partial().safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);

  // Mandatory Country Confirmation (spec 5.7) — changing country_of_residence
  // through this general profile endpoint must require EXPLICIT
  // reconfirmation, never silently keep the account "confirmed" against a
  // country the user never actually confirmed. If the incoming value
  // differs from what's on record, reset the confirmation evidence in the
  // SAME update (forcing the next protected-route/API check back to
  // COUNTRY_UNCONFIRMED) and record the change in the existing audit trail.
  // This never touches, hides or reclassifies any existing financial record
  // (spec 1.3) — it only affects future access-gate evaluation.
  //
  // G3 section 8.4: the same pre-read also captures the previous reporting
  // currency, so a currency change can be audited. The two are read together
  // and audited SEPARATELY — changing currency never resets country
  // confirmation, and changing country never rewrites currency.
  let countryChanged = false;
  let previousCountry: string | null = null;
  let currencyChanged = false;
  let previousCurrency: string | null = null;
  if ('country_of_residence' in parsed.data || 'preferred_currency' in parsed.data) {
    const { data: existing } = await supabase
      .from('user_profiles')
      .select('country_of_residence, country_confirmed_at, preferred_currency')
      .eq('user_id', user.id)
      .maybeSingle();
    previousCountry = existing?.country_of_residence ?? null;
    previousCurrency = existing?.preferred_currency ?? null;
    countryChanged =
      'country_of_residence' in parsed.data &&
      !!existing?.country_confirmed_at &&
      existing.country_of_residence !== parsed.data.country_of_residence;
    currencyChanged =
      'preferred_currency' in parsed.data &&
      previousCurrency !== null &&
      previousCurrency !== parsed.data.preferred_currency;
  }

  // PO-D24-02 (21-10-2026): "I don't have any retirement savings" cannot be SAVED as true while an active retirement account or SMSF
  // exists. The grid disables the tick, but the rule lives here so a direct API call cannot write the contradiction. Checked BEFORE any
  // write (nothing in this request is saved when it is refused), and re-checked AFTER the write below to close the window between the two.
  const declaringNoRetirement = parsed.data.not_applicable_retirement === true;
  let previousNoRetirement: boolean | null = null;
  if (declaringNoRetirement) {
    const refusal = await refuseRetirementDeclarationIfConflicting(supabase, user.id);
    if (refusal) return refusal;
    const { data: before } = await supabase.from('user_profiles').select('not_applicable_retirement').eq('user_id', user.id).maybeSingle();
    previousNoRetirement = (before as { not_applicable_retirement?: boolean | null } | null)?.not_applicable_retirement ?? false;
  }

  const updatePayload: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  if (countryChanged) {
    updatePayload.country_confirmed_at = null;
    updatePayload.country_source = null;
    updatePayload.country_updated_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('user_profiles')
    .update(updatePayload)
    .eq('user_id', user.id)
    .select()
    .single();
  if (error) {
    // Migration 0298 refuses the same transition inside the database (any writer, a direct REST call included): answer with the same readable 409.
    if (isRetirementDeclarationDbRefusal(error)) return retirementDeclarationConflictResponse(await loadRetirementDeclarationBlockers(supabase, user.id));
    return bad(error.message);
  }

  // Re-check after the write: an account or SMSF added between the check above and this write must not leave the contradiction behind.
  // The declaration is put back exactly as it was and the person is told why.
  if (declaringNoRetirement) {
    const after = await loadRetirementDeclarationBlockers(supabase, user.id);
    if (after.total > 0) {
      await supabase
        .from('user_profiles')
        .update({ not_applicable_retirement: previousNoRetirement ?? false, updated_at: new Date().toISOString() })
        .eq('user_id', user.id);
      return retirementDeclarationConflictResponse(after);
    }
  }

  if (countryChanged) {
    await recordCountryAuditEvent({
      userId: user.id,
      eventType: 'country_change_pending_reconfirmation',
      previousCountry,
      newCountry: (parsed.data as { country_of_residence?: string }).country_of_residence ?? null,
      actor: 'self',
    });
  }

  if (currencyChanged) {
    await recordReportingCurrencyAuditEvent({
      userId: user.id,
      previousCurrency,
      newCurrency: (parsed.data as { preferred_currency?: string }).preferred_currency ?? null,
      actor: 'self',
    });
  }

  return ok(data);
}
