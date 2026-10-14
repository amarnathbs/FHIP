// Browser entry for scripts/a11y/sidebarAxe.mjs: renders the REAL components/ui/AppShell.tsx (the shared sidebar) with the
// Next router, Next Link and the Supabase browser client stubbed, so axe-core can scan the real markup in a real browser
// without a dev server, a login or any database. Nothing here is shipped.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '@/components/ui/AppShell';
import { NAV_HREF_MODULE_MAP } from '@/lib/nav/appNavCapability';

const cfg = window.__HARNESS__ || {};
const ADMIN = {
  isAdmin: true,
  capabilities: Object.fromEntries(
    [
      'resourcesDashboard',
      'resourceContentAdmin',
      'resourceWorkflowAdmin',
      'resourceDiscoveryAdmin',
      'resourceAnalytics',
      'referenceDataQuality',
      'lookthroughDataQuality',
      'marketIndexDataUpload',
      'benchmarkDataView',
      'benchmarkDataPublish',
      'benchmarkDataCorrect',
      'benchmarkCatalogueManage',
      'benchmarkEntitlementApprove',
      'entitlementManagement',
      'promoCodeManagement',
    ].map((k) => [k, true])
  ),
};
const DECISIONS = Object.fromEntries(Object.values(NAV_HREF_MODULE_MAP).map((m) => [m, 'ENABLED']));
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  const u = String(url);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('/api/admin/me')) return json({ data: cfg.admin ? ADMIN : { isAdmin: false, capabilities: {} } });
  if (u.includes('/api/capabilities/nav')) return json({ data: { decisions: DECISIONS } });
  return realFetch(url, init);
};

createRoot(document.getElementById('root')).render(
  <AppShell>
    <h1>Harness page</h1>
    <p>Page content for the accessibility scan.</p>
  </AppShell>
);
