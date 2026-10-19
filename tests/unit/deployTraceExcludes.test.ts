// Guards the output-tracing exclusions in next.config.mjs (docs/ops/AMPLIFY_ARTIFACT_SLIM_2026-10-18.md).
// Every exclusion removes files from the deployed artifact, so each one is coupled to a test that proves nothing
// in this repository can reach the excluded files at runtime.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import rawNextConfig from '../../next.config.mjs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nextConfig = rawNextConfig as unknown as Record<string, any>;

const root = path.resolve(__dirname, '..', '..');
const nodeRequire = createRequire(path.join(root, 'package.json'));
// The very matcher Next's collect-build-traces.js uses, with the very options it passes.
const picomatch = nodeRequire('next/dist/compiled/picomatch') as (g: string | string[], o: object) => (s: string) => boolean;

const excludes: string[] = nextConfig.outputFileTracingExcludes['*'];
const matches = (file: string) => picomatch(excludes, { contains: true, dot: true })(file);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('outputFileTracingExcludes (deploy artifact slimming)', () => {
  it('excludes exactly the reviewed groups, for every route and next-server', () => {
    expect(Object.keys(nextConfig.outputFileTracingExcludes)).toEqual(['*']);
    expect(excludes).toEqual([
      '**/node_modules/sharp/**/*',
      '**/node_modules/@img/**/*',
      '**/node_modules/playwright/**/*',
      '**/node_modules/playwright-core/**/*',
    ]);
    // '*' is what Next matches against both a route and the literal entry name `next-server`.
    expect(picomatch('*', { dot: true })('next-server')).toBe(true);
    expect(picomatch('*', { dot: true, contains: true })('/api/reports/[id]/exports')).toBe(true);
  });

  it('matches the sharp family and the Playwright packages on posix paths (the Linux build)', () => {
    for (const f of [
      '/build/node_modules/sharp/lib/index.js',
      '/build/node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node',
      '/build/node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.3',
      '/build/node_modules/@img/colour/color.cjs',
      '/build/node_modules/playwright-core/lib/coreBundle.js',
      '/build/node_modules/playwright-core/browsers.json',
      '/build/node_modules/playwright-core/lib/vite/recorder/index.js',
      '/build/node_modules/playwright/index.js',
    ]) {
      expect(matches(f), f).toBe(true);
    }
  });

  it('does not match anything a runtime path needs', () => {
    for (const f of [
      '/build/node_modules/@playwright/test/index.js',
      '/build/node_modules/@sparticuz/chromium/build/index.js',
      '/build/node_modules/puppeteer-core/lib/cjs/puppeteer/puppeteer-core.js',
      '/build/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      '/build/node_modules/@napi-rs/canvas/index.js',
      '/build/node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node',
      '/build/node_modules/pdf-parse/dist/node/cjs/index.cjs',
      '/build/node_modules/next/dist/server/next-server.js',
      '/build/node_modules/next/dist/server/image-optimizer.js',
      '/build/node_modules/@supabase/supabase-js/dist/index.mjs',
      '/build/node_modules/stripe/cjs/stripe.cjs.node.js',
      '/build/node_modules/razorpay/dist/razorpay.js',
      '/build/.next/server/app/api/reports/[id]/exports/route.js',
    ]) {
      expect(matches(f), f).toBe(false);
    }
  });

  it('keeps the PDF/CAS include list and the external packages untouched', () => {
    expect(Object.keys(nextConfig.outputFileTracingIncludes)).toEqual([
      '/api/investment-intelligence/source-documents/\\[id\\]/process',
      '/api/financial-data-hub/bank-pdf/\\[documentId\\]/process',
    ]);
    for (const list of Object.values(nextConfig.outputFileTracingIncludes) as string[][]) {
      expect(list).toEqual(['./node_modules/@napi-rs/canvas*/**/*', './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs']);
      // the includes and the excludes must not fight over the same files
      for (const inc of list) expect(matches(path.join(root, inc).split(path.sep).join('/'))).toBe(false);
    }
    expect(nextConfig.serverExternalPackages).toEqual(['pdf-parse', '@napi-rs/canvas']);
  });

  it('proves the sharp exclusion is safe: no source file can reach the Next image optimizer', () => {
    // /_next/image is only served for next/image (or a hand-written /_next/image URL); ImageResponse (next/og) does not
    // use sharp. If any of these appear, the sharp / @img exclusion must be removed first.
    const offenders: string[] = [];
    for (const top of ['app', 'components', 'lib', 'proxy.ts']) {
      const p = path.join(root, top);
      if (!fs.existsSync(p)) continue;
      const files = fs.statSync(p).isDirectory() ? sourceFiles(p) : [p];
      for (const f of files) {
        const text = fs.readFileSync(f, 'utf8');
        if (/from\s+['"]next\/image['"]|require\(['"]next\/image['"]\)|from\s+['"]sharp['"]|require\(['"]sharp['"]\)|next\/og|ImageResponse|\/_next\/image\?/.test(text)) {
          // proxy.ts only names the path inside a matcher exclusion regex; that is not a use.
          if (path.basename(f) === 'proxy.ts' && !/next\/image|ImageResponse|next\/og|sharp/.test(text)) continue;
          offenders.push(path.relative(root, f));
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(nextConfig.images).toBeUndefined();
  });

  it('proves the Playwright exclusion is safe: only the two lazily loaded renderers import it', () => {
    const importers: string[] = [];
    const staticImportersOfRenderers: string[] = [];
    for (const top of ['app', 'components', 'lib']) {
      for (const f of sourceFiles(path.join(root, top))) {
        const text = fs.readFileSync(f, 'utf8');
        const rel = path.relative(root, f).split(path.sep).join('/');
        if (/from\s+['"]playwright(-core)?['"]|require\(['"]playwright(-core)?['"]\)|import\(['"]playwright/.test(text)) importers.push(rel);
        // the renderers may only be reached through a dynamic import() so a missing package is a catchable failure
        if (/from\s+['"]@\/lib\/services\/(reportPdfRenderer|forecastReportPdfRenderer)['"]/.test(text)) staticImportersOfRenderers.push(rel);
      }
    }
    expect(importers.sort()).toEqual(['lib/services/forecastReportPdfRenderer.ts', 'lib/services/reportPdfRenderer.ts']);
    expect(staticImportersOfRenderers).toEqual([]);
  });
});
