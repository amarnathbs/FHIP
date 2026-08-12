import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { GoalCreationWizard } from './GoalCreationWizard';

export default async function NewGoalPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-trust">Create a Goal</h1>
        <p className="text-gray-500">A few short steps to turn this into a measurable, trackable plan.</p>
      </div>
      <div className="mt-6">
        <GoalCreationWizard />
      </div>
    </>
  );
}
