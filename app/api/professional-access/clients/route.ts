// Professional's own client list — strictly the caller's own active/
// pending relationships (spec section 62: "must not search arbitrary FHIP
// users"). listClientsForProfessional() filters by professional_user_id =
// the caller's own id; there is no parameter that could widen this.
import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { listClientsForProfessional } from '@/lib/services/professional-access/access';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const clients = await listClientsForProfessional(user.id);
  return ok({ clients });
}
