// Module 11.4 — the narrowest appropriate Premium page for the standard
// question library (spec section 36). Deliberately NOT named "AI Coach" —
// that would imply open chat, which does not exist until a future phase
// (spec sections 6-7, Y).

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { StandardQuestionLibrary } from '@/components/aiInsights/StandardQuestionLibrary';

export default async function AiInsightsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Your Financial Insights</h1>
        <p className="mt-1 text-muted">
          Answers to common questions about your finances, drawn from your own FHIP data — no new AI request is
          made when you select one.
        </p>
      </div>
      <StandardQuestionLibrary />
    </div>
  );
}
