// Repository dependency / typings integrity (Document2 closure, 2026-10-01).
//
// WHY THIS EXISTS. A Pass-2 agent reported `TS7016: Could not find a
// declaration file for module 'stripe'` in three payment files "even from a
// clean npm ci". On the healthy shared install that does NOT reproduce:
// package.json (^22.6.1), package-lock.json (22.6.1) and node_modules/stripe
// (22.6.1) agree, and the package ships its own typings through its `exports`
// map (`default.import.types` -> esm/stripe.esm.node.d.ts), which TypeScript's
// `moduleResolution: "bundler"` (this repo's tsconfig) resolves. The only way
// to get exactly that TS7016 for the declared version is an installed
// node_modules/stripe whose .d.ts files are missing (an incomplete / truncated
// install) — reproduced deliberately in the closure report with a copy of the
// package with its declaration files deleted.
//
// This test turns that situation into an immediate, precise failure: it asks
// the TypeScript compiler itself (with the repo's own compiler options) how it
// resolves each typed third-party dependency the payment / PDF / spreadsheet /
// accessibility code relies on, and fails with the offending package name if
// any of them resolves to untyped JavaScript — which is the TS7016 condition.
//
// It also checks the declared / locked / installed versions agree.

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();

const PACKAGES = ['stripe', 'razorpay', 'pdf-parse', 'xlsx', '@axe-core/playwright'] as const;

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function findInstalledPackageJson(name: string): string | null {
  let dir = ROOT;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const pkg = readJson(path.join(ROOT, 'package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const lock = readJson(path.join(ROOT, 'package-lock.json')) as { packages: Record<string, { version?: string }> };

function compilerOptions(): ts.CompilerOptions {
  const cfg = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  return ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT).options;
}

describe('typed third-party dependencies resolve to declaration files (the TS7016 condition)', () => {
  const options = compilerOptions();
  const importer = path.join(ROOT, 'lib/services/payments/stripeClient.ts');

  it.each(PACKAGES)('%s resolves to a .d.ts with the repo tsconfig', (name) => {
    expect(options.moduleResolution, 'the repo tsconfig must keep moduleResolution=bundler for the typings assumptions below').toBe(ts.ModuleResolutionKind.Bundler);
    const resolved = ts.resolveModuleName(name, importer, options, ts.sys).resolvedModule;
    expect(resolved, `${name} did not resolve at all — is node_modules complete?`).toBeTruthy();
    expect(
      resolved!.extension,
      `${name} resolved to ${resolved!.resolvedFileName} (${resolved!.extension}) — an untyped JavaScript file. This is exactly what produces TS7016 "Could not find a declaration file for module '${name}'"; the installed package is missing its declaration files.`
    ).toBe('.d.ts');
    expect(existsSync(resolved!.resolvedFileName)).toBe(true);
  });
});

describe('declared, locked and installed versions of the typed dependencies agree', () => {
  it.each(PACKAGES)('%s: package.json range matches package-lock.json, and node_modules matches the lock', (name) => {
    const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
    expect(declared, `${name} is not declared in package.json`).toBeTruthy();
    const locked = lock.packages[`node_modules/${name}`]?.version;
    expect(locked, `${name} is not in package-lock.json`).toBeTruthy();
    // ^x.y.z : same major, locked >= declared floor.
    const floor = declared!.replace(/^[\^~]/, '').split('.').map(Number);
    const lockedParts = locked!.split('.').map(Number);
    expect(lockedParts[0], `${name}: locked major differs from declared range ${declared}`).toBe(floor[0]);
    const cmp = lockedParts[0] * 1e12 + lockedParts[1] * 1e6 + lockedParts[2] - (floor[0] * 1e12 + floor[1] * 1e6 + floor[2]);
    expect(cmp, `${name}: locked ${locked} is below declared floor ${declared}`).toBeGreaterThanOrEqual(0);
    const installedPath = findInstalledPackageJson(name);
    expect(installedPath, `${name} is not installed`).toBeTruthy();
    expect((readJson(installedPath!) as { version: string }).version, `${name}: installed version differs from the lockfile`).toBe(locked);
  });
});

describe('NEGATIVE CONTROL: the detector really distinguishes typed from untyped installs', () => {
  // A synthetic package laid out exactly like stripe 22 (typings only reachable
  // through the exports map). With its .d.ts present it must resolve typed;
  // with the .d.ts deleted (the incomplete-install failure mode) it must
  // resolve to untyped JavaScript — the TS7016 condition.
  function makeFakeInstall(withDeclarations: boolean): { dir: string; importer: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fhip-dep-types-'));
    const pkgDir = path.join(dir, 'node_modules', 'fakestripe');
    mkdirSync(path.join(pkgDir, 'esm'), { recursive: true });
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'fakestripe', version: '1.0.0', main: 'esm/index.js', exports: { default: { import: { types: './esm/index.d.ts', default: './esm/index.js' } } } })
    );
    writeFileSync(path.join(pkgDir, 'esm', 'index.js'), 'export default class Fake {}\n');
    if (withDeclarations) writeFileSync(path.join(pkgDir, 'esm', 'index.d.ts'), 'export default class Fake {}\n');
    const importer = path.join(dir, 'index.ts');
    writeFileSync(importer, "import Fake from 'fakestripe';\n");
    return { dir, importer };
  }

  it('resolves .d.ts when the declaration files are present', () => {
    const { dir, importer } = makeFakeInstall(true);
    try {
      expect(ts.resolveModuleName('fakestripe', importer, compilerOptions(), ts.sys).resolvedModule?.extension).toBe('.d.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves untyped .js when the declaration files are missing — the exact TS7016 condition the real assertions above would fail on', () => {
    const { dir, importer } = makeFakeInstall(false);
    try {
      expect(ts.resolveModuleName('fakestripe', importer, compilerOptions(), ts.sys).resolvedModule?.extension).toBe('.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
