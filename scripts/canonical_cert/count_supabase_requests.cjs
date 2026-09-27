/**
 * Canonical-cert timing instrumentation (DEV dev-server only; loaded with NODE_OPTIONS=--require).
 *
 * Counts every outgoing fetch to the Supabase project host and the time spent waiting on it, and writes
 * a running total to .canonical-cert/sb-requests-<pid>.json after each request completes. A journey
 * reads the files before and after one app request (run sequentially) to get:
 *   requests   -- how many PostgREST/Auth/Storage round trips that app request made
 *   maxInFlight -- the peak concurrency (1 = strictly sequential)
 * With the local round-trip time measured separately, this turns a localhost wall time into a
 * production estimate: sequential trips x production RTT + compute. Never logs URLs' query strings,
 * headers or bodies (no data, no secrets): only counts and timings.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- a --require preload must be CommonJS */
const fs = require('node:fs');
const path = require('node:path');

const original = globalThis.fetch;
if (typeof original === 'function' && !globalThis.__sbCountInstalled) {
  globalThis.__sbCountInstalled = true;
  const file = path.resolve(process.cwd(), '.canonical-cert', `sb-requests-${process.pid}.json`);
  const state = { pid: process.pid, requests: 0, waitMs: 0, inFlight: 0, maxInFlight: 0 };
  let timer = null;
  const flush = () => { timer = null; try { fs.writeFileSync(file, JSON.stringify(state)); } catch { /* best effort */ } };
  globalThis.fetch = async function countedFetch(input, init) {
    let host = '';
    try { host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host; } catch { /* not a URL */ }
    if (!host.endsWith('.supabase.co')) return original.call(this, input, init);
    state.requests += 1; state.inFlight += 1; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const t = Date.now();
    try { return await original.call(this, input, init); } finally {
      state.inFlight -= 1; state.waitMs += Date.now() - t;
      if (!timer) timer = setTimeout(flush, 50);
    }
  };
}
