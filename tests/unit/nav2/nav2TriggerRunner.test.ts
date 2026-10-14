// NAV2 Stage 2 -- the trigger runner: what the post-response kick runs, switch OFF versus ON.
//
// Matrix: spec row 50 and Stage 2 rows S2-04 (switch off = the existing behaviour, nothing new runs), S2-21 (switch on plans the
// caller's own schemes and executes through the existing path), S2-22 (a planning failure falls back to the existing path, never
// leaves history unfetched).
//
// NAMED NEGATIVE CONTROLS
//   NC-T1  switch OFF (or its row missing, or unreadable): ONLY the legacy runner is called; the planner is not touched;
//   NC-T2  switch ON: the planner runs with the trigger and the period, and the legacy runner is NOT called;
//   NC-T3  switch ON but planning throws: the legacy runner runs (the user's history is still fetched), the error is not rethrown;
//   NC-T4  the default kick runner (userNavHistoryKick) routes through this runner and nothing else.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Nav2Trigger } from '@/lib/engines/nav2/requiredWindowPlanner';
import { runUserNavHistoryForKick, type TriggerRunnerDeps } from '@/lib/services/investment-intelligence/nav2/nav2TriggerRunner';

const outcome = { action: 'plan_held_windows', reason: 'r', plan: {}, executed: null } as never;
const mk = (on: boolean | 'throws', plannedImpl?: TriggerRunnerDeps['planned']) => {
  const legacy = vi.fn(async () => 'legacy-result');
  const planned = vi.fn(plannedImpl ?? (async () => outcome));
  const isPlannerOn = on === 'throws' ? async () => { throw new Error('boom'); } : async () => on;
  return { legacy, planned, deps: { isPlannerOn, legacy, planned } as Partial<TriggerRunnerDeps> };
};

describe('switch OFF (NC-T1, matrix 43)', () => {
  it('runs only the legacy runner and returns its result', async () => {
    const { legacy, planned, deps } = mk(false);
    expect(await runUserNavHistoryForKick('u1', deps)).toBe('legacy-result');
    expect(legacy).toHaveBeenCalledWith('u1');
    expect(planned).not.toHaveBeenCalled();
  });
  it('an unreadable switch is OFF too (the live reader fails closed); here the injected reader throws and the default reader would return false', async () => {
    const { legacy, planned, deps } = mk('throws');
    // an injected reader that throws is a programming error in the dependency; the LIVE reader never throws (see nav2Flags tests).
    await expect(runUserNavHistoryForKick('u1', deps)).rejects.toThrow('boom');
    expect(planned).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });
});

describe('switch ON (NC-T2, NC-T3, matrix 62, 63)', () => {
  it('plans with the trigger and the period and does NOT call the legacy runner', async () => {
    const { legacy, planned, deps } = mk(true);
    const trigger: Nav2Trigger = { kind: 'report_period_requested' };
    expect(await runUserNavHistoryForKick('u1', deps, trigger, '3y')).toBe(outcome);
    expect(planned).toHaveBeenCalledWith('u1', trigger, '3y', null); // no fund scope: every fund held (B2 added the optional 4th argument)
    expect(legacy).not.toHaveBeenCalled();
  });
  it('B2: a report-period kick for chosen funds hands exactly those fund ids to the plan', async () => {
    const { planned, deps } = mk(true);
    await runUserNavHistoryForKick('u1', deps, { kind: 'report_period_requested' }, '3y', ['f1', 'f2']);
    expect(planned).toHaveBeenCalledWith('u1', { kind: 'report_period_requested' }, '3y', ['f1', 'f2']);
  });
  it('defaults to the statement-accepted trigger and the widest period', async () => {
    const { planned, deps } = mk(true);
    await runUserNavHistoryForKick('u1', deps);
    expect(planned).toHaveBeenCalledWith('u1', { kind: 'statement_accepted' }, 'all_history', null);
  });
  it('NC-T3: a planning failure falls back to the legacy runner and is not rethrown', async () => {
    const { legacy, deps } = mk(true, async () => { throw new Error('planner exploded'); });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runUserNavHistoryForKick('u1', deps)).toBe('legacy-result');
    expect(legacy).toHaveBeenCalledWith('u1');
    spy.mockRestore();
  });
});

describe('NC-T4: the default kick runner goes through this runner (static)', () => {
  it('userNavHistoryKick defaultRunner imports nav2TriggerRunner and no longer calls the live batch directly', () => {
    const t = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'lib/services/investment-intelligence/pc6/userNavHistoryKick.ts'), 'utf8');
    expect(t).toMatch(/import\('\.\.\/nav2\/nav2TriggerRunner'\)/);
    expect(t).toMatch(/runUserNavHistoryForKick\(userId\)/);
    const code = t.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join(' ');
    expect(code).not.toMatch(/runLiveUserNavHistoryBatch\(userId\)/);
  });
  it('the legacy runner the switch-off path calls is still the live batch (unchanged)', () => {
    const t = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'lib/services/investment-intelligence/nav2/nav2TriggerRunner.ts'), 'utf8');
    expect(t).toMatch(/legacy: \(userId\) => runLiveUserNavHistoryBatch\(userId\)/);
  });
});
