// POST /api/user/primary-country/preview — spec section 14.1. Computes and
// STORES a preview row (country_change_previews, migration 0122); never
// persists the change itself. The client only ever gets back a preview id
// plus the computed effects — confirm (see ../confirm/route.ts) re-reads
// this stored row rather than trusting anything the client echoes back.
import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

const previewSchema = z.object({ proposed_primary_country: z.string().length(2) });

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const parsed = previewSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad('INVALID_REQUEST', 422);
  const proposed = parsed.data.proposed_primary_country.trim().toUpperCase();

  const supabase = await createClient();

  const { data: profile, error: profileErr } = await supabase
    .from('user_profiles')
    .select('primary_country, country_of_residence, preferred_currency')
    .eq('user_id', user.id)
    .maybeSingle();
  if (profileErr) return bad('OPERATIONAL_ERROR', 500);
  if (!profile) return bad('PROFILE_INCOMPLETE', 403);

  const { data: proposedCountry, error: countryErr } = await supabase
    .from('countries')
    .select('country_code, experience_level, default_currency_code, selectable, active')
    .eq('country_code', proposed)
    .maybeSingle();
  if (countryErr) return bad('OPERATIONAL_ERROR', 500);
  if (!proposedCountry || !proposedCountry.selectable || !proposedCountry.active) {
    return bad('COUNTRY_NOT_SELECTABLE', 422);
  }

  const currentPrimary = profile.primary_country ?? profile.country_of_residence;
  const { data: currentCountry } = currentPrimary
    ? await supabase.from('countries').select('experience_level, default_currency_code').eq('country_code', currentPrimary).maybeSingle()
    : { data: null };

  const { data: currentCaps } = currentPrimary
    ? await supabase.from('country_capabilities').select('capability, enabled').eq('country_code', currentPrimary)
    : { data: [] as { capability: string; enabled: boolean }[] };
  const { data: proposedCaps } = await supabase
    .from('country_capabilities')
    .select('capability, enabled')
    .eq('country_code', proposed);

  const currentEnabled = new Set((currentCaps ?? []).filter((c) => c.enabled).map((c) => c.capability));
  const proposedEnabled = new Set((proposedCaps ?? []).filter((c) => c.enabled).map((c) => c.capability));
  const gainedCapabilities = [...proposedEnabled].filter((c) => !currentEnabled.has(c));
  const lostCapabilities = [...currentEnabled].filter((c) => !proposedEnabled.has(c));

  // Currency preview mirrors the exact rule confirm_primary_country_change()
  // applies (migration 0122): only propose moving to the new country's
  // default currency when the CURRENT value still equals the OLD country's
  // default (no explicit divergent choice) and the new default is one of
  // the two currencies this app's FX engine/zod schema actually supports.
  const oldDefault = currentCountry?.default_currency_code ?? null;
  const newDefault = proposedCountry.default_currency_code;
  const willUpdateCurrency =
    ['AUD', 'INR'].includes(newDefault) && (profile.preferred_currency == null || profile.preferred_currency === oldDefault);
  const proposedBaseCurrency = willUpdateCurrency ? newDefault : profile.preferred_currency;

  const { data: preview, error: insertErr } = await supabase
    .from('country_change_previews')
    .insert({
      user_id: user.id,
      current_primary_country: currentPrimary,
      proposed_primary_country: proposed,
      current_base_currency: profile.preferred_currency,
      proposed_base_currency: proposedBaseCurrency,
      current_experience_level: currentCountry?.experience_level ?? null,
      proposed_experience_level: proposedCountry.experience_level,
    })
    .select('id, expires_at')
    .single();
  if (insertErr) return bad('OPERATIONAL_ERROR', 500);

  return ok({
    preview_id: preview.id,
    expires_at: preview.expires_at,
    current_primary_country: currentPrimary,
    proposed_primary_country: proposed,
    current_experience_level: currentCountry?.experience_level ?? null,
    proposed_experience_level: proposedCountry.experience_level,
    current_base_currency: profile.preferred_currency,
    proposed_base_currency: proposedBaseCurrency,
    base_currency_will_change: proposedBaseCurrency !== profile.preferred_currency,
    modules_gaining_capability: gainedCapabilities,
    modules_losing_capability: lostCapabilities,
    residence_country_unaffected: true,
    historical_data_preserved: true,
    cross_border_relationships_retained: true,
    warnings: [
      'This changes only your primary application experience and, where applicable, your reporting currency default.',
      'Your confirmed country of residence and existing financial records are never changed by this action.',
      lostCapabilities.length > 0
        ? `The following capabilities will no longer be offered for new activity in your new primary country: ${lostCapabilities.join(', ')}. Existing records remain fully visible and counted.`
        : null,
    ].filter(Boolean),
  });
}
