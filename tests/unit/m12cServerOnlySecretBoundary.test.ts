// M12C §13 (`M2-OPEN-4`) — the server-only secret boundary for AIE.
//
// The claim this suite defends is narrow and checkable: **no environment
// variable name that is a secret, and no module that reads one, can reach the
// browser bundle.** Before M12C that claim rested entirely on convention —
// there was no `import 'server-only'` anywhere in the repository, no lint rule,
// and no test. It happened to hold, which is not the same as being enforced.
//
// Every assertion here is a STATIC analysis of the repository's own source. No
// build is run and no bundle is produced, so this suite cannot and does not
// claim to have inspected a compiled `.next/static` chunk — it proves the
// properties from which that conclusion follows, and §13 of the M12C report
// states that distinction rather than implying more.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
    }
  };
  visit(dir);
  return out;
}

const rel = (p: string) => path.relative(repoRoot, p).replace(/\\/g, '/');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Names this repository treats as secrets. Anything on this list must never
 * acquire a `NEXT_PUBLIC_` twin and must never be read from client code. */
const SECRET_ENV_NAMES = [
  'AIE_OPENAI_API_KEY',
  'AIE_MASK_TOKEN_ENCRYPTION_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CRON_SECRET',
  'RESEND_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
] as const;

/** The AIE modules that read a secret directly. Kept as an explicit allowlist
 * so a NEW secret-reading module cannot appear unnoticed — the same idiom
 * `tests/unit/fdh1Isolation.test.ts` uses for its service-role allowlist. */
const AIE_SECRET_READING_MODULES = [
  'lib/aie/provider/providerFactory.ts',
  'lib/aie/provider/openaiAieProvider.ts',
  'lib/aie/masking/identifierToken.ts',
] as const;

const allSource = walk(path.join(repoRoot, 'lib'), ['.ts', '.tsx'])
  .concat(walk(path.join(repoRoot, 'app'), ['.ts', '.tsx']))
  .concat(walk(path.join(repoRoot, 'components'), ['.ts', '.tsx']));

describe('M12C §13 — no secret env name can reach the client bundle', () => {
  it('anti-vacuity: the scan really did find the repository source', () => {
    expect(allSource.length).toBeGreaterThan(300);
    expect(allSource.some((f) => rel(f) === 'lib/aie/provider/openaiAieProvider.ts')).toBe(true);
  });

  it('no `NEXT_PUBLIC_` twin exists for ANY secret, anywhere in the repository', () => {
    // A `NEXT_PUBLIC_X` for a secret `X` is inlined into the client bundle by
    // Next.js at build time — the single most likely way a secret ships to the
    // browser by accident.
    const offenders: string[] = [];
    for (const f of allSource) {
      const src = fs.readFileSync(f, 'utf8');
      for (const name of SECRET_ENV_NAMES) {
        if (src.includes(`NEXT_PUBLIC_${name}`)) offenders.push(`${rel(f)} -> NEXT_PUBLIC_${name}`);
      }
    }
    expect(offenders).toEqual([]);

    // And in the declared environment files, which are what an operator copies.
    for (const file of ['.env.example', 'ENVIRONMENT_VARIABLES.md']) {
      const src = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      for (const name of SECRET_ENV_NAMES) {
        expect(src.includes(`NEXT_PUBLIC_${name}`), `${file} declares a NEXT_PUBLIC_ twin of ${name}`).toBe(false);
      }
    }
    // Anti-vacuity: the scanner can actually detect the pattern it is looking
    // for, so `[]` above means "none found", not "nothing was checked".
    expect('NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY'.includes(`NEXT_PUBLIC_${SECRET_ENV_NAMES[2]}`)).toBe(true);
  });

  it('no `AIE_*` variable is ever exposed under a `NEXT_PUBLIC_` prefix', () => {
    const offenders: string[] = [];
    for (const f of allSource) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/NEXT_PUBLIC_AIE_[A-Z0-9_]+/g)) offenders.push(`${rel(f)} -> ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('no `use client` file reads ANY secret env name, directly or by string', () => {
    const clientFiles = allSource.filter((f) => /^\s*['"]use client['"]/.test(fs.readFileSync(f, 'utf8')));
    expect(clientFiles.length, 'anti-vacuity: there really are client components').toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const f of clientFiles) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      for (const name of SECRET_ENV_NAMES) {
        if (code.includes(name)) offenders.push(`${rel(f)} -> ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no `use client` file can reach a secret-reading AIE module, even transitively', () => {
    // The real property. A client component that imported, say,
    // `lib/aie/config.ts` would pull env-reading code into the browser graph;
    // one that reached `identifierToken.ts` would pull the HMAC master key
    // read itself.
    const byPath = new Map<string, string>();
    for (const f of allSource) byPath.set(rel(f).replace(/\.tsx?$/, ''), f);

    const resolve = (fromFile: string, spec: string): string | null => {
      let base: string;
      if (spec.startsWith('@/')) base = spec.slice(2);
      else if (spec.startsWith('.')) base = rel(path.resolve(path.dirname(fromFile), spec));
      else return null; // a package, not repository source
      base = base.replace(/\.tsx?$/, '');
      return byPath.get(base) ?? byPath.get(`${base}/index`) ?? null;
    };

    // Only VALUE imports matter: `import type` is erased at compile time and
    // pulls nothing into any bundle. This distinction is load-bearing — the two
    // AIE modules a client component does import today
    // (`lib/aie/review/ariaLabels.ts` and, through it, `lib/aie/review/types.ts`)
    // terminate in type-only imports, which is exactly why the boundary holds.
    const valueImportsOf = (file: string): string[] => {
      const src = fs.readFileSync(file, 'utf8');
      const specs: string[] = [];
      for (const m of src.matchAll(/^\s*import\s+(?!type\s)([\s\S]*?)from\s+['"]([^'"]+)['"]/gm)) {
        if (/^\s*\{\s*type\s/.test(m[1]) && !/,/.test(m[1])) continue;
        specs.push(m[2]);
      }
      for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);
      return specs;
    };

    const secretModules = new Set(AIE_SECRET_READING_MODULES.map(String));
    const clientFiles = allSource.filter((f) => /^\s*['"]use client['"]/.test(fs.readFileSync(f, 'utf8')));

    const violations: string[] = [];
    for (const entry of clientFiles) {
      const seen = new Set<string>();
      const stack = [entry];
      while (stack.length > 0) {
        const f = stack.pop()!;
        if (seen.has(f)) continue;
        seen.add(f);
        if (secretModules.has(rel(f))) {
          violations.push(`${rel(entry)} reaches ${rel(f)}`);
          break;
        }
        for (const spec of valueImportsOf(f)) {
          const target = resolve(f, spec);
          if (target) stack.push(target);
        }
      }
    }
    expect(violations).toEqual([]);

    // Anti-vacuity: the traversal genuinely walks edges rather than returning
    // immediately. At least one client file must reach more than itself.
    const probe = clientFiles.find((f) => valueImportsOf(f).some((s) => resolve(f, s) !== null));
    expect(probe, 'no client file resolved a single repository import — the traversal is vacuous').toBeDefined();
  });

  it('every AIE module that reads a secret imports the server-only guard', () => {
    // The enforcement the repository previously had none of.
    for (const modulePath of AIE_SECRET_READING_MODULES) {
      const src = fs.readFileSync(path.join(repoRoot, modulePath), 'utf8');
      expect(src, `${modulePath} must declare itself server-only`).toMatch(/import ['"]@\/lib\/serverOnly['"]/);
    }
  });

  it('the allowlist is exhaustive: no OTHER file under lib/aie reads a secret', () => {
    const aieFiles = walk(path.join(repoRoot, 'lib/aie'), ['.ts']);
    expect(aieFiles.length).toBeGreaterThan(30); // anti-vacuity
    const readers: string[] = [];
    for (const f of aieFiles) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (SECRET_ENV_NAMES.some((n) => new RegExp(`process\\.env\\.${n}\\b`).test(code))) readers.push(rel(f));
    }
    expect(readers.sort()).toEqual([...AIE_SECRET_READING_MODULES].sort());
  });
});

describe('M12C §13 — the declared environment surface matches the code', () => {
  const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

  it('every `AIE_*` name the code reads is declared in `.env.example`', () => {
    const used = new Set<string>();
    for (const f of allSource) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/process\.env\.(AIE_[A-Z0-9_]+)/g)) used.add(m[1]);
    }
    expect(used.size, 'anti-vacuity: AIE env reads were found').toBeGreaterThan(15);

    const declared = new Set([...envExample.matchAll(/^(AIE_[A-Z0-9_]+)=/gm)].map((m) => m[1]));
    const missing = [...used].filter((n) => !declared.has(n)).sort();
    expect(missing, 'these AIE_* variables are read by the code but undeclared in .env.example').toEqual([]);
  });

  it('`.env.example` records NO value for any AIE variable', () => {
    // The file is a name registry, never a secret store.
    for (const m of envExample.matchAll(/^(AIE_[A-Z0-9_]+)=(.*)$/gm)) {
      expect(m[2].trim(), `${m[1]} has a value in .env.example`).toBe('');
    }
  });

  it('`ENVIRONMENT_VARIABLES.md` documents both AIE secrets and marks them secret', () => {
    const doc = fs.readFileSync(path.join(repoRoot, 'ENVIRONMENT_VARIABLES.md'), 'utf8');
    for (const name of ['AIE_OPENAI_API_KEY', 'AIE_MASK_TOKEN_ENCRYPTION_KEY']) {
      const row = new RegExp(`\\\`${name}\\\`\\s*\\|\\s*\\*\\*Yes\\*\\*`).test(doc);
      expect(row, `${name} must appear in the table marked as a secret`).toBe(true);
    }
  });

  it("`ENVIRONMENT_VARIABLES.md`'s quoted Amplify forward list matches `amplify.yml` exactly", () => {
    // The old quotation was stale by six entries, which made the document
    // itself the source of a misleading "known gap". Pinned so it cannot drift
    // again.
    const doc = fs.readFileSync(path.join(repoRoot, 'ENVIRONMENT_VARIABLES.md'), 'utf8');
    const amplify = fs.readFileSync(path.join(repoRoot, 'amplify.yml'), 'utf8');
    const real = /env \| grep (-e [A-Z0-9_]+ ?)+>> \.env\.production/.exec(amplify.replace(/^\s*-\s*/gm, ''));
    expect(real, 'the amplify.yml forward line this test cites has moved').not.toBeNull();
    const realFlags = [...real![0].matchAll(/-e ([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
    const quoted = /env \| grep (?:-e [A-Z0-9_]+ ?)+>> \.env\.production/.exec(doc);
    expect(quoted, 'the quoted forward line was not found in ENVIRONMENT_VARIABLES.md').not.toBeNull();
    const quotedFlags = [...quoted![0].matchAll(/-e ([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
    expect(quotedFlags).toEqual(realFlags);
    expect(realFlags).toContain('AIE_'); // anti-vacuity: AIE really is forwarded
  });
});
