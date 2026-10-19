// Unit tests for the deploy-size guard (scripts/check-deploy-size.mjs, scripts/lib/deploySize.mjs).
// They run on a synthetic build directory, so they need no `next build` and cannot flake on machine load.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as lib from '../../scripts/lib/deploySize.mjs';

const root = path.resolve(__dirname, '..', '..');
let tmp = '';
let nextDir = '';

function put(rel: string, size: number) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(size, 1));
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-size-'));
  nextDir = path.join(tmp, '.next');
  // .next: 1000 shipped, 400 cache (deleted by amplify.yml), 300 server map (deleted), 50 static map (kept)
  put('.next/BUILD_ID', 10);
  put('.next/server/chunks/a.js', 500);
  put('.next/server/chunks/a.js.map', 300);
  put('.next/server/app/route.js', 490);
  put('.next/cache/webpack/x', 400);
  put('.next/static/chunks/c.js', 100);
  put('.next/static/chunks/c.js.map', 50);
  // traced files outside .next: two copies of semver, a big native package, one name listed twice, one absent
  put('node_modules/foo/index.js', 1000);
  put('node_modules/@scope/bar/lib/x.node', 4000);
  put('node_modules/semver/index.js', 70);
  put('node_modules/foo/node_modules/semver/index.js', 80);
  put('node_modules/@napi-rs/canvas-win32-x64-msvc/s.node', 500);
  put('package.json', 20);
  fs.writeFileSync(
    path.join(nextDir, 'next-server.js.nft.json'),
    JSON.stringify({
      version: 1,
      files: [
        '../node_modules/foo/index.js',
        '../node_modules/semver/index.js',
        '../node_modules/missing/never-installed.js',
        '../package.json',
        'server/chunks/a.js', // inside .next: already counted, must not be counted again
      ],
    })
  );
  fs.writeFileSync(
    path.join(nextDir, 'server', 'app', 'route.js.nft.json'),
    JSON.stringify({
      version: 1,
      files: [
        '../../../node_modules/@scope/bar/lib/x.node',
        '../../../node_modules/foo/index.js', // duplicate of the other trace
        '../../../node_modules/foo/node_modules/semver/index.js',
        '../../../node_modules/@napi-rs/canvas-win32-x64-msvc/s.node',
      ],
    })
  );
  // a nft file under cache/ is ignored (the build deletes the cache)
  fs.mkdirSync(path.join(nextDir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(nextDir, 'cache', 'stale.nft.json'), JSON.stringify({ version: 1, files: ['../../node_modules/semver/index.js', '../../huge'] }));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('isPrunedByAmplifyYml mirrors the two deletes in amplify.yml', () => {
  it('prunes cache/ and .map files outside static/, keeps everything else', () => {
    expect(lib.isPrunedByAmplifyYml('cache/webpack/x')).toBe(true);
    expect(lib.isPrunedByAmplifyYml('cache')).toBe(true);
    expect(lib.isPrunedByAmplifyYml('server/chunks/a.js.map')).toBe(true);
    expect(lib.isPrunedByAmplifyYml('build/chunks/b.js.map')).toBe(true);
    expect(lib.isPrunedByAmplifyYml('static/chunks/c.js.map')).toBe(false);
    expect(lib.isPrunedByAmplifyYml('server/chunks/a.js')).toBe(false);
    expect(lib.isPrunedByAmplifyYml('cache-like/file')).toBe(false);
  });

  it('amplify.yml still contains the deletes that the model assumes', () => {
    const yml = fs.readFileSync(path.join(root, 'amplify.yml'), 'utf8');
    expect(yml).toContain('- rm -rf .next/cache');
    expect(yml).toContain("- find .next -type f -name '*.map' -not -path '.next/static/*' -delete");
    expect(yml).toContain("- find node_modules/pdf-parse -type f -name '*.map' -delete");
  });
});

describe('measureDeploy', () => {
  it('sums .next after the deletes plus the union of traced files outside .next', () => {
    const m = lib.measureDeploy(nextDir);
    // .next: BUILD_ID 10 + a.js 500 + route.js 490 + c.js 100 + c.js.map 50 + 2 nft.json files (sizes counted too)
    const nftSizes = fs.statSync(path.join(nextDir, 'next-server.js.nft.json')).size + fs.statSync(path.join(nextDir, 'server/app/route.js.nft.json')).size;
    expect(m.nextBytes).toBe(10 + 500 + 490 + 100 + 50 + nftSizes);
    expect(m.nextPrunedByKind.cache).toBe(400 + fs.statSync(path.join(nextDir, 'cache', 'stale.nft.json')).size);
    expect(m.nextPrunedByKind.maps).toBe(300);
    // traced: foo 1000 + semver 70 + package.json 20 + bar 4000 + nested semver 80 + canvas 500; absent file and
    // in-.next file add nothing; duplicates are counted once.
    expect(m.tracedBytes).toBe(1000 + 70 + 20 + 4000 + 80 + 500);
    expect(m.tracedFiles).toBe(6);
    expect(m.totalBytes).toBe(m.nextBytes + m.tracedBytes);
  });

  it('with the prune model off, counts the cache and maps as they sit on disk', () => {
    const on = lib.measureDeploy(nextDir, { applyPrune: true });
    const off = lib.measureDeploy(nextDir, { applyPrune: false });
    expect(off.nextBytes - on.nextBytes).toBe(on.nextPrunedBytes);
    expect(off.nextPrunedBytes).toBe(0);
  });

  it('groups by package, flags packages installed twice, ranks by size', () => {
    const { packages } = lib.measureDeploy(nextDir);
    expect(packages.map((p: { name: string }) => p.name)).toEqual(['@scope/bar', 'foo', '@napi-rs/canvas-win32-x64-msvc', 'semver', '(not in node_modules)']);
    const semver = packages.find((p: { name: string }) => p.name === 'semver');
    expect(semver).toMatchObject({ bytes: 150, files: 2, copies: 2 });
    expect(lib.nonLinuxNativePackages(packages).map((p: { name: string }) => p.name)).toEqual(['@napi-rs/canvas-win32-x64-msvc']);
  });

  it('packageOf handles scopes, nesting and Windows separators', () => {
    expect(lib.packageOf('/a/node_modules/@x/y/z.js')).toBe('@x/y');
    expect(lib.packageOf('/a/node_modules/p/node_modules/q/i.js')).toBe('q');
    expect(lib.packageOf('C:\\a\\node_modules\\p\\i.js'.split('\\').join('/'))).toBe('p');
    expect(lib.packageOf('/a/package.json')).toBeNull();
  });
});

describe('judge', () => {
  it('reports margins and the two failure kinds separately', () => {
    expect(lib.judge(100, { budgetBytes: 150, limitBytes: 200 })).toEqual({ overBudget: false, overLimit: false, budgetMarginBytes: 50, limitMarginBytes: 100 });
    expect(lib.judge(160, { budgetBytes: 150, limitBytes: 200 })).toMatchObject({ overBudget: true, overLimit: false });
    expect(lib.judge(250, { budgetBytes: 300, limitBytes: 200 })).toMatchObject({ overBudget: false, overLimit: true });
  });
  it('the Amplify limit constant is the 220 MiB figure from the failure text', () => {
    expect(lib.AMPLIFY_MAX_BYTES).toBe(230686720);
    expect(lib.AMPLIFY_MAX_BYTES).toBe(220 * 1024 * 1024);
  });
});

describe('check-deploy-size CLI', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [path.join(root, 'scripts', 'check-deploy-size.mjs'), ...args], { encoding: 'utf8', timeout: 60000 });

  it('exits 0 inside the budget, 1 over it, 2 without a build', () => {
    expect(run(['--next-dir', nextDir, '--budget', '1000000']).status).toBe(0);
    const over = run(['--next-dir', nextDir, '--budget', '100']);
    expect(over.status).toBe(1);
    expect(over.stderr).toContain('exceeds the deploy-size budget');
    const none = run(['--next-dir', path.join(tmp, 'nope')]);
    expect(none.status).toBe(2);
  });

  it('prints machine readable output with --json', () => {
    const r = run(['--next-dir', nextDir, '--budget', '1000000', '--json']);
    const j = JSON.parse(r.stdout);
    expect(j.limitBytes).toBe(230686720);
    expect(j.totalBytes).toBe(j.nextBytes + j.tracedBytes);
  });

  it('the shipped budget stays below the Amplify limit minus the calibration gap seen in build #270', () => {
    const src = fs.readFileSync(path.join(root, 'scripts', 'check-deploy-size.mjs'), 'utf8');
    const budget = Number(/DEPLOY_BUDGET_BYTES = ([0-9_]+);/.exec(src)?.[1].replace(/_/g, ''));
    const CALIBRATION_GAP = 45_500_000; // Amplify reported 232,331,902 where the model said 186,842,218 (docs/ops/AMPLIFY_BUILD_SIZE_FIX_2026-10-01.md)
    expect(budget).toBeGreaterThan(0);
    expect(budget + CALIBRATION_GAP).toBeLessThan(lib.AMPLIFY_MAX_BYTES);
  });
});
