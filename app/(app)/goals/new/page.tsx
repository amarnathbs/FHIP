import { PageBackLink } from '@/components/navigation/PageBackLink';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { GoalCreationWizard } from './GoalCreationWizard';

async function NewGoalPageContent() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <>
      <div className="space-y-2">
        {/* The way out of this wizard is the shared PageBackLink the page wrapper renders (PO review F6). */}
        <h1 className="text-2xl font-semibold text-trust">Create a Goal</h1>
        <p className="text-gray-500">A few short steps to turn this into a measurable, trackable plan.</p>
      </div>
      <div className="mt-6">
        <GoalCreationWizard />
      </div>
    </>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Goals).
export default function NewGoalPage() {
  return (
    <>
      <PageBackLink href="/goals" label="Goals" />
      <NewGoalPageContent />
    </>
  );
}
