// PC5 (M4) — exhaustive, read-only inventory of every RPC PostgREST exposes
// on DEV, so the "no DDL path" conclusion rests on the full list rather than
// on a guessed set of function names.
//
// PostgREST publishes an OpenAPI document at the REST root describing every
// exposed function. This reads it and prints the ones whose name or
// parameters look like they could execute arbitrary SQL. Writes nothing.
import fs from 'fs';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();

const url = pick('NEXT_PUBLIC_SUPABASE_URL');
const key = pick('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) {
  console.log('DEV credentials not present — cannot probe.');
  process.exit(0);
}

const res = await fetch(`${url}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
if (!res.ok) {
  console.log(`Could not read the PostgREST OpenAPI document: ${res.status} ${res.statusText}`);
  process.exit(0);
}
const spec = await res.json();
const rpcPaths = Object.keys(spec.paths ?? {}).filter((p) => p.startsWith('/rpc/'));
const names = rpcPaths.map((p) => p.slice('/rpc/'.length)).sort();

console.log(`=== DEV (${new URL(url).host}) — ${names.length} RPCs exposed ===\n`);

const SUSPICIOUS = /sql|exec|ddl|migrat|alter|create|admin_run|eval|raw/i;
const candidates = names.filter((n) => SUSPICIOUS.test(n));
console.log('RPCs whose name suggests arbitrary SQL / DDL execution:');
console.log(candidates.length === 0 ? '  (none)' : candidates.map((n) => `  ${n}`).join('\n'));

// Also check for a function taking a single free-text parameter, which is
// the shape an exec-style helper would have whatever it was called.
const freeTextSingleArg = [];
for (const p of rpcPaths) {
  const post = spec.paths[p]?.post;
  const params = post?.parameters ?? [];
  const body = params.find((x) => x.in === 'body');
  const props = body?.schema?.properties ?? {};
  const keys = Object.keys(props);
  if (keys.length === 1 && props[keys[0]]?.type === 'string' && /sql|statement|query|stmt|cmd/i.test(keys[0])) {
    freeTextSingleArg.push(`${p.slice('/rpc/'.length)}(${keys[0]})`);
  }
}
console.log('\nRPCs shaped like an exec helper (one free-text sql/query/statement argument):');
console.log(freeTextSingleArg.length === 0 ? '  (none)' : freeTextSingleArg.map((n) => `  ${n}`).join('\n'));

console.log(`\nFull RPC list (${names.length}):`);
console.log(names.map((n) => `  ${n}`).join('\n'));
