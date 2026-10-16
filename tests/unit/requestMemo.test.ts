/**
 * Request-scoped memoisation (16-10-2026, report generation timeout).
 *
 * NAMED NEGATIVE CONTROLS
 *   NC-M1  OUTSIDE a scope nothing is cached: two reads with the same client see data that changed between them
 *          (this is why every existing caller and test is unaffected).
 *   NC-M2  the kill switch REPORT_REQUEST_MEMO=off turns the scope into a pass-through (the "before" behaviour).
 *   NC-M3  a caller that mutates what it received cannot change what the next caller sees.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoClientId, memoInRequest, requestMemoStats, runWithRequestMemo } from '@/lib/services/requestMemo';

afterEach(() => {
  delete process.env.REPORT_REQUEST_MEMO;
  vi.restoreAllMocks();
});

describe('memoInRequest', () => {
  it('NC-M1: outside a scope every call loads again (nothing is cached)', async () => {
    let n = 0;
    const load = async () => ++n;
    expect(await memoInRequest('k', load)).toBe(1);
    expect(await memoInRequest('k', load)).toBe(2);
    expect(requestMemoStats()).toBeNull();
  });

  it('inside a scope the same key loads once, and concurrent callers share the one in-flight load', async () => {
    let n = 0;
    const load = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { value: ++n };
    };
    const [a, b, c] = await runWithRequestMemo(() => Promise.all([memoInRequest('k', load), memoInRequest('k', load), memoInRequest('k', load)]));
    expect(n).toBe(1);
    expect([a.value, b.value, c.value]).toEqual([1, 1, 1]);
  });

  it('different keys and different clients never share an entry', async () => {
    const c1 = {};
    const c2 = {};
    expect(memoClientId(c1)).not.toBe(memoClientId(c2));
    expect(memoClientId(c1)).toBe(memoClientId(c1));
    let n = 0;
    await runWithRequestMemo(async () => {
      await memoInRequest(`x:${memoClientId(c1)}`, async () => ++n);
      await memoInRequest(`x:${memoClientId(c2)}`, async () => ++n);
      await memoInRequest(`y:${memoClientId(c1)}`, async () => ++n);
    });
    expect(n).toBe(3);
  });

  it('NC-M3: each caller gets its own copy, so a caller that edits its result cannot change another caller\'s', async () => {
    await runWithRequestMemo(async () => {
      const first = await memoInRequest('obj', async () => ({ list: [1, 2, 3], nested: { a: 1 } }));
      first.list.push(99);
      first.nested.a = 42;
      const second = await memoInRequest('obj', async () => ({ list: ['never'], nested: { a: -1 } }));
      expect(second).toEqual({ list: [1, 2, 3], nested: { a: 1 } });
    });
  });

  it('a failed load is never cached: the next caller retries', async () => {
    let n = 0;
    await runWithRequestMemo(async () => {
      await expect(memoInRequest('f', async () => { n += 1; throw new Error('db down'); })).rejects.toThrow('db down');
      await expect(memoInRequest('f', async () => ++n)).resolves.toBe(2);
    });
  });

  it('a scope ends with the function it wraps: a second scope starts empty', async () => {
    let n = 0;
    await runWithRequestMemo(() => memoInRequest('k', async () => ++n));
    await runWithRequestMemo(() => memoInRequest('k', async () => ++n));
    expect(n).toBe(2);
  });

  it('a nested scope joins the outer one (work is shared, never duplicated)', async () => {
    let n = 0;
    await runWithRequestMemo(async () => {
      await memoInRequest('k', async () => ++n);
      await runWithRequestMemo(() => memoInRequest('k', async () => ++n));
    });
    expect(n).toBe(1);
  });

  it('NC-M2: the kill switch makes a scope a pass-through again', async () => {
    process.env.REPORT_REQUEST_MEMO = 'off';
    let n = 0;
    await runWithRequestMemo(async () => {
      await memoInRequest('k', async () => ++n);
      await memoInRequest('k', async () => ++n);
    });
    expect(n).toBe(2);
  });

  it('a value that cannot be cloned is still handed out (never an error)', async () => {
    const withFn = { f: () => 1 };
    const out = await runWithRequestMemo(async () => {
      await memoInRequest('fn', async () => withFn);
      return memoInRequest('fn', async () => ({ f: () => 2 }));
    });
    expect(out.f()).toBe(1);
  });
});
