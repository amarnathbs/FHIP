import Link from 'next/link';
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
        {/* App Review 2026-09-14, item (nav audit): this 5-step wizard had no
            cancel/exit control anywhere -- Back is disabled on step 0, and
            there was no link back to /goals, so a person who opened this by
            mistake (or changed their mind) had only the browser's own back
            button. */}
        <Link href="/goals" className="text-xs text-muted hover:underline">
          ← Back to Goals
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-trust">Create a Goal</h1>
        <p className="text-gray-500">A few short steps to turn this into a measurable, trackable plan.</p>
      </div>
      <div className="mt-6">
        <GoalCreationWizard />
      </div>
    </>
  );
}
