/**
 * Owner-before-upload DEV certification, step 10: run the updated canonical-cert scenario scripts (they sign in as existing fixture
 * users and go through api(), which now injects a valid synthetic owner) on the localhost app and tabulate the outcome.
 *   node scripts/canonical_cert/final/obu_run_updated_scripts.mjs
 * Between scenarios the OBU3 residue ledger is cleaned and the two fixture users re-prepared, so each scenario starts from the baseline.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const E = 'forecast.tc015@example.test';
const A = 'forecast.tc024@example.test';
const env = { ...process.env, CERT_PORT: '3991' };
const run = (cmd, args, timeout = 900000) => spawnSync(cmd, args, { env, encoding: 'utf8', shell: process.platform === 'win32', timeout, maxBuffer: 64 * 1024 * 1024 });
const reset = () => {
  run('node', ['scripts/canonical_cert/residue.mjs', 'cleanup', '--ledger', 'OBU3']);
  for (const e of [E, A]) run('node', ['scripts/canonical_cert/residue.mjs', 'prepare', '--ledger', 'OBU3', '--email', e, '--port', '3991']);
};
const scenarios = [
  ['econ/scenario_payslip.ts (payslip first)', ['--order', 'payslip-first', '--email', E, '--attacker', A]],
  ['econ/scenario_payslip.ts (bank first)', ['--order', 'bank-first', '--email', E, '--attacker', A]],
  ['econ/scenario_card.ts', ['--email', E, '--attacker', A, '--salt', 'R7']],
  ['econ/scenario_loan.ts', ['--email', E, '--attacker', A, '--salt', 'R7']],
  ['econ/scenario_retirement.ts', ['--email', E, '--attacker', A, '--salt', 'R7']],
  ['econ/scenario_broker.ts', ['--email', E, '--attacker', A]],
  ['econ/scenario_unknown.ts', ['--email', E, '--attacker', A, '--salt', 'R7']],
];
const only = process.argv.slice(2);
const outFile = '.canonical-cert/obu-updated-scripts-results.json';
let rows = [];
try { rows = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* first write */ }
for (const [label, args] of scenarios) {
  if (only.length && !only.some((o) => label.includes(o))) continue;
  reset();
  const file = label.split(' ')[0];
  const r = run('npx', ['tsx', `scripts/canonical_cert/${file}`, ...args], 1800000);
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const summary = out.match(/(\d+)\/(\d+) checks passed/)?.[0] ?? (out.split('\n').filter((l) => /^(FAIL|Error)/.test(l)).slice(0, 2).join(' | ') || `exit ${r.status}`);
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 5);
  rows = rows.filter((x) => x.script !== label);
  rows.push({ script: label, result: summary, exit: r.status, fails });
  fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
  console.log(`${label}: ${summary}${fails.length ? '\n   ' + fails.join('\n   ') : ''}`);
}
reset();

