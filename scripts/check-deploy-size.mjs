#!/usr/bin/env node
// Deploy-artifact size guard.  Usage (after `npm run build`):
//   npm run check:deploy-size
//   node scripts/check-deploy-size.mjs --top 40 --json
//   node scripts/check-deploy-size.mjs --budget 160000000        (override the budget constant)
//   node scripts/check-deploy-size.mjs --no-prune-model          (size `.next` as it is on disk, ignore amplify.yml deletes)
//
// Exit codes: 0 within budget, 1 over budget or over the Amplify limit, 2 no build output to measure.
// Deterministic: it only reads the finished build output, so it cannot flake. See scripts/lib/deploySize.mjs for
// exactly what is modelled and how far the number can be trusted (it is a MODEL of Amplify's packager).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AMPLIFY_MAX_BYTES, formatBytes, judge, measureDeploy, nonLinuxNativePackages } from './lib/deploySize.mjs';

/**
 * Budget for the MODELLED size (docs/ops/AMPLIFY_ARTIFACT_SLIM_2026-10-18.md). Measured after slimming on the Windows
 * dev machine: 84,427,436 bytes; the budget leaves about 25 MB of normal growth room. Raising it is a deliberate act
 * to review against the Amplify hard limit: budget + ~45.5 MB (the amount by which the model under-reported Amplify's
 * real figure in build #270) must stay below AMPLIFY_MAX_BYTES (tests/unit/deploySizeGuard.test.ts enforces that).
 * A bundled Chromium (about 70 MB) does NOT fit this budget on purpose: shipping it needs an explicit raise.
 */
export const DEPLOY_BUDGET_BYTES = 110_000_000;

function parseArgs(argv) {
  const o = { top: 40, json: false, prune: true, budget: null, nextDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--no-prune-model') o.prune = false;
    else if (a === '--top') o.top = Number(argv[++i]);
    else if (a === '--budget') o.budget = Number(argv[++i]);
    else if (a === '--next-dir') o.nextDir = argv[++i];
  }
  return o;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const nextDir = path.resolve(opts.nextDir ?? path.join(here, '..', '.next'));
  if (!fs.existsSync(path.join(nextDir, 'BUILD_ID'))) {
    console.error(`No finished build at ${nextDir} (BUILD_ID missing). Run \`npm run build\` first.`);
    process.exit(2);
  }
  const budget = opts.budget ?? DEPLOY_BUDGET_BYTES;
  const m = measureDeploy(nextDir, { applyPrune: opts.prune });
  const verdict = judge(m.totalBytes, { budgetBytes: budget });

  if (opts.json) {
    console.log(JSON.stringify({ limitBytes: AMPLIFY_MAX_BYTES, budgetBytes: budget, ...m, packages: m.packages.slice(0, opts.top), verdict }, null, 2));
  } else {
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`.next shipped (after amplify.yml deletes): ${formatBytes(m.nextBytes)} in ${m.nextFiles} files`);
    console.log(`  deleted by amplify.yml: cache ${formatBytes(m.nextPrunedByKind.cache)}, server maps ${formatBytes(m.nextPrunedByKind.maps)}`);
    console.log(`traced files outside .next (union of *.nft.json): ${formatBytes(m.tracedBytes)} in ${m.tracedFiles} files`);
    console.log(`MODELLED DEPLOY SIZE: ${formatBytes(m.totalBytes)}`);
    console.log(`  budget ${formatBytes(budget)} -> margin ${formatBytes(verdict.budgetMarginBytes)}`);
    console.log(`  Amplify limit ${formatBytes(AMPLIFY_MAX_BYTES)} -> margin ${formatBytes(verdict.limitMarginBytes)}`);
    console.log(`\n.next buckets:`);
    for (const b of m.nextByBucket.slice(0, 12)) console.log(`  ${pad(b.name, 28)} ${b.bytes.toLocaleString('en-US').padStart(14)}`);
    console.log(`\ntop ${opts.top} traced packages:`);
    for (const p of m.packages.slice(0, opts.top)) {
      console.log(`  ${pad(p.name, 44)} ${p.bytes.toLocaleString('en-US').padStart(14)}  files=${p.files}${p.copies > 1 ? `  COPIES=${p.copies}` : ''}`);
    }
    const foreign = nonLinuxNativePackages(m.packages);
    if (foreign.length) {
      console.log(`\nNOTE: traced native packages for another platform than Amplify's Linux: ${foreign.map((p) => p.name).join(', ')}`);
      console.log('      their sizes differ from the Linux builds Amplify will ship; treat the total as approximate.');
    }
  }
  if (verdict.overLimit) {
    console.error(`FAIL: modelled size exceeds the Amplify limit of ${AMPLIFY_MAX_BYTES} bytes.`);
    process.exit(1);
  }
  if (verdict.overBudget) {
    console.error(`FAIL: modelled size ${m.totalBytes} exceeds the deploy-size budget ${budget} by ${-verdict.budgetMarginBytes} bytes.`);
    process.exit(1);
  }
}
