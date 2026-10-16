/**
 * The Generate report button's client logic (16-10-2026): the PO saw "Failed to execute 'json' on 'Response':
 * Unexpected end of JSON input" because the old code called response.json() on whatever came back.
 *
 * NAMED NEGATIVE CONTROLS
 *   NC-J1  the OLD call (await res.json()) on each of these bodies really throws the PO's message; the new reader never does.
 *   NC-J2  the components contain no direct response.json() call (source guard).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { attemptGenerate, describeFailure, readApiResponse, runGenerate, type GenerateStatus } from '@/lib/reports/apiClient';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = (status: number) => new Response('', { status });
const html = (status: number) => new Response('<!DOCTYPE html><html><body><h1>504 Gateway Time-out</h1></body></html>', { status, headers: { 'Content-Type': 'text/html' } });
const BODY = { reportType: 'monthly_financial_health', reportMonth: '2026-10-01' };
const noSleep = vi.fn(async () => undefined);

function sequence(...responses: Array<Response | Error>): typeof fetch {
  const queue = [...responses];
  return (async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra request');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}

describe('NC-J1: the old reading throws the PO\'s message; the new reader does not', () => {
  it.each([
    ['an empty body (platform cut-off)', () => empty(504)],
    ['an HTML gateway page', () => html(504)],
    ['an empty 200', () => empty(200)],
  ])('%s', async (_name, make) => {
    await expect(make().json()).rejects.toThrow(/JSON/); // what the old button did, and what the user saw
    const read = await readApiResponse(make());
    expect(read.json).toBeNull();
    const failure = describeFailure(read);
    expect(failure.message).not.toMatch(/JSON|Unexpected end|Failed to execute/i);
  });

  it('the old call on the empty body gives exactly the PO\'s message', async () => {
    await expect(empty(504).json()).rejects.toThrow('Unexpected end of JSON input');
  });
});

describe('readApiResponse', () => {
  it('classifies empty, HTML, non-object JSON, text and JSON', async () => {
    expect((await readApiResponse(empty(200))).bodyKind).toBe('empty');
    expect((await readApiResponse(html(502))).bodyKind).toBe('html');
    expect((await readApiResponse(new Response('"just a string"', { status: 200 }))).bodyKind).toBe('text');
    expect((await readApiResponse(new Response('[1,2]', { status: 200 }))).json).toBeNull();
    expect((await readApiResponse(new Response('Bad Gateway', { status: 502 }))).bodyKind).toBe('text');
    const ok = await readApiResponse(json(200, { data: { a: 1 } }));
    expect(ok).toMatchObject({ ok: true, bodyKind: 'json', json: { data: { a: 1 } } });
  });

  it('survives a body that cannot be read at all', async () => {
    const broken = { status: 500, ok: false, text: () => Promise.reject(new Error('stream reset')) } as unknown as Response;
    expect(await readApiResponse(broken)).toMatchObject({ bodyKind: 'empty', json: null, status: 500 });
  });
});

describe('describeFailure', () => {
  it('shows a typed message, code and reference as given', () => {
    const f = describeFailure({ status: 503, ok: false, bodyKind: 'json', json: { error: 'Your report was prepared but could not be saved completely, so it was not kept. Please generate it again.', code: 'REPORT_NOT_SAVED', correlationId: 'rpt-abc123', retryable: true } });
    expect(f).toMatchObject({ code: 'REPORT_NOT_SAVED', correlationId: 'rpt-abc123', retryable: true, status: 503 });
    expect(f.message).toContain('could not be saved completely');
  });

  it('maps 401 to a sign-in message that is not retryable', () => {
    expect(describeFailure({ status: 401, ok: false, bodyKind: 'json', json: { error: 'unauthenticated' } })).toMatchObject({ retryable: false, message: expect.stringContaining('sign in') });
  });

  it('maps 502/503/504/empty/HTML to a plain, retryable message with no technical words', () => {
    for (const status of [502, 503, 504]) {
      const f = describeFailure({ status, ok: false, bodyKind: 'empty', json: null });
      expect(f).toMatchObject({ retryable: true, code: 'NO_ANSWER' });
      expect(f.message).not.toMatch(/JSON|gateway|HTTP|\d{3}/i);
    }
    expect(describeFailure({ status: 500, ok: false, bodyKind: 'html', json: null }).code).toBe('UNREADABLE_ANSWER');
  });
});

describe('attemptGenerate', () => {
  it('200 -> done with the report id', async () => {
    expect(await attemptGenerate(sequence(json(200, { data: { report: { id: 'r1' }, sectionCount: 30 } })), BODY)).toEqual({ kind: 'done', reportId: 'r1' });
  });

  it('202 preparing -> preparing with the server\'s retry hint', async () => {
    expect(await attemptGenerate(sequence(json(202, { data: { preparing: true, runId: 'run-1', retryAfterMs: 4000 } })), BODY)).toEqual({ kind: 'preparing', retryAfterMs: 4000, runId: 'run-1' });
  });

  it('202 waiting (price history) -> waiting with the state', async () => {
    const state = { headline: 'Your report will be ready once price history is loaded (1 of 2 funds loaded)', loaded: 1, total: 2, waitingFunds: ['Fund B'], unavailableFunds: [], retryWindowMinutes: 10 };
    expect(await attemptGenerate(sequence(json(202, { data: { waiting: true, ...state } })), BODY)).toMatchObject({ kind: 'waiting', state: { loaded: 1, total: 2 } });
  });

  it('a lost connection is a retryable failure, not a thrown error', async () => {
    expect(await attemptGenerate(sequence(new TypeError('Failed to fetch')), BODY)).toMatchObject({ kind: 'failed', failure: { code: 'NETWORK', retryable: true } });
  });

  it('a 200 whose body is empty is NOT treated as success (no report id to open)', async () => {
    expect(await attemptGenerate(sequence(empty(200)), BODY)).toMatchObject({ kind: 'failed', failure: { code: 'NO_ANSWER' } });
  });
});

describe('runGenerate', () => {
  const base = { body: BODY, sleep: noSleep, onStatus: () => undefined };

  it('202 preparing, then preparing, then ready -> done; the screen reader hears each state; waits grow', async () => {
    const statuses: GenerateStatus[] = [];
    const sleeps: number[] = [];
    const out = await runGenerate({
      ...base,
      fetchFn: sequence(json(202, { data: { preparing: true, retryAfterMs: 4000 } }), json(202, { data: { preparing: true, retryAfterMs: 4000 } }), json(200, { data: { report: { id: 'r9' } } })),
      sleep: async (ms) => { sleeps.push(ms); },
      onStatus: (s) => statuses.push(s),
    });
    expect(out).toEqual({ kind: 'done', reportId: 'r9' });
    expect(statuses.map((s) => s.phase)).toEqual(['requesting', 'preparing', 'preparing']);
    expect(statuses.every((s) => s.announcement.length > 0)).toBe(true);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThanOrEqual(sleeps[0]);
  });

  it('an empty 504 is re-asked quietly (the request is idempotent) and a later 200 wins', async () => {
    const statuses: GenerateStatus[] = [];
    const out = await runGenerate({ ...base, fetchFn: sequence(empty(504), json(202, { data: { preparing: true } }), json(200, { data: { report: { id: 'r2' } } })), onStatus: (s) => statuses.push(s) });
    expect(out).toEqual({ kind: 'done', reportId: 'r2' });
    expect(statuses.map((s) => s.phase)).toContain('retrying');
  });

  it('empty / HTML answers that never recover end as a plain retryable message after a bounded number of re-asks', async () => {
    const out = await runGenerate({ ...base, fetchFn: sequence(empty(504), html(504), empty(504), empty(504)), maxSilentRetries: 3 });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.failure.retryable).toBe(true);
      expect(out.failure.message).not.toMatch(/JSON|Unexpected/i);
    }
  });

  it('a typed 503 is shown as given (no silent retries) with its reference', async () => {
    const out = await runGenerate({ ...base, fetchFn: sequence(json(503, { error: 'We could not finish preparing your report in time on the last few attempts. Nothing was lost. Please try again in a few minutes.', code: 'REPORT_PREPARATION_STALLED', correlationId: 'rpt-zzz', retryable: true })) });
    expect(out).toMatchObject({ kind: 'error', failure: { code: 'REPORT_PREPARATION_STALLED', correlationId: 'rpt-zzz', retryable: true } });
  });

  it('a typed 500 error is shown as given and is not retried silently', async () => {
    const fetchFn = vi.fn(sequence(json(500, { error: 'We could not generate your report just now.', code: 'REPORT_GENERATION_FAILED', correlationId: 'rpt-1', retryable: true }), json(200, { data: { report: { id: 'late' } } })));
    const out = await runGenerate({ ...base, fetchFn: fetchFn as unknown as typeof fetch });
    expect(out.kind).toBe('error');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps asking only up to the stated bound while the report stays in preparation, then explains how to continue', async () => {
    const forever = (() => json(202, { data: { preparing: true, retryAfterMs: 4000 } })) as unknown as typeof fetch;
    const out = await runGenerate({ ...base, fetchFn: forever, maxPreparingMs: 20_000 });
    expect(out).toMatchObject({ kind: 'error', failure: { code: 'PREPARING_TIMEOUT', retryable: true } });
    if (out.kind === 'error') expect(out.failure.message).toMatch(/Generate report again/);
  });

  it('the price-history wait still drives the fetch between attempts, then completes', async () => {
    const drive = vi.fn(async () => undefined);
    const state = { headline: 'Waiting', loaded: 0, total: 1, waitingFunds: ['Fund A'], unavailableFunds: [], retryWindowMinutes: 10 };
    const out = await runGenerate({ ...base, fetchFn: sequence(json(202, { data: { waiting: true, ...state } }), json(200, { data: { report: { id: 'r3' } } })), driveHistory: drive });
    expect(out).toEqual({ kind: 'done', reportId: 'r3' });
    expect(drive).toHaveBeenCalledTimes(1);
  });

  it('stops quietly when the page is left', async () => {
    const out = await runGenerate({ ...base, fetchFn: sequence(json(202, { data: { preparing: true } })), isStopped: (() => { let n = 0; return () => ++n > 2; })() });
    expect(out.kind).toBe('stopped');
  });
});

describe('NC-J2: the components never call response.json() directly', () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
  it.each(['components/reports/GenerateReportButton.tsx', 'components/reports/ReportActions.tsx'])('%s', (file) => {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // comments may mention the old call
    expect(code).not.toMatch(/\bres\.json\(\)|\bresponse\.json\(\)|await [a-zA-Z]+\.json\(\)/);
  });
});
