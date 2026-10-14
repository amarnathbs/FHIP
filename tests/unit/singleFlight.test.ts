// Single-flight for the chargeable section of an AI document fallback (lib/ai/access/singleFlight.ts).
// Found on DEV: five identical concurrent requests for one document made four metered provider calls.
import { describe, it, expect, vi } from 'vitest';
import { singleFlight, singleFlightSize } from '@/lib/ai/access/singleFlight';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('singleFlight', () => {
  it('N concurrent callers with the same key run the work ONCE and all get its result', async () => {
    const gate = deferred<string>();
    const work = vi.fn(() => gate.promise);
    const calls = Array.from({ length: 5 }, () => singleFlight('doc-a', work));
    expect(singleFlightSize()).toBe(1);
    gate.resolve('draft-1');
    expect(await Promise.all(calls)).toEqual(['draft-1', 'draft-1', 'draft-1', 'draft-1', 'draft-1']);
    expect(work).toHaveBeenCalledTimes(1);
    expect(singleFlightSize()).toBe(0);
  });

  it('different keys (another document, another user) never share a result', async () => {
    const work = vi.fn(async (v: string) => v);
    const [a, b, c] = await Promise.all([
      singleFlight('bank:user-1:doc-1', () => work('one')),
      singleFlight('bank:user-1:doc-2', () => work('two')),
      singleFlight('bank:user-2:doc-1', () => work('three')),
    ]);
    expect([a, b, c]).toEqual(['one', 'two', 'three']);
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('a SEQUENTIAL second request runs again: nothing is cached after settlement', async () => {
    const work = vi.fn(async () => 'x');
    await singleFlight('k', work);
    await singleFlight('k', work);
    expect(work).toHaveBeenCalledTimes(2);
    expect(singleFlightSize()).toBe(0);
  });

  it('a failure reaches every concurrent caller, then clears so a later retry can run', async () => {
    const gate = deferred<string>();
    const work = vi.fn(() => gate.promise);
    const calls = [singleFlight('k2', work), singleFlight('k2', work), singleFlight('k2', work)].map((p) => p.catch((e) => (e as Error).message));
    gate.reject(new Error('provider timed out'));
    expect(await Promise.all(calls)).toEqual(['provider timed out', 'provider timed out', 'provider timed out']);
    expect(work).toHaveBeenCalledTimes(1);
    expect(singleFlightSize()).toBe(0);
    const retry = vi.fn(async () => 'ok');
    expect(await singleFlight('k2', retry)).toBe('ok');
  });

  it('a synchronous throw inside the work is a rejection, not a leaked entry', async () => {
    await expect(singleFlight('k3', () => { throw new Error('sync boom'); })).rejects.toThrow('sync boom');
    expect(singleFlightSize()).toBe(0);
  });
});

describe('wired into every AI document fallback (negative control: the wiring is checked, not assumed)', () => {
  it('each chargeable entry point goes through singleFlight', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '..', '..');
    const expected: Array<[string, RegExp]> = [
      ['lib/financial-data-hub/services/bankPdfProcessingService.ts', /singleFlight\(`bank_statement:/],
      ['lib/financial-data-hub/services/liabilityStatementProcessingService.ts', /singleFlight\(`liability_statement:/],
      ['lib/financial-data-hub/services/investmentStatementProcessingService.ts', /singleFlight\(`investment_statement:/],
      ['lib/financial-data-hub/services/retirementStatementProcessingService.ts', /singleFlight\(`retirement_statement:/],
      ['lib/financial-data-hub/services/payslipProcessingService.ts', /singleFlight\(`payslip:/],
      ['lib/services/investment-intelligence/aiFallbackDocumentExtraction.ts', /singleFlight\(`ii_document:/],
    ];
    for (const [rel, rx] of expected) {
      expect(rx.test(fs.readFileSync(path.join(root, rel), 'utf8')), rel).toBe(true);
    }
    // control: the matcher is not vacuous
    expect(/singleFlight\(`bank_statement:/.test('const x = 1;')).toBe(false);
  });
});
