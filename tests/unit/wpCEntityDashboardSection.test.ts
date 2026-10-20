// DOCUMENT2 (4) review, WP-C, F28: the Dashboard entity section shows, for EVERY entity, its name, assets, liabilities and net economic value, then what is
// counted in the family figure. SMSF in full, Family Trust in full, HUF in full, Company by ownership share, individual first, family beside it.
// EVIDENCE LABEL: UNIT-TESTED (hand oracles, the real engine and the real panel rendered to static HTML). Not DEV-verified.
//
// HAND ORACLES (AUD): personal net worth 874,441. SMSF assets 503,000, liabilities 370,000, net 133,000, counted 133,000.
// Family Trust assets 1,000,000, liabilities 400,000, net 600,000, counted 600,000. HUF (same shape) 600,000 counted in full.
// Company assets 1,000,000, liabilities 750,000, net 250,000, ownership 40 percent, counted 100,000.
// Underwater trust: assets 100,000, liabilities 150,000, net -50,000, counted -50,000 (never clamped).
// Family = 874,441 + 133,000 + 600,000 + 600,000 + 100,000 - 50,000 = 2,257,441.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NetWorthLevelsPanel } from '@/components/dashboard/NetWorthLevelsPanel';
import { buildSmsfBalanceSheet } from '@/lib/engines/entityBalanceSheet';
import { computeNetWorthLevels, toNetWorthEntityInput, type NetWorthEntityInput, type NetWorthRowInput } from '@/lib/engines/netWorthLevels';
import type { BusinessEntityWithLineItems } from '@/lib/engines/businessEntityValuation';

const R = (r: Partial<NetWorthRowInput> & Pick<NetWorthRowInput, 'id' | 'register' | 'owner' | 'amountReporting'>): NetWorthRowInput => ({ name: r.id, currencyCode: 'AUD', ...r });
const PERSONAL: NetWorthRowInput[] = [
  R({ id: 'assets', register: 'assets', owner: 'self', amountReporting: 1_670_298 }),
  R({ id: 'inv', register: 'investments', owner: 'self', amountReporting: 590_000 }),
  R({ id: 'home', register: 'liabilities', owner: 'self', amountReporting: 600_000 }),
  R({ id: 'invloan', register: 'liabilities', owner: 'joint', amountReporting: 700_000 }),
  R({ id: 'car', register: 'liabilities', owner: 'spouse', amountReporting: 85_857 }),
];
const sheet = buildSmsfBalanceSheet({
  fund: { id: 'f', name: 'PO SMSF', mode: 'detailed', currency: 'AUD', retirementAccountId: 'ra', typedNetReporting: null, typedNetPresent: false },
  reportingCurrency: 'AUD',
  holdings: [{ id: 'h', name: 'Property and cash', holdingType: 'residential_property', value: 503_000, currency: 'AUD', valueReporting: 503_000 }],
  liabilities: [{ id: 'l', name: 'Loan', type: 'property_loan', lender: null, balance: 370_000, currency: 'AUD', balanceReporting: 370_000 }],
  linkedLoans: [],
});
const ENTITIES: NetWorthEntityInput[] = [
  { id: 't', name: 'Smith Family Trust', kind: 'family_trust', ownershipPercent: 100, netAssetValue: 600_000, detail: { assets: 1_000_000, liabilities: 400_000 } },
  { id: 'hf', name: 'Smith HUF', kind: 'huf', ownershipPercent: 100, netAssetValue: 600_000, detail: { assets: 1_000_000, liabilities: 400_000 } },
  { id: 'c', name: 'Smith Pty Ltd', kind: 'company', ownershipPercent: 40, netAssetValue: 250_000, detail: { assets: 1_000_000, liabilities: 750_000 } },
  { id: 'u', name: 'Underwater Trust', kind: 'family_trust', ownershipPercent: 100, netAssetValue: -50_000, detail: { assets: 100_000, liabilities: 150_000 } },
];
const levels = computeNetWorthLevels({ currency: 'AUD', rows: [...PERSONAL, R({ id: 'fund', register: 'retirement', owner: 'self', masterItemKey: 'smsf', amountReporting: 133_000 })], entitySheets: [sheet], entities: ENTITIES });
const html = renderToStaticMarkup(h(NetWorthLevelsPanel, { levels }));
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const block = (id: string) => levels.entities.blocks.find((b) => b.id === id)!;

describe('every entity carries its OWN assets, liabilities and net economic value, and what is counted', () => {
  it.each([
    ['tag:smsf', 503_000, 370_000, 133_000, 133_000],
    ['entity:t', 1_000_000, 400_000, 600_000, 600_000],
    ['entity:hf', 1_000_000, 400_000, 600_000, 600_000],
    ['entity:c', 1_000_000, 750_000, 250_000, 100_000],
    ['entity:u', 100_000, 150_000, -50_000, -50_000],
  ])('%s: assets %i, liabilities %i, net %i, counted in the family figure %i', (id, assets, liabilities, net, counted) => {
    const b = block(id);
    expect(b.entityTotals.totalAssets).toBe(assets);
    expect(b.entityTotals.liabilities).toBe(liabilities);
    expect(b.entityTotals.net).toBe(net);
    expect(b.included.net).toBe(counted);
  });

  it('individual first, family beside it: personal 874,441, family 2,257,441, and the reconciliation lists every kind', () => {
    expect(levels.personal.total.net).toBe(874_441);
    expect(levels.family.net).toBe(2_257_441);
    const lines = levels.reconciliation.map((l) => l.label);
    expect(lines).toEqual(expect.arrayContaining(['SMSF (in full)', 'Family Trust (in full)', 'HUF (in full)', 'Company (at ownership share)']));
  });

  it('Company by share (40 percent), Trust and HUF in full whatever percentage is recorded, SMSF in full', () => {
    expect(block('entity:c')).toMatchObject({ basis: 'ownership_share', includedPercent: 40 });
    expect(block('entity:t')).toMatchObject({ basis: 'full', includedPercent: 100 });
    expect(block('entity:hf')).toMatchObject({ basis: 'full', includedPercent: 100 });
    expect(block('tag:smsf')).toMatchObject({ includedPercent: 100 });
  });
});

describe('the Dashboard entity section (rendered)', () => {
  const t = text(html);
  it('has a column for each of assets, liabilities, net economic value and what is counted', () => {
    expect(t).toContain('Entities (kept separate from your personal figures)');
    for (const col of ['Assets', 'Liabilities', 'Net economic value', 'Counted in family']) expect(t).toContain(col);
  });
  it('shows each entity by kind and name with its own figures at 100 percent, and the company counted at 40 percent', () => {
    for (const label of ['SMSF: PO SMSF', 'Family Trust: Smith Family Trust', 'HUF: Smith HUF', 'Company: Smith Pty Ltd', 'Family Trust: Underwater Trust']) expect(t).toContain(label);
    expect(t).toContain('$1,000,000');
    expect(t).toContain('$750,000');
    expect(t).toContain('$250,000');
    expect(t).toContain('$100,000');
    expect(t).toContain('Your 40% share');
    expect(t).toMatch(/-\$50,000/);
    expect(html.match(/data-testid="net-worth-entity-row"/g)).toHaveLength(5);
  });
  it('does not add the entities\' own 100 percent figures into a misleading total row', () => {
    expect(text(html)).toContain('Own figures are shown at 100%, so they are not added up here');
  });
});

describe('recording: an entity recorded as a net value only says so instead of inventing assets and liabilities', () => {
  const company = (mode: 'summary' | 'detailed'): BusinessEntityWithLineItems => ({
    entity: { id: 'c2', user_id: 'u', entity_type: 'company', name: 'Net Only Co', country_code: null, currency_code: 'AUD', ownership_percentage: 40, valuation_mode: mode, summary_net_asset_value: mode === 'summary' ? 250_000 : null, is_active: true } as never,
    assets: mode === 'detailed' ? [{ value: 1_000_000, currency_code: 'AUD' }] : [],
    liabilities: mode === 'detailed' ? [{ value: 750_000, currency_code: 'AUD' }] : [],
  });
  it('net value only: recording net_only, net 250,000, counted 100,000, the table says "Recorded as a net value only"', () => {
    const input = toNetWorthEntityInput(company('summary'), 'AUD', 56)!;
    const l = computeNetWorthLevels({ currency: 'AUD', rows: PERSONAL, entities: [input] });
    expect(l.entities.blocks[0]).toMatchObject({ recording: 'net_only' });
    expect(l.entities.blocks[0].entityTotals.net).toBe(250_000);
    expect(l.entities.blocks[0].included.net).toBe(100_000);
    expect(text(renderToStaticMarkup(h(NetWorthLevelsPanel, { levels: l })))).toContain('Recorded as a net value only');
  });
  it('itemised: recording itemised with the derived 250,000, the same counted 100,000 (the two ways give one answer, never both)', () => {
    const input = toNetWorthEntityInput(company('detailed'), 'AUD', 56)!;
    const l = computeNetWorthLevels({ currency: 'AUD', rows: PERSONAL, entities: [input] });
    expect(l.entities.blocks[0]).toMatchObject({ recording: 'itemised' });
    expect(l.entities.blocks[0].entityTotals).toMatchObject({ totalAssets: 1_000_000, liabilities: 750_000, net: 250_000 });
    expect(l.entities.blocks[0].included.net).toBe(100_000);
  });
  it('NEGATIVE CONTROL: counting the company in full instead of by share WOULD change the family figure, so the 40 percent rule is what the oracle tests', () => {
    const inFull = computeNetWorthLevels({ currency: 'AUD', rows: PERSONAL, entities: [{ ...ENTITIES[2], kind: 'family_trust' }] });
    const byShare = computeNetWorthLevels({ currency: 'AUD', rows: PERSONAL, entities: [ENTITIES[2]] });
    expect(inFull.family.net - byShare.family.net).toBe(150_000);
  });
});
