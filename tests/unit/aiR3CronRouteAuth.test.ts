// Module 11 remediation R3 — the scheduled route refuses anything without
// the shared cron secret BEFORE touching any service (the same contract as
// every other x-cron-secret route in this repository).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const createSchedulerService = vi.fn();
vi.mock('@/lib/ai/insightPack/scheduler', () => ({ createSchedulerService: () => createSchedulerService(), getModule11SchedulerMaxHouseholdsPerRun: () => 5 }));

const { POST } = await import('@/app/api/ai/cron/insight-pack-monthly/route');

const saved = process.env.CRON_SECRET;
beforeEach(() => { process.env.CRON_SECRET = 'unit-test-cron-secret'; createSchedulerService.mockReset(); });
afterEach(() => { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; });

describe('R3 — POST /api/ai/cron/insight-pack-monthly auth', () => {
  it('401 with no header, wrong header, or when CRON_SECRET itself is unset; service never constructed', async () => {
    expect((await POST(new Request('http://x/api/ai/cron/insight-pack-monthly', { method: 'POST' }))).status).toBe(401);
    expect((await POST(new Request('http://x/api/ai/cron/insight-pack-monthly', { method: 'POST', headers: { 'x-cron-secret': 'wrong' } }))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await POST(new Request('http://x/api/ai/cron/insight-pack-monthly', { method: 'POST', headers: { 'x-cron-secret': 'unit-test-cron-secret' } }))).status).toBe(401);
    expect(createSchedulerService).not.toHaveBeenCalled();
  });

  it('with the secret: reconcile runs before submit, both as cron-triggered, body options forwarded', async () => {
    const order: string[] = [];
    createSchedulerService.mockReturnValue({
      runReconcilePhase: async (i: unknown) => { order.push('reconcile'); return { status: 'COMPLETED', input: i }; },
      runSubmitPhase: async (i: unknown) => { order.push('submit'); return { status: 'COMPLETED', input: i }; },
    });
    const res = await POST(new Request('http://x/api/ai/cron/insight-pack-monthly', { method: 'POST', headers: { 'x-cron-secret': 'unit-test-cron-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: true, maxHouseholds: 2, billingPeriod: '2026-09' }) }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(order).toEqual(['reconcile', 'submit']);
    expect(json.data.submit.input).toMatchObject({ triggeredBy: 'cron', dryRun: true, maxHouseholds: 2, billingPeriod: '2026-09' });
    expect(json.data.reconcile.input).toMatchObject({ triggeredBy: 'cron' });
  });
});
