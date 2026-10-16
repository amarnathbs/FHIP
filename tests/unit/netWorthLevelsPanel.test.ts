// Net Worth at two levels: presentation (PO decision 16-10-2026). EVIDENCE LABEL: UNIT-TESTED by rendering to static HTML (no DOM
// environment in this repository). The layout at 375 / 768 / 1280 px is checked separately in a real browser (see the design note).
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NetWorthLevelsPanel } from '@/components/dashboard/NetWorthLevelsPanel';
import { VitalSignsStrip } from '@/components/dashboard/VitalSignsStrip';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';
import { computeNetWorthLevels, type NetWorthEntityInput, type NetWorthRowInput } from '@/lib/engines/netWorthLevels';

const row = (r: Partial<NetWorthRowInput> & Pick<NetWorthRowInput, 'id' | 'register' | 'owner' | 'amountReporting'>): NetWorthRowInput => ({ name: r.id, ...r });

const PO_ROWS: NetWorthRowInput[] = [
  row({ id: 'house', register: 'assets', owner: 'self', amountReporting: 900_000 }),
  row({ id: 'cash', register: 'assets', owner: 'self', amountReporting: 60_298 }),
  row({ id: 'invprop', register: 'assets', owner: 'joint', amountReporting: 1_000_000 }),
  row({ id: 'car', register: 'assets', owner: 'spouse', amountReporting: 300_000 }),
  row({ id: 'smsf-fund', register: 'retirement', owner: 'self', amountReporting: 503_000 }),
  row({ id: 'other-ret', register: 'retirement', owner: 'smsf', amountReporting: 133_000 }),
  row({ id: 'homeloan', register: 'liabilities', owner: 'self', amountReporting: 600_000 }),
  row({ id: 'invloan', register: 'liabilities', owner: 'joint', amountReporting: 700_000 }),
  row({ id: 'carloan', register: 'liabilities', owner: 'spouse', amountReporting: 85_857 }),
];

const render = (levels: ReturnType<typeof computeNetWorthLevels>) => renderToStaticMarkup(h(NetWorthLevelsPanel, { levels }));
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('NetWorthLevelsPanel', () => {
  const levels = computeNetWorthLevels({ currency: 'AUD', rows: PO_ROWS, previouslyReported: 1_510_441 });
  const html = render(levels);
  const t = text(html);

  it('shows the personal level with each person, and the family level, with the oracle figures', () => {
    expect(t).toContain('Personal net worth');
    expect(t).toContain('$1,377,441');
    expect(t).toContain('Self');
    expect(t).toContain('$1,013,298');
    expect(t).toContain('Spouse/Partner');
    expect(t).toContain('$364,143');
    expect(t).toContain('Family net worth (consolidated)');
    expect(t).toContain('$1,510,441');
  });

  it('lists the SMSF as its own labelled entity row, in full, kept separate from the personal figures', () => {
    expect(t).toContain('Entities (kept separate from your personal figures)');
    expect(t).toMatch(/SMSF: SMSF/);
    expect(t).toContain('$133,000');
    expect(t).toContain('In full');
  });

  it('shows the family level as an explicit sum: personal + SMSF = family', () => {
    expect(t).toContain('Personal level (Self, Spouse/Partner, joint shares)');
    expect(t).toContain('+ SMSF (in full)');
    expect(t).toContain('= Family level (consolidated)');
  });

  it('explains each level in plain language, and the joint split rule', () => {
    expect(t).toContain('what you and your partner own and owe in your own names');
    expect(t).toContain('SMSF, family trusts and HUFs in full, and companies at your ownership share');
    expect(t).toContain('divided equally (50/50)');
  });

  it('uses the shared labelled, keyboard-focusable table region, real header cells and a text alternative', () => {
    expect(html).toMatch(/role="region"[^>]*aria-label="Personal net worth by person"[^>]*tabindex="0"/);
    expect(html).toMatch(/<th scope="col"[^>]*>Net worth<\/th>/);
    expect(html).toMatch(/<th scope="row"/);
    expect(html).toContain('aria-labelledby="nw-personal-heading"');
    expect(html).toContain('id="nw-personal-heading"');
  });

  it('no ISO or US-order dates appear anywhere in the markup (day-first rule)', () => {
    expect(html).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(html).not.toMatch(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/);
  });

  it('without entities there is no entities section, and the family level says it equals the personal level', () => {
    const none = computeNetWorthLevels({ currency: 'AUD', rows: PO_ROWS.filter((r) => r.owner !== 'smsf') });
    const nt = text(render(none));
    expect(nt).not.toContain('Entities (kept separate');
    expect(nt).toContain('$1,377,441');
  });

  it('shows the bridge to the previously reported figure when a rule changed it, and flags an unexplained difference', () => {
    const entities: NetWorthEntityInput[] = [{ id: 'tr', name: 'Smith Family Trust', kind: 'family_trust', ownershipPercent: 50, netAssetValue: 300_000, detail: null }];
    const bridged = computeNetWorthLevels({ currency: 'AUD', rows: PO_ROWS, entities, previouslyReported: 1_510_441 + 150_000 });
    const bt = text(render(bridged));
    expect(bt).toContain('previously reported as $1,660,441');
    expect(bt).toContain('Family Trust / HUF now counted in full');
    expect(bt).toContain('-$150,000');
    expect(bt).toContain('In full'); // the trust is counted in full despite the 50% recorded
    const broken = computeNetWorthLevels({ currency: 'AUD', rows: PO_ROWS, previouslyReported: 1_400_000 });
    expect(text(render(broken))).toContain('Check: Difference not explained by the rules above');
  });

  it('negative control: dropping the SMSF row makes the family total change, so the panel would not read 1,510,441', () => {
    const dropped = computeNetWorthLevels({ currency: 'AUD', rows: PO_ROWS.filter((r) => r.id !== 'other-ret') });
    expect(text(render(dropped))).not.toContain('$1,510,441');
  });

  it('shows the double-entry warning and the unconverted-items note when they apply', () => {
    const dup = computeNetWorthLevels({
      currency: 'AUD',
      rows: [row({ id: 'x', register: 'assets', owner: 'company', amountReporting: 10_000 }), row({ id: 'y', register: 'assets', owner: 'self', amountReporting: null, currencyCode: 'USD' })],
      entities: [{ id: 'co', name: 'Acme', kind: 'company', ownershipPercent: 100, netAssetValue: 5, detail: null }],
    });
    const dt = text(render(dup));
    expect(dt).toContain('Check: You have items tagged');
    expect(dt).toContain('1 item is in a currency that cannot be converted');
  });
});

describe('Dashboard Net Worth card (individual-first, family beside it)', () => {
  const base: DashboardInput = { income: [], expenses: [], assets: [], liabilities: [], investments: [], retirement: [], insurance: [], goals: [], snapshots: [] };
  it('shows the personal figure as the headline and the family figure on the line below', () => {
    const summary = computeDashboard(base, 'AUD');
    summary.netWorthLevels = computeNetWorthLevels({ currency: 'AUD', rows: PO_ROWS });
    const t = text(renderToStaticMarkup(h(VitalSignsStrip, { summary })));
    expect(t).toContain('Net Worth (personal)');
    expect(t).toContain('$1,377,441');
    expect(t).toContain('Family level incl. SMSF, trusts and companies: $1,510,441');
  });
  it('without the model the card is the single previously reported figure with its original label', () => {
    const summary = computeDashboard({ ...base, assets: [{ current_value: 5_000, asset_class: 'cash', currency_code: 'AUD' }] }, 'AUD');
    const t = text(renderToStaticMarkup(h(VitalSignsStrip, { summary })));
    expect(t).toContain('Net Worth');
    expect(t).not.toContain('Net Worth (personal)');
    expect(t).toContain('$5,000');
  });
});
