/**
 * Owner-class UI (2026-10-01): the selector bar, the Overview breakup tables with the explicit
 * macro line, and the wiring of every analysis tab. No jsdom in this repo: markup is rendered with
 * react-dom/server and the wiring is asserted structurally; clicking a chip is NOT executed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OwnerBreakupTable, type OwnerBreakupPayload } from '@/components/investment-intelligence/OwnerBreakupTable';
import { OwnerClassBar } from '@/components/investment-intelligence/OwnerClassBar';
import { ALL_OWNER_CLASSES, ownerClassOptionLabel, withOwnerClass, type OwnerClassOption } from '@/components/investment-intelligence/ownerClassUi';
import { buildOwnerBreakup, classifyOwnership, type OwnerLabels } from '@/lib/services/investment-intelligence/ownerClass';
import { deriveAccountOwnership } from '@/lib/services/investment-intelligence/ownerModel';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('withOwnerClass', () => {
  it('adds nothing for the consolidated default; appends with ? or & and encodes the key', () => {
    expect(withOwnerClass('/api/x', ALL_OWNER_CLASSES)).toBe('/api/x');
    expect(withOwnerClass('/api/x', '')).toBe('/api/x');
    expect(withOwnerClass('/api/x', 'entity:abc')).toBe('/api/x?ownerClass=entity%3Aabc');
    expect(withOwnerClass('/api/x?taxpayerType=A', 'joint')).toBe('/api/x?taxpayerType=A&ownerClass=joint');
  });
});

const classes: OwnerClassOption[] = [
  { key: 'member:m1', kind: 'personal', label: 'Asha Rao', detail: 'You', accountCount: 2 },
  { key: 'joint', kind: 'joint', label: 'Jointly owned (household members)', detail: null, accountCount: 1 },
  { key: 'entity:e1', kind: 'entity', label: 'Rao Family Trust', detail: 'Family trust', accountCount: 1 },
];
const bar = (value: string, cs: OwnerClassOption[] = classes) => renderToStaticMarkup(createElement(OwnerClassBar, { value, onChange: () => undefined, classes: cs }));

describe('OwnerClassBar', () => {
  it('default: the explicit "Consolidated (macro view only)" chip is pressed, every class has its own chip, and the text says entity holdings are not in a personal total', () => {
    const html = bar(ALL_OWNER_CLASSES);
    expect(html).toContain('View by owner class');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Consolidated \(macro view only\)</);
    expect(html).toContain('Asha Rao (You)');
    expect(html).toContain('Rao Family Trust (Family trust)');
    expect(html).toContain('not part of your personal total');
  });
  it('a chosen class is pressed instead, and the text says it is not added to any other class', () => {
    const html = bar('entity:e1');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Rao Family Trust \(Family trust\)</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Consolidated/);
    expect(html).toContain('not added to any other class');
  });
  it('NEGATIVE CONTROL [nothing to choose]: with one class (or none) the bar is not rendered at all', () => {
    expect(bar(ALL_OWNER_CLASSES, [classes[0]])).toBe('');
    expect(bar(ALL_OWNER_CLASSES, [])).toBe('');
  });
  it('option labels', () => {
    expect(ownerClassOptionLabel(classes[1])).toBe('Jointly owned (household members)');
  });
});

describe('OwnerBreakupTable (Overview)', () => {
  const labels: OwnerLabels = {
    member: (id) => ({ m1: { name: 'Asha Rao', relationship: 'self' }, m2: { name: 'Ravi Rao', relationship: 'spouse' } } as Record<string, { name: string; relationship: string }>)[id],
    entity: (id) => ({ e1: { name: 'Rao Family Trust', entityType: 'family_trust' } } as Record<string, { name: string; entityType: string }>)[id],
  };
  const own = (rows: { m?: string; e?: string; bp: number }[], ptr: string | null = null) =>
    deriveAccountOwnership(ptr, rows.map((r) => ({ owner_member_id: r.m ?? null, owner_business_entity_id: r.e ?? null, allocation_basis_points: r.bp, ii_instrument_id: null, status: 'active' })));
  const breakup = buildOwnerBreakup(
    [
      { id: 'a1', ownership: own([], 'm1') },
      { id: 'a2', ownership: own([{ m: 'm1', bp: 6000 }, { m: 'm2', bp: 4000 }]) },
      { id: 'a3', ownership: own([{ e: 'e1', bp: 10000 }]) },
    ],
    [
      { accountId: 'a1', currencyCode: 'INR', value: 100_000 },
      { accountId: 'a2', currencyCode: 'INR', value: 1_000_000 },
      { accountId: 'a3', currencyCode: 'INR', value: 500_000 },
    ],
    labels
  );
  const html = renderToStaticMarkup(createElement(OwnerBreakupTable, { breakup: breakup as unknown as OwnerBreakupPayload }));

  it('separate tables per owner kind, in order, each with its own totals', () => {
    for (const h of ['Personal', 'Joint (household members)', 'Trust / HUF / Company']) expect(html).toContain(h);
    expect(html.indexOf('Personal')).toBeLessThan(html.indexOf('Joint (household members)'));
    expect(html.indexOf('Joint (household members)')).toBeLessThan(html.indexOf('Trust / HUF / Company'));
    expect(html.match(/<table/g)?.length).toBe(3);
    expect(html).toContain('Rao Family Trust');
  });

  it('the joint row lists each owner\'s part divided by the split (hand-computed 600,000 / 400,000)', () => {
    expect(html).toMatch(/Asha Rao: [^<]*6,00,000/);
    expect(html).toMatch(/Ravi Rao: [^<]*4,00,000/);
  });

  it('NEGATIVE CONTROL [never silently summed]: the personal table does not contain the trust, and the macro line is separate, labelled and explained', () => {
    const personalTable = html.slice(html.indexOf('Personal'), html.indexOf('Joint (household members)'));
    expect(personalTable).not.toContain('Rao Family Trust');
    expect(personalTable).not.toContain('15,00,000'); // the consolidated total never appears in a class table
    const macro = html.slice(html.indexOf('data-testid="owner-breakup-macro"'));
    expect(macro).toContain('Consolidated (macro view only)');
    expect(macro).toContain('not your personal total');
    expect(macro).toContain('16,00,000'); // 100,000 + 1,000,000 + 500,000, each once
    expect(macro).toContain('3 accounts');
  });
});

describe('classifyOwnership is what the table and the selector share', () => {
  it('keeps the class key format the API accepts', () => {
    const labels: OwnerLabels = { member: () => ({ name: 'A', relationship: 'self' }), entity: () => undefined };
    expect(classifyOwnership(deriveAccountOwnership('m1', []), labels).key).toBe('member:m1');
  });
});

describe('every analysis tab is wired to the owner-class selector (structural)', () => {
  const tabs: [string, string, string[]][] = [
    ['PerformanceClient', 'components/investment-intelligence/PerformanceClient.tsx', ["withOwnerClass('/api/investment-intelligence/analytics', ownerClass)", '<HoldingsTable ownerClass={ownerClass} />']],
    ['SipIntelligenceClient', 'components/investment-intelligence/SipIntelligenceClient.tsx', ["withOwnerClass('/api/investment-intelligence/sip', ownerClass)"]],
    ['PortfolioXrayClient', 'components/investment-intelligence/PortfolioXrayClient.tsx', ["withOwnerClass('/api/investment-intelligence/xray', ownerClass)", "withOwnerClass('/api/investment-intelligence/xray/overlap', ownerClass)"]],
    ['TaxIntelligenceClient', 'components/investment-intelligence/TaxIntelligenceClient.tsx', ["`/api/investment-intelligence/tax/summary${qs}`, ownerClass", "withOwnerClass('/api/investment-intelligence/tax/lots', ownerClass)"]],
  ];
  it.each(tabs)('%s shows the bar, defaults to the consolidated view, re-mounts per class and fetches with ownerClass', (name, file, needles) => {
    const src = read(file);
    expect(src).toContain('<OwnerClassBar value={ownerClass} onChange={setOwnerClass} />');
    expect(src).toContain('useState(ALL_OWNER_CLASSES)');
    expect(src).toContain(`<${name}Inner key={ownerClass} ownerClass={ownerClass} />`);
    for (const n of needles) expect(src).toContain(n);
  });
  it('the Overview shows every class as its own table via OwnerBreakupTable and keeps its unscoped fetch (no selector needed)', () => {
    const src = read('components/investment-intelligence/OverviewClient.tsx');
    expect(src).toContain('<OwnerBreakupTable breakup={data.ownerBreakup} />');
    expect(src).toContain("fetch('/api/investment-intelligence/overview')");
  });
  it('the Holdings table and the API route accept the same key', () => {
    expect(read('components/investment-intelligence/HoldingsTable.tsx')).toContain('holdings?ownerClass=');
    for (const r of ['sip', 'xray', 'xray/overlap', 'xray/data-quality', 'tax/summary', 'tax/lots', 'analytics', 'holdings', 'overview']) {
      expect(read(`app/api/investment-intelligence/${r}/route.ts`), r).toContain('resolveOwnerClassScope(');
    }
  });
  it('NEGATIVE CONTROL [no persistence from a scoped run]: the three persisting routes skip persistence when a class is active', () => {
    expect(read('app/api/investment-intelligence/sip/route.ts')).toContain('scope.active ? { persisted: 0, error: null as string | null } : await persistR5Results(');
    expect(read('app/api/investment-intelligence/xray/route.ts')).toContain('if (available && !scope.active) {');
    const tax = read('app/api/investment-intelligence/tax/summary/route.ts');
    expect(tax.match(/scope\.active \? noPersist : await persist/g)?.length).toBe(3);
  });
  it('the certified engines are not touched: the owner-class scope lives entirely outside lib/engines/investment-intelligence', () => {
    for (const f of ['ownerClass.ts', 'ownerClassScope.ts']) {
      expect(read(`lib/services/investment-intelligence/${f}`)).not.toMatch(/from '@\/lib\/engines\/investment-intelligence/);
    }
  });
});

describe('optional preview output', () => {
  it('writes the Overview breakup to OWNER_CLASS_PREVIEW_OUT when set (UX evidence for the report)', () => {
    const out = process.env.OWNER_CLASS_PREVIEW_OUT;
    if (!out) return;
    const labels: OwnerLabels = {
      member: (id) => ({ m1: { name: 'Asha Rao', relationship: 'self' }, m2: { name: 'Ravi Rao', relationship: 'spouse' } } as Record<string, { name: string; relationship: string }>)[id],
      entity: (id) => ({ e1: { name: 'Rao Family Trust', entityType: 'family_trust' }, e2: { name: 'Rao HUF', entityType: 'huf' } } as Record<string, { name: string; entityType: string }>)[id],
    };
    const own = (rows: { m?: string; e?: string; bp: number }[], ptr: string | null = null) =>
      deriveAccountOwnership(ptr, rows.map((r) => ({ owner_member_id: r.m ?? null, owner_business_entity_id: r.e ?? null, allocation_basis_points: r.bp, ii_instrument_id: null, status: 'active' })));
    const breakup = buildOwnerBreakup(
      [
        { id: 'a1', ownership: own([], 'm1') },
        { id: 'a2', ownership: own([], 'm2') },
        { id: 'a3', ownership: own([{ m: 'm1', bp: 6000 }, { m: 'm2', bp: 4000 }]) },
        { id: 'a4', ownership: own([{ e: 'e1', bp: 10000 }]) },
        { id: 'a5', ownership: own([{ e: 'e2', bp: 10000 }]) },
        { id: 'a6', ownership: own([{ m: 'm1', bp: 7000 }, { e: 'e1', bp: 3000 }]) },
      ],
      [
        { accountId: 'a1', currencyCode: 'INR', value: 2_500_000 },
        { accountId: 'a2', currencyCode: 'INR', value: 1_200_000 },
        { accountId: 'a3', currencyCode: 'INR', value: 1_000_000 },
        { accountId: 'a4', currencyCode: 'INR', value: 4_000_000 },
        { accountId: 'a5', currencyCode: 'INR', value: 900_000 },
        { accountId: 'a6', currencyCode: 'INR', value: 600_000 },
      ],
      labels
    );
    const panel = renderToStaticMarkup(createElement(OwnerBreakupTable, { breakup: breakup as unknown as OwnerBreakupPayload }));
    const barHtml = bar(ALL_OWNER_CLASSES, [
      { key: 'member:m1', kind: 'personal', label: 'Asha Rao', detail: 'You', accountCount: 2 },
      { key: 'member:m2', kind: 'personal', label: 'Ravi Rao', detail: 'Spouse', accountCount: 1 },
      { key: 'joint', kind: 'joint', label: 'Jointly owned (household members)', detail: null, accountCount: 1 },
      { key: 'entity:e1', kind: 'entity', label: 'Rao Family Trust', detail: 'Family trust', accountCount: 1 },
      { key: 'entity:e2', kind: 'entity', label: 'Rao HUF', detail: 'Hindu Undivided Family (HUF)', accountCount: 1 },
      { key: 'entity_shared', kind: 'entity_shared', label: 'Shared with a trust, HUF or company', detail: null, accountCount: 1 },
    ]);
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>Owner-class breakup preview</title><meta name="viewport" content="width=device-width, initial-scale=1"><!--INLINE_CSS--></head><body class="bg-slate-100 p-6 font-sans"><div class="mx-auto max-w-3xl space-y-4"><h1 class="text-xl font-semibold">Investment Intelligence Overview: owner-class breakup (static render, invented fixture)</h1>${barHtml}${panel}</div></body></html>`;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, page, 'utf8');
    expect(fs.existsSync(out)).toBe(true);
  });
});
