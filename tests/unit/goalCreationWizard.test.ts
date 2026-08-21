import { describe, it, expect } from 'vitest';
import { goalTypeSelectPatch, type GoalTypeRef } from '@/app/(app)/goals/new/GoalCreationWizard';

// App Review AR-0 §3.5: selecting a goal type on Step 0 never prefilled
// goal_name, even though the type's own label was right there. Fixed by
// including goal_name in the type-selection patch, but only while the user
// hasn't yet typed their own edit into the Step 1 field — a type change
// made before that point should keep the prefill in sync, but must never
// clobber a name the user has already manually edited.
describe('goalTypeSelectPatch (Goals wizard Step 0 name-prefill)', () => {
  const homeDeposit: GoalTypeRef = {
    type_key: 'home_deposit',
    category: 'property',
    type_label: 'Home Deposit',
    default_priority: 2,
    default_importance_type: 'critical',
  };
  const emergencyFund: GoalTypeRef = {
    type_key: 'emergency_fund',
    category: 'safety_net',
    type_label: 'Emergency Fund',
    default_priority: 1,
    default_importance_type: 'critical',
  };

  it('prefills goal_name from the type label when the user has not typed their own name yet', () => {
    const patch = goalTypeSelectPatch(homeDeposit, false);
    expect(patch.goal_name).toBe('Home Deposit');
    expect(patch.goal_type).toBe('home_deposit');
    expect(patch.user_priority).toBe(2);
    expect(patch.importance_type).toBe('critical');
  });

  it('updates the prefill on a type change made before the user has typed their own name', () => {
    const first = goalTypeSelectPatch(homeDeposit, false);
    expect(first.goal_name).toBe('Home Deposit');
    // User changes their mind and picks a different type before ever
    // touching the name field — the stale "Home Deposit" prefill must not survive.
    const second = goalTypeSelectPatch(emergencyFund, false);
    expect(second.goal_name).toBe('Emergency Fund');
  });

  it('does not overwrite a name the user has already manually edited', () => {
    // goalNameTouched=true simulates the user having typed into Step 1
    // before returning to Step 0 and picking a different type.
    const patch = goalTypeSelectPatch(emergencyFund, true);
    expect(patch.goal_name).toBeUndefined();
    expect(patch.goal_type).toBe('emergency_fund');
  });
});
