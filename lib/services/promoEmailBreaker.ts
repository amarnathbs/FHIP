// Server-only. The mail provider circuit breaker backed by the service-role-only database functions of migration 0266.
// Failing to reach the breaker never blocks an admin (it reports null and sending proceeds under the other limits), and
// never carries an address or a code.

import { createAdminClient } from '@/lib/supabase/admin';
import type { CircuitBreaker } from '@/lib/services/promoCodeEmail';

type State = { open: boolean } | null;

function toState(data: unknown): State {
  const v = data as { open?: unknown } | null;
  return v && typeof v.open === 'boolean' ? { open: v.open } : null;
}

export function createCircuitBreaker(): CircuitBreaker | undefined {
  let client: ReturnType<typeof createAdminClient>;
  try {
    client = createAdminClient();
  } catch {
    return undefined;
  }
  return {
    async status() {
      const { data, error } = await client.rpc('promo_email_circuit_status');
      return error ? null : toState(data);
    },
    async report(ok: boolean) {
      const { data, error } = await client.rpc('promo_email_circuit_report', { p_ok: ok });
      return error ? null : toState(data);
    },
  };
}
