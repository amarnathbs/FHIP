/**
 * Renders the upload-entitlement inventory (lib/entitlements/financialImportInventory.ts) as the Markdown matrix
 * committed in docs/entitlements/PREMIUM_UPLOAD_ENTITLEMENT.md. A test (premiumUploadInventoryContract) fails when the
 * committed matrix differs from this output, so the documentation cannot drift from the code.
 *
 * Regenerate:  npx tsx -e "import('./lib/entitlements/inventoryMatrix').then(m=>console.log(m.renderInventoryMatrixMarkdown()))"
 */
import {
  ADMIN_AND_SYSTEM_EXEMPT_PREFIXES,
  GATED_ROUTES,
  MANUAL_ENTRY_ROUTE_DIRS,
  REVIEW_CONTINUATION_ROUTES,
  inventoryCounts,
} from './financialImportInventory';

export const MATRIX_BEGIN = '<!-- BEGIN GENERATED INVENTORY MATRIX -->';
export const MATRIX_END = '<!-- END GENERATED INVENTORY MATRIX -->';

const routeOf = (file: string) => file.replace(/^app\/api\//, '/api/').replace(/\/route\.ts$/, '');

export function renderInventoryMatrixMarkdown(): string {
  const c = inventoryCounts();
  const lines: string[] = [];
  lines.push(MATRIX_BEGIN);
  lines.push('');
  lines.push(`**Counts:** ${c.gatedRoutes} gated routes (${c.admissionRoutes} admission, ${c.runStartRoutes} run-start); ${c.reviewContinuationRoutesExempt} review/apply/delete routes deliberately NOT gated; ${c.adminAndSystemExemptPrefixes} Admin/system route families exempt; ${c.manualEntryRouteDirs} manual-entry route families that must stay Free.`);
  lines.push('');
  lines.push('### Gated routes (Free: refused 403 PREMIUM_REQUIRED, or 503 ENTITLEMENT_UNAVAILABLE; Premium: unchanged)');
  lines.push('');
  lines.push('| # | Surface id | Guard | Route (POST) | Domain | UI caller | Storage / job | Downstream canonical destination |');
  lines.push('|---|---|---|---|---|---|---|---|');
  GATED_ROUTES.forEach((r, i) => {
    lines.push(`| ${i + 1} | \`${r.surface}\` | ${r.guard === 'admission' ? 'Admission' : 'Run start'} | \`${routeOf(r.file)}\` | ${r.domain} | ${r.ui ? `\`${r.ui}\`` : 'API only (no UI caller)'} | ${r.storage} | ${r.downstream} |`);
  });
  lines.push('');
  lines.push('### Deliberately NOT gated: review / correct / approve / apply / delete (downgrade must not strand data; privacy is never Premium)');
  lines.push('');
  lines.push('| Route | Why |');
  lines.push('|---|---|');
  for (const r of REVIEW_CONTINUATION_ROUTES) lines.push(`| \`${routeOf(r.file)}\` | ${r.reason} |`);
  lines.push('');
  lines.push('### Exempt: Admin staff and system jobs (governed by Admin capabilities / shared secrets, never by the consumer plan)');
  lines.push('');
  lines.push('| Route family | Why |');
  lines.push('|---|---|');
  for (const e of ADMIN_AND_SYSTEM_EXEMPT_PREFIXES) lines.push(`| \`${e.prefix.replace(/^app\/api\//, '/api/')}\` | ${e.reason} |`);
  lines.push('');
  lines.push('### Manual entry (must stay Free; must never call the import capability)');
  lines.push('');
  lines.push(MANUAL_ENTRY_ROUTE_DIRS.map((d) => `\`${d.replace(/^app\/api\//, '/api/')}\``).join(', '));
  lines.push('');
  lines.push(MATRIX_END);
  return lines.join('\n');
}
