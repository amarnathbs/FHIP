// Run AFTER `next build`. Fails if any route that proxy.ts treats as a signed-in app route was prerendered as static. A static page is sent with a one-year shared-cache header, and a CDN in front of
// the app then serves it without running the proxy (the blank onboarding wizard on production, 26-11-2026). The route list is read from proxy.ts itself, so a new module is covered automatically.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const proxySource = fs.readFileSync(path.join(root, 'proxy.ts'), 'utf8');
const match = proxySource.match(/const isAppRoute = pathname\.match\(\s*\/(.+)\/\s*\);/);
if (!match) {
  console.error('check-protected-routes-dynamic: could not read the isAppRoute pattern from proxy.ts');
  process.exit(2);
}
const isAppRoute = new RegExp(match[1]);

const manifestPath = path.join(root, '.next', 'prerender-manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('check-protected-routes-dynamic: .next/prerender-manifest.json not found. Run the build first.');
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const prerendered = [...Object.keys(manifest.routes ?? {}), ...Object.keys(manifest.dynamicRoutes ?? {})];
const offending = prerendered.filter((route) => isAppRoute.test(route));

if (offending.length > 0) {
  console.error(`check-protected-routes-dynamic: FAILED. These signed-in routes are static and could be saved by the CDN: ${offending.join(', ')}`);
  console.error("Add `export const dynamic = 'force-dynamic';` to each page.");
  process.exit(1);
}
console.log(`check-protected-routes-dynamic: OK (${prerendered.length} prerendered routes, none is a signed-in app route)`);
