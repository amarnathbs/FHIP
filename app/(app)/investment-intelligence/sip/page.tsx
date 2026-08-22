import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { SipIntelligenceClient } from '@/components/investment-intelligence/SipIntelligenceClient';

// R5 — SIP Intelligence (spec sections 98-100).
//
// Purely derived, read-only analytics. Nothing on this page writes to, or is
// read back into, any FHIP financial register or net worth figure, and no
// historical contribution shown here becomes a future contribution
// assumption in Forecasting.
//
// Every narrative string is an OBSERVATION, EDUCATION, or SIMULATION item.
// This page contains no recommendation: it never tells anyone to increase,
// pause, stop, or switch a recurring investment.
export default async function SipIntelligencePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-ink">Recurring investments</h1>
        <p className="mt-1 text-sm text-muted">
          What your recurring contributions have actually done, and what the same contributions — the same amounts, on the same dates — would have done in the
          benchmark. These figures describe what has already happened. They are not advice, and they are not a forecast.
        </p>
      </header>
      <SipIntelligenceClient />
    </div>
  );
}
