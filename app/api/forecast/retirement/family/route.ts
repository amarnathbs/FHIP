// PO-D24-01: the Family retirement view (Personal retirement + SMSF). Read only: it computes on demand with the same options as the personal
// retirement run, writes nothing, and answers { available: false } when the person has no active SMSF.
import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { runFamilyRetirementView } from '@/lib/services/forecastData';
import { forecastRunRequestSchema } from '@/lib/validation/forecast';

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = forecastRunRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badValidation(parsed.error, 422);
  if (parsed.data.forecast_type !== 'retirement') return bad('The family retirement view is only available for the retirement forecast.', 422);
  try {
    const view = await runFamilyRetirementView(user.id, {
      scenarioId: parsed.data.scenario_id,
      retirementTargetMethod: parsed.data.retirement_target_method,
      retirementTargetCorpus: parsed.data.retirement_target_corpus,
      retirementDesiredAnnualIncome: parsed.data.retirement_desired_annual_income,
      retirementReplacementPercentage: parsed.data.retirement_replacement_percentage,
      whatIfRetirementAges: { self: parsed.data.retirement_what_if_age_self ?? null, spouse: parsed.data.retirement_what_if_age_spouse ?? null },
    });
    return ok(view);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not work out the family retirement position');
  }
}
