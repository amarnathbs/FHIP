/**
 * Synthetic-user allocator CLI (read-only against DEV).
 *
 *   node scripts/canonical_cert/users.mjs allocate      # re-derive ranges from the fixture files, resolve on
 *                                                        # DEV, write scripts/canonical_cert/USER_RANGES.json
 *   node scripts/canonical_cert/users.mjs show A        # print range A (email, DEV id, sign-in methods, gates)
 *
 * USER_RANGES.json holds no secret (emails + synthetic DEV ids + gate state). Passwords stay in the gitignored
 * fixture file and are read only at sign-in time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceClient, loadDevEnv } from './lib/env.mjs';
import { allocate, resolveOnDev, RANGES, RANGE_PORTS, HARNESS_RESERVED } from './lib/users.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'USER_RANGES.json');
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'allocate') {
  const { ref } = loadDevEnv();
  const resolved = await resolveOnDev(allocate(), await serviceClient());
  const all = Object.values(resolved).flat();
  const emails = all.map((u) => u.email);
  if (new Set(emails).size !== emails.length) throw new Error('allocation is not disjoint');
  const doc = {
    generatedAt: new Date().toISOString(), devProject: ref,
    note: 'Existing standing synthetic fixture users only. Ranges are disjoint. Each certifier uses ONLY its own range and its own port.',
    ports: RANGE_PORTS,
    harnessReserved: HARNESS_RESERVED,
    ranges: resolved,
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
  for (const r of RANGES) {
    const list = resolved[r];
    const fc = list.filter((u) => u.set === 'FCAST'); const e2 = list.filter((u) => u.set === 'E2E50');
    console.log(`${r} (port ${RANGE_PORTS[r]}): ${list.length} users -- FCAST ${fc.length} [AU ${fc.filter((u) => u.country === 'AU').length} / IN ${fc.filter((u) => u.country === 'IN').length}], E2E50 ${e2.length} [AU ${e2.filter((u) => u.country === 'AU').length} / IN ${e2.filter((u) => u.country === 'IN').length}]; missing on DEV ${list.filter((u) => !u.devUserId).length}; country-confirmed ${list.filter((u) => u.countryConfirmed).length}`);
  }
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
} else if (cmd === 'show' && RANGES.includes(arg)) {
  const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  for (const u of doc.ranges[arg]) {
    console.log([u.range, u.set, u.fixtureId, u.country, u.email, u.devUserId ?? 'NOT-ON-DEV', `signIn=${u.signIn.join('|')}`, `confirmed=${u.countryConfirmed}`, `members=${u.householdMembers}`].join('  '));
  }
} else {
  console.error('usage: users.mjs allocate | users.mjs show A|B|C|D');
  process.exit(1);
}
