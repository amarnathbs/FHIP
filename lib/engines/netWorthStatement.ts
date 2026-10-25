/**
 * Net Worth Statements -- the pure builder behind Reports > Net Worth Statement (PO request 16-10-2026).
 *
 * THREE kinds of one-page statement, all read from the ONE canonical model (lib/engines/netWorthLevels.ts,
 * the same object the Dashboard and the Monthly Report read as summary.netWorthLevels):
 *   1. PERSONAL: the personal level, itemised (item, owner, amount), grouped Property / Cash / Investments /
 *      Retirement / Other, liabilities, net worth, and a "By person" block (joint items counted once).
 *   2. ENTITY: one statement per entity the model reports (SMSF, Family Trust, HUF, Company): the entity's own
 *      assets, liabilities and net, and what it contributes to the family total (Company at the ownership share).
 *   3. FAMILY (consolidated): personal + each entity's contribution, line by line = family net worth, plus a
 *      reconciliation to the Dashboard figures.
 *
 * THIS MODULE ADDS NO FIGURE OF ITS OWN. Every total, subtotal-of-record, person split and entity contribution is
 * READ from `levels`. The itemised lines only EXPLAIN those totals; `parity` proves they add up to them and says
 * so out loud when they do not (it never forces them to). When the personal-basis change and the entity-level
 * asset/liability input land and change `levels`, these statements follow with no edit here.
 *
 * WHERE EACH ROW GOES is decided by asking the model itself (`classifyRow` runs computeNetWorthLevels on that one
 * row), so this file holds no copy of the "personal or entity?" rule.
 *
 * MISSING != ZERO: a value that was not provided is shown as "Not provided" and left out of every total; a value in a
 * currency that cannot be converted is listed separately and left out of every total (the model does the same).
 *
 * ENTITY DATA TODAY vs LATER. Entity-level assets and liabilities are not an input yet (another branch is designing
 * it). The builder works on `EntityStatementInput`, a stable shape (assets[], liabilities[], net, source flag). Today
 * it is assembled from what exists (owner-tagged register rows, registered entities); later the same shape is
 * filled from entity-level rows (`entityInputs` override), and the entity statement then itemises automatically.
 *
 * PURE: no I/O, no clock (the as-at date is passed in). Loader: lib/services/netWorthStatementData.ts.
 */
import {
  NET_WORTH_ENTITY_KIND_LABELS,
  computeNetWorthLevels,
  type NetWorthEntityBlock,
  type NetWorthEntityKind,
  type NetWorthLevels,
  type NetWorthRegister,
  type NetWorthRowInput,
  type Totals,
} from '@/lib/engines/netWorthLevels';
import { formatDateShort } from '@/lib/engines/date';
import { formatMoney } from '@/lib/engines/money';
import { ownerDisplayLabel } from '@/lib/constants';
import { PAGE1_DISCLAIMER } from '@/lib/engines/reportCopy';

export type StatementCurrency = 'AUD' | 'INR';
export type AssetGroupKey = 'property' | 'cash' | 'investments' | 'retirement' | 'other';
export type LineStatus = 'ok' | 'not_provided' | 'not_converted';
export type EntityItemisation = 'itemised' | 'net_only' | 'totals_only';
export type EntityDataSource = 'entity_level_rows' | 'smsf_holdings' | 'owner_tagged_rows' | 'registry_detail' | 'registry_summary';

export const ASSET_GROUP_ORDER: readonly AssetGroupKey[] = ['property', 'cash', 'investments', 'retirement', 'other'];
export const ASSET_GROUP_LABELS: Readonly<Record<AssetGroupKey, string>> = {
  property: 'Property',
  cash: 'Cash',
  investments: 'Investments',
  retirement: 'Retirement',
  other: 'Other',
};

export const NET_WORTH_STATEMENT_TITLE = 'Net Worth Statement';
export const NOT_PROVIDED_LABEL = 'Not provided';
/** The standard short disclaimer line the other reports use (lib/engines/reportCopy.ts PAGE1_DISCLAIMER), worded for a statement. */
export const NET_WORTH_STATEMENT_DISCLAIMER = PAGE1_DISCLAIMER.replace(/^This report/, 'This statement');
export const ENTITY_NOT_ITEMISED_NOTE = 'Entity assets and liabilities are not itemised yet. Only the entity’s net value has been entered, so the net value is shown on its own.';

/** One register row as the statement needs it (the model's row, plus the display facts the model does not carry). */
export interface StatementSourceRow {
  id: string;
  register: NetWorthRegister;
  name: string;
  owner: string | null;
  /** Reporting-currency amount; null = not provided or not convertible (see nativeAmount). */
  amountReporting: number | null;
  /** The amount as recorded; null/NaN = the value was not provided. */
  nativeAmount: number | null;
  nativeCurrency: string | null;
  /** Assets side only: which group the row is listed under. */
  group: AssetGroupKey | null;
  /** Retirement rows: 'smsf' marks the SMSF section's fund record (entity-held whoever owns it). Passed through to the model. */
  masterItemKey?: string | null;
  smsfLinkedLoan?: boolean;
  nettedInFundBalance?: boolean;
}

export interface StatementLine {
  id: string;
  name: string;
  ownerKey: string | null;
  ownerLabel: string;
  /** Reporting-currency amount; null when status is not 'ok'. */
  amount: number | null;
  status: LineStatus;
  /** Shown only when the item is recorded in a currency other than the reporting currency. */
  native: { amount: number; currency: string } | null;
  /** True when the line is shown with its recorded amount in another currency (converted, counted). */
  foreign: boolean;
}

export interface StatementGroup {
  key: AssetGroupKey;
  label: string;
  lines: StatementLine[];
  /** Sum of the lines that are counted (status ok). */
  subtotal: number;
}

/** The STABLE entity statement input: today assembled from existing data, later filled from entity-level rows. */
export interface EntityStatementInput {
  /** NetWorthEntityBlock.id (`tag:smsf`, `entity:<registry id>`). */
  entityId: string;
  kind: NetWorthEntityKind;
  name: string;
  assets: readonly StatementSourceRow[];
  liabilities: readonly StatementSourceRow[];
  /** The entity's net at 100% as the model reports it. Never recomputed here. */
  net: number | null;
  source: EntityDataSource;
}

/** A fund's holdings as stored (smsf_funds + smsf_holdings), already converted once to the reporting currency. */
export interface SmsfFundInput {
  fundId: string;
  fundName: string;
  mode: 'summary' | 'detailed';
  holdings: readonly StatementSourceRow[];
}

export interface TotalsView {
  assets: number;
  liabilities: number;
  net: number;
}

export interface PartyRow {
  key: string;
  label: string;
  ownNet: number;
  jointShareNet: number;
  assets: number;
  liabilities: number;
  net: number;
}

export interface NotIncludedLine extends StatementLine {
  reason: string;
}

export interface StatementHeader {
  title: string;
  subtitle: string;
  asAt: string; // already formatted day-first
  asAtLabel: string;
  currency: StatementCurrency;
  holderName: string | null;
}

export interface PersonalStatement {
  kind: 'personal';
  header: StatementHeader;
  assetGroups: StatementGroup[];
  liabilities: StatementLine[];
  totals: TotalsView;
  byPerson: { rows: PartyRow[]; total: PartyRow; jointPool: TotalsView | null; jointSplitText: string | null };
  notIncluded: NotIncludedLine[];
  notProvidedCount: number;
  importedNotInNetWorth: { count: number; amount: number } | null;
  fxNote: string | null;
  levelExplanation: string;
  notes: string[];
  rowCount: number;
}

export interface EntityStatement {
  kind: 'entity';
  entityId: string;
  entityKind: NetWorthEntityKind;
  header: StatementHeader;
  name: string;
  source: EntityDataSource;
  itemisation: EntityItemisation;
  assets: StatementLine[];
  liabilities: StatementLine[];
  /** At 100%. null = not itemised / not provided (never zero). */
  assetsTotal: number | null;
  liabilitiesTotal: number | null;
  net: number | null;
  basis: NetWorthEntityBlock['basis'];
  includedPercent: number;
  recordedOwnershipPercent: number | null;
  /** What flows into the family total (net). null = not provided. */
  contribution: number | null;
  contributionText: string;
  nettedLoans: { count: number; amount: number } | null;
  notItemisedNote: string | null;
  /** SMSF: true when no liability is recorded at the fund (the model counts the net value only); never invented. */
  liabilitiesNotRecorded: boolean;
  /** True when the MODEL's own entity figures are one net value (the itemised lines, if any, come from elsewhere, e.g. fund holdings). */
  netOnlyInModel: boolean;
  /** The SMSF fund record(s) shown but NOT counted because a fund-level row already carries the fund (model: suppressedFundRecord). */
  shownNotCounted: StatementLine[];
  /** Net-only entities: the register rows the single net figure was entered as (names, for the note). */
  enteredAs: string[];
  notIncluded: NotIncludedLine[];
  notes: string[];
  levelExplanation: string;
  rowCount: number;
}

export interface FamilyLevelRow {
  key: string;
  label: string;
  basisText: string;
  assets: number | null;
  liabilities: number | null;
  net: number | null;
  /** Entered as one net figure (the net is counted on the assets side by the model). */
  netOnly: boolean;
}

export interface FamilyStatement {
  kind: 'family';
  header: StatementHeader;
  levels: FamilyLevelRow[];
  totals: TotalsView;
  /** personal + each entity contribution = family, line by line. */
  contributions: { key: string; label: string; net: number | null }[];
  contributionSum: number;
  personalGroups: { key: AssetGroupKey; label: string; subtotal: number }[];
  personalLiabilities: number;
  dashboard: {
    personalNet: number;
    familyNet: number;
    headline: { label: string; value: number } | null;
    headlineMatches: boolean | null;
    previouslyReported: number | null;
    bridgeLines: { label: string; amount: number }[];
    bridgeOk: boolean | null;
    text: string;
  };
  notIncluded: NotIncludedLine[];
  importedNotInNetWorth: { count: number; amount: number } | null;
  fxNote: string | null;
  levelExplanation: string;
  notes: string[];
  rowCount: number;
}

export interface StatementParity {
  ok: boolean;
  messages: string[];
}

export interface NetWorthStatementSet {
  currency: StatementCurrency;
  asAt: string;
  asAtLabel: string;
  personal: PersonalStatement;
  entities: EntityStatement[];
  family: FamilyStatement;
  parity: StatementParity;
  hasEntities: boolean;
  /** The Dashboard-model object these statements were read from, kept so a consumer can prove identity. */
  source: { levelsSchemaVersion: number };
}

export interface NetWorthStatementInput {
  levels: NetWorthLevels;
  currency: StatementCurrency;
  /** Local date YYYY-MM-DD (the Dashboard's own window.asOf). */
  asAt: string;
  rows: readonly StatementSourceRow[];
  holderName?: string | null;
  fx?: { fxRateAudInr: number; rateSource: 'forecast_global_assumptions' | 'default' } | null;
  /** D-05: holdings imported but not yet in Net Worth (a note, never a total). */
  importedNotInNetWorth?: { count: number; amount: number } | null;
  /** Future/explicit entity-level rows; override the data assembled from today's rows for that entity id. */
  entityInputs?: readonly EntityStatementInput[];
  /** SMSF funds and their holdings (smsf_funds / smsf_holdings). A Detailed-mode fund's holdings itemise the SMSF page. */
  smsfFunds?: readonly SmsfFundInput[];
  /** The SMSF funds/holdings could not be read: said on the SMSF page, never guessed. */
  smsfFundsUnavailable?: boolean;
  /** The Dashboard summary's own personal figures (summary.netWorth / totalAssetsCombined / totalLiabilities), proven equal to the personal level. */
  dashboardPersonal?: { netWorth: number; totalAssets: number; totalLiabilities: number } | null;
  /** The Dashboard's history-basis figure (summary.netWorthBasis.history.netWorth), proven equal to the model's previously reported figure. */
  dashboardHistoryNetWorth?: number | null;
  /** Registered entities (block ids `entity:<id>`) whose net value was never provided: shown "Not provided", not zero. */
  registryValueNotProvided?: readonly string[];
  /** The Dashboard headline figure (components/dashboard/netWorthHeadline), for the reconciliation line. */
  dashboardHeadline?: { label: string; value: number } | null;
}

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const sameMoney = (a: number, b: number): boolean => Math.abs(a - b) <= 0.05;

// ---------------------------------------------------------------------------------------------------------------------
// Classification: ask the model where one row lands (no copy of its rule here).
// ---------------------------------------------------------------------------------------------------------------------

export type RowDestination =
  | { level: 'personal' }
  | { level: 'entity'; kind: NetWorthEntityKind; /** The SMSF section's fund record (not owned by the fund): counted only when no fund-level row exists. */ fundRecord: boolean }
  | { level: 'netted_in_fund' };

export function toModelRow(r: StatementSourceRow, amountReporting: number | null = r.amountReporting): NetWorthRowInput {
  return {
    id: r.id,
    register: r.register,
    name: r.name,
    owner: r.owner,
    amountReporting,
    currencyCode: r.nativeCurrency,
    masterItemKey: r.masterItemKey,
    smsfLinkedLoan: r.smsfLinkedLoan,
    nettedInFundBalance: r.nettedInFundBalance,
  };
}

export function classifyRow(r: StatementSourceRow, currency: string): RowDestination {
  // A probe amount of 1 keeps a zero-value row classifiable; only the destination is read, never the amount.
  const probe = computeNetWorthLevels({ currency, rows: [toModelRow(r, 1)] });
  const block = probe.entities.blocks[0];
  if (block) {
    const t = block.entityTotals;
    if (block.nettedLoans && t.totalAssets === 0 && t.liabilities === 0) return { level: 'netted_in_fund' };
    return { level: 'entity', kind: block.kind, fundRecord: block.kind === 'smsf' && r.register === 'retirement' && r.owner !== 'smsf' };
  }
  return { level: 'personal' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------------------------------

function statusOf(r: StatementSourceRow): LineStatus {
  if (r.nativeAmount === null || !Number.isFinite(r.nativeAmount)) return 'not_provided';
  if (r.amountReporting === null || !Number.isFinite(r.amountReporting)) return 'not_converted';
  return 'ok';
}

export function ownerLabelOf(owner: string | null): string {
  const label = ownerDisplayLabel(owner);
  return label || 'Not recorded';
}

export function toLine(r: StatementSourceRow, reportingCurrency: string): StatementLine {
  const status = statusOf(r);
  const foreign = !!r.nativeCurrency && r.nativeCurrency.toUpperCase() !== reportingCurrency.toUpperCase();
  return {
    id: r.id,
    name: r.name,
    ownerKey: r.owner,
    ownerLabel: ownerLabelOf(r.owner),
    amount: status === 'ok' ? (r.amountReporting as number) : null,
    status,
    native: foreign && r.nativeAmount !== null && Number.isFinite(r.nativeAmount) ? { amount: r.nativeAmount, currency: (r.nativeCurrency as string).toUpperCase() } : null,
    foreign,
  };
}

const sumCounted = (lines: readonly StatementLine[]): number => cents(lines.reduce((s, l) => s + (l.status === 'ok' ? (l.amount as number) : 0), 0));

function notIncludedOf(lines: readonly StatementLine[]): NotIncludedLine[] {
  return lines
    .filter((l) => l.status === 'not_converted')
    .map((l) => ({ ...l, reason: `the ${l.native?.currency ?? 'recorded'} currency cannot be converted, so it is left out of every total.` }));
}

const byNameThenId = (a: StatementLine, b: StatementLine): number => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

// ---------------------------------------------------------------------------------------------------------------------
// Notes shared by the statements
// ---------------------------------------------------------------------------------------------------------------------

function fxNoteOf(input: NetWorthStatementInput, lines: readonly StatementLine[]): string | null {
  const foreign = lines.filter((l) => l.foreign && l.status === 'ok');
  if (foreign.length === 0 || !input.fx) return null;
  const rate = input.fx.fxRateAudInr;
  const asAt = formatDateShort(input.asAt, input.currency);
  const basis = input.fx.rateSource === 'default' ? 'the default household rate (no rate has been set)' : 'the household rate used on the Dashboard and in the Monthly Report';
  return `Amounts recorded in another currency are shown in ${input.currency} and, beneath the item, in the recorded currency. Conversion uses 1 AUD = ${rate} INR, ${basis}, as at ${asAt}.`;
}

const formatMoneyPlain = formatMoney;

function headerOf(input: NetWorthStatementInput, subtitle: string): StatementHeader {
  const asAt = formatDateShort(input.asAt, input.currency);
  return {
    title: NET_WORTH_STATEMENT_TITLE,
    subtitle,
    asAt,
    asAtLabel: `As at ${asAt}`,
    currency: input.currency,
    holderName: input.holderName?.trim() ? input.holderName.trim() : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Entity inputs: assembled from today's data in the stable shape
// ---------------------------------------------------------------------------------------------------------------------

const ASSET_REGISTERS: readonly NetWorthRegister[] = ['assets', 'investments', 'retirement'];

function buildEntityInputs(input: NetWorthStatementInput, destinations: Map<string, RowDestination>): EntityStatementInput[] {
  const out: EntityStatementInput[] = [];
  const overrides = new Map((input.entityInputs ?? []).map((e) => [e.entityId, e] as const));
  for (const block of input.levels.entities.blocks) {
    const override = overrides.get(block.id);
    if (override) {
      out.push(override);
      continue;
    }
    // An entity that records its OWN assets and liabilities (an SMSF fund, migrations 0289-0290): the statement itemises straight from the model's
    // sheet, so it follows the family view with nothing to keep in step. Net value only: no lines, the model's net.
    if (block.sheet) {
      const toRow = (l: { id: string; name: string; kind: string | null; amountNative: number; currency: string; amountReporting: number | null }, register: NetWorthRegister): StatementSourceRow => ({
        id: `${block.id}:${register}:${l.id}`,
        register,
        name: l.name,
        owner: 'smsf',
        amountReporting: l.amountReporting,
        nativeAmount: l.amountNative,
        nativeCurrency: l.currency,
        group: register === 'liabilities' ? null : 'other',
      });
      out.push({
        entityId: block.id,
        kind: block.kind,
        name: block.name,
        assets: block.sheet.assets.map((l) => toRow(l, 'assets')),
        liabilities: block.sheet.liabilities.map((l) => toRow(l, 'liabilities')),
        net: block.entityTotals.net,
        source: 'entity_level_rows',
      });
      continue;
    }
    if (block.source === 'owner_tag') {
      const suppressed = !!block.suppressedFundRecord;
      const mine = input.rows.filter((r) => {
        const d = destinations.get(r.id);
        if (!d || d.level !== 'entity' || d.kind !== block.kind) return false;
        return !(suppressed && d.fundRecord); // shown but not counted: listed separately, never in the entity's lines
      });
      out.push({
        entityId: block.id,
        kind: block.kind,
        name: block.name,
        assets: mine.filter((r) => ASSET_REGISTERS.includes(r.register)),
        liabilities: mine.filter((r) => r.register === 'liabilities'),
        net: block.entityTotals.net,
        source: 'owner_tagged_rows',
      });
    } else {
      out.push({
        entityId: block.id,
        kind: block.kind,
        name: block.name,
        assets: [],
        liabilities: [],
        net: block.entityTotals.net,
        source: block.entityTotals.assets !== 0 || block.entityTotals.liabilities !== 0 ? 'registry_detail' : 'registry_summary',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------------------------------

export function buildNetWorthStatements(input: NetWorthStatementInput): NetWorthStatementSet {
  const { levels, currency } = input;
  const messages: string[] = [];
  const destinations = new Map<string, RowDestination>();
  for (const r of input.rows) destinations.set(r.id, classifyRow(r, currency));

  // ---- PERSONAL ---------------------------------------------------------------------------------------------------
  const personalRows = input.rows.filter((r) => destinations.get(r.id)?.level === 'personal');
  const assetRows = personalRows.filter((r) => ASSET_REGISTERS.includes(r.register));
  const liabilityRows = personalRows.filter((r) => r.register === 'liabilities');

  const groupOf = (r: StatementSourceRow): AssetGroupKey => (r.register === 'investments' ? 'investments' : r.register === 'retirement' ? 'retirement' : (r.group ?? 'other'));
  const assetGroups: StatementGroup[] = [];
  for (const key of ASSET_GROUP_ORDER) {
    const lines = assetRows.filter((r) => groupOf(r) === key).map((r) => toLine(r, currency)).filter((l) => l.status !== 'not_converted').sort(byNameThenId);
    if (lines.length === 0) continue;
    assetGroups.push({ key, label: ASSET_GROUP_LABELS[key], lines, subtotal: sumCounted(lines) });
  }
  const liabilityLines = liabilityRows.map((r) => toLine(r, currency)).filter((l) => l.status !== 'not_converted').sort(byNameThenId);
  const personalNotIncluded = notIncludedOf([...assetRows, ...liabilityRows].map((r) => toLine(r, currency)));
  const personalAllLines = [...assetGroups.flatMap((g) => g.lines), ...liabilityLines];
  const notProvidedCount = personalAllLines.filter((l) => l.status === 'not_provided').length;

  const pTotals = levels.personal.total;
  const personalTotals: TotalsView = { assets: pTotals.totalAssets, liabilities: pTotals.liabilities, net: pTotals.net };
  const itemisedAssets = cents(assetGroups.reduce((s, g) => s + g.subtotal, 0));
  const itemisedLiabilities = sumCounted(liabilityLines);
  if (!sameMoney(itemisedAssets, personalTotals.assets) || !sameMoney(itemisedLiabilities, personalTotals.liabilities)) {
    messages.push(
      `Personal level: the itemised lines add to assets ${itemisedAssets} and liabilities ${itemisedLiabilities}, but the Dashboard model reports assets ${personalTotals.assets} and liabilities ${personalTotals.liabilities}.`,
    );
  }

  const partyRow = (key: string, label: string, t: { total: Totals; direct: Totals; jointShare: Totals }): PartyRow => ({
    key,
    label,
    ownNet: t.direct.net,
    jointShareNet: t.jointShare.net,
    assets: t.total.totalAssets,
    liabilities: t.total.liabilities,
    net: t.total.net,
  });
  const partyRows = levels.personal.parties.map((p) => partyRow(p.key, p.label, p));
  const joint = levels.personal.jointPool;
  const personalFxLines = [...assetGroups.flatMap((g) => g.lines), ...liabilityLines];

  const personal: PersonalStatement = {
    kind: 'personal',
    header: headerOf(input, 'Personal'),
    assetGroups,
    liabilities: liabilityLines,
    totals: personalTotals,
    byPerson: {
      rows: partyRows,
      total: { key: 'total', label: 'Personal net worth', ownNet: cents(partyRows.reduce((s, r) => s + r.ownNet, 0)), jointShareNet: cents(partyRows.reduce((s, r) => s + r.jointShareNet, 0)), assets: personalTotals.assets, liabilities: personalTotals.liabilities, net: personalTotals.net },
      jointPool: joint.totalAssets !== 0 || joint.liabilities !== 0 ? { assets: joint.totalAssets, liabilities: joint.liabilities, net: joint.net } : null,
      jointSplitText: levels.explanation.jointSplit,
    },
    notIncluded: personalNotIncluded,
    notProvidedCount,
    importedNotInNetWorth: input.importedNotInNetWorth && input.importedNotInNetWorth.count > 0 ? input.importedNotInNetWorth : null,
    fxNote: fxNoteOf(input, personalFxLines),
    levelExplanation: levels.explanation.personal,
    notes: [],
    rowCount: personalAllLines.length + assetGroups.length * 2 + 2,
  };
  if (levels.dataStatus.duplicateRisk) personal.notes.push(levels.dataStatus.duplicateRisk);
  const doubleCount = levels.dataStatus.smsfPossibleDoubleCount;
  if (doubleCount) personal.notes.push(doubleCount);
  if (personal.importedNotInNetWorth) {
    const i = personal.importedNotInNetWorth;
    personal.notes.push(`${i.count} imported holding${i.count === 1 ? '' : 's'} worth ${formatMoneyPlain(i.amount, currency)} ${i.count === 1 ? 'is' : 'are'} not yet in Net Worth and ${i.count === 1 ? 'is' : 'are'} not included above.`);
  }
  if (levels.dataStatus.unavailable.length > 0) {
    personal.notes.push(`Some information could not be read (${levels.dataStatus.unavailable.map((u) => u.section.replace(/_/g, ' ')).join(', ')}); figures that depend on it follow the Dashboard’s fallback and are not guessed.`);
  }
  if (personalNotIncluded.length > 0 || notProvidedCount > 0) {
    personal.notes.push(
      `Items shown as "${NOT_PROVIDED_LABEL}" have no value entered, and items listed as not included are in a currency that cannot be converted. Neither is counted as zero: both are left out of every total.`,
    );
  }

  // ---- ENTITIES ---------------------------------------------------------------------------------------------------
  const entityInputs = buildEntityInputs(input, destinations);
  const notProvidedEntities = new Set(input.registryValueNotProvided ?? []);
  const entities: EntityStatement[] = [];
  for (const block of levels.entities.blocks) {
    const ein = entityInputs.find((e) => e.entityId === block.id)!;
    const kindLabel = NET_WORTH_ENTITY_KIND_LABELS[block.kind];
    const assetLinesAll = ein.assets.map((r) => toLine(r, currency));
    const liabilityLinesAll = ein.liabilities.map((r) => toLine(r, currency));
    const assetLines = assetLinesAll.filter((l) => l.status !== 'not_converted').sort(byNameThenId);
    const liabilityLinesE = liabilityLinesAll.filter((l) => l.status !== 'not_converted').sort(byNameThenId);
    const hasRows = assetLines.length > 0 || liabilityLinesE.length > 0;
    const t = block.entityTotals;
    const valueMissing = notProvidedEntities.has(block.id);

    // Net-only: a fund balance entered as a single net figure (retirement register) with no asset/liability rows, or a
    // registered entity in Summary mode. Itemised: asset / liability register rows (owner tag) or explicit entity rows.
    const retirementOnly = hasRows && ein.assets.length > 0 && ein.liabilities.length === 0 && ein.assets.every((r) => r.register === 'retirement');
    let itemisation: EntityItemisation;
    if (ein.source === 'registry_detail') itemisation = 'totals_only';
    else if (ein.source === 'registry_summary' || retirementOnly || !hasRows) itemisation = 'net_only';
    else itemisation = 'itemised';

    const netOnlyInModel = itemisation === 'net_only';

    // A Detailed-mode SMSF fund: its stored holdings (smsf_holdings) ARE the fund's assets and itemise the SMSF page. The loan
    // is shown as "not recorded at the fund" unless a linked loan is already inside the balance (then it is a note). Nothing
    // about the fund's liabilities is invented, and the net value counted stays the model's figure.
    const detailedFunds = block.kind === 'smsf' && ein.source === 'owner_tagged_rows' ? (input.smsfFunds ?? []).filter((f) => f.mode === 'detailed' && f.holdings.length > 0) : [];
    let holdingLines: StatementLine[] = [];
    if (detailedFunds.length > 0) {
      holdingLines = detailedFunds
        .flatMap((f) => f.holdings.map((h) => toLine(h, currency)))
        .filter((l) => l.status !== 'not_converted')
        .sort(byNameThenId);
      itemisation = 'itemised';
    }
    const fromHoldings = holdingLines.length > 0;

    const notItemisedNote = itemisation === 'itemised' ? null : itemisation === 'totals_only' ? 'Individual line items for this entity are recorded under Companies & Trusts; only their totals are shown here.' : ENTITY_NOT_ITEMISED_NOTE;

    const liabilitiesNotRecorded = fromHoldings && !block.nettedLoans && liabilityLinesE.length === 0;
    const assetsTotal = fromHoldings ? sumCounted(holdingLines) : itemisation === 'net_only' ? null : t.totalAssets;
    const liabilitiesTotal = liabilitiesNotRecorded ? null : itemisation === 'net_only' ? null : t.liabilities;
    const net = valueMissing ? null : t.net;
    const contribution = valueMissing ? null : block.included.net;

    let shownAssets = fromHoldings ? holdingLines : assetLines;
    const enteredAs = itemisation === 'net_only' ? assetLines.map((l) => l.name) : [];
    if (itemisation === 'net_only') shownAssets = [];
    if (itemisation === 'totals_only') {
      shownAssets = [{ id: `${block.id}:assets`, name: 'Assets recorded for this entity (total)', ownerKey: null, ownerLabel: kindLabel, amount: t.assets, status: 'ok', native: null, foreign: false }];
    }
    const shownLiabilities =
      itemisation === 'totals_only'
        ? [{ id: `${block.id}:liabilities`, name: 'Liabilities recorded for this entity (total)', ownerKey: null, ownerLabel: kindLabel, amount: t.liabilities, status: 'ok' as LineStatus, native: null, foreign: false }]
        : liabilityLinesE;

    // Parity of the itemised lines against the model's entity totals.
    if (itemisation === 'itemised' && !fromHoldings) {
      const a = sumCounted(assetLines);
      const l = sumCounted(liabilityLinesE);
      if (!sameMoney(a, t.totalAssets) || !sameMoney(l, t.liabilities)) {
        messages.push(`${block.name}: the itemised lines add to assets ${a} and liabilities ${l}, but the Dashboard model reports assets ${t.totalAssets} and liabilities ${t.liabilities}.`);
      }
    }

    const pct = block.includedPercent;
    const contributionText =
      valueMissing
        ? `No value has been provided for this ${kindLabel}, so nothing is added to the family total.`
        : block.basis === 'ownership_share'
          ? `Your recorded ownership share is ${block.recordedOwnershipPercent ?? pct}%. The company’s net value is counted at that share in the family total.`
          : `Counted in full (100%) in the family total.`;

    const notes: string[] = [];
    // The model's note for a suppressed fund record quotes the amount unformatted; the "Shown but not counted" list carries it instead.
    if (block.note && !block.suppressedFundRecord) notes.push(block.note);
    if (block.nettedLoans) {
      notes.push(`${block.nettedLoans.count} SMSF property loan${block.nettedLoans.count === 1 ? '' : 's'} totalling ${formatMoneyPlain(block.nettedLoans.amount, currency)} ${block.nettedLoans.count === 1 ? 'is' : 'are'} already deducted inside the fund balance and ${block.nettedLoans.count === 1 ? 'is' : 'are'} not deducted again.`);
    }
    if (fromHoldings) {
      const gap = cents((assetsTotal as number) - (t.net));
      notes.push(
        `Assets are the fund's holdings (${detailedFunds.map((f) => f.fundName).join(', ')}), recorded in Detailed mode. ${liabilitiesNotRecorded ? 'No loan or other liability is recorded at the fund, so none is shown here (not recorded at the fund). ' : ''}The net value counted for the fund is ${formatMoneyPlain(t.net, currency)}${assetLines.length > 0 ? ` (entered as: ${assetLines.map((l) => l.name).join(', ')})` : ''}${Math.abs(gap) > 0.05 && !block.nettedLoans ? `; the holdings add to ${formatMoneyPlain(assetsTotal as number, currency)}, so ${formatMoneyPlain(Math.abs(gap), currency)} of the difference is not itemised` : ''}.`,
      );
    }
    if (block.kind === 'smsf' && input.smsfFundsUnavailable) notes.push('The fund’s holdings could not be read, so they are not itemised here.');
    const legacyIds = new Set((block.legacyRowsNotCounted?.rows ?? []).map((r) => r.id));
    const shownNotCounted = input.rows
      .filter((r) => {
        // register rows owned by the SMSF that the fund's own record replaces (statement row ids carry a register prefix)
        if (legacyIds.has(r.id) || legacyIds.has(r.id.slice(r.id.indexOf(':') + 1))) return true;
        const d = destinations.get(r.id);
        return !!block.suppressedFundRecord && !!d && d.level === 'entity' && d.kind === block.kind && d.fundRecord;
      })
      .map((r) => toLine(r, currency));
    if (valueMissing) notes.push(`${NOT_PROVIDED_LABEL}: the value of this ${kindLabel} has not been entered.`);

    entities.push({
      kind: 'entity',
      entityId: block.id,
      entityKind: block.kind,
      header: headerOf(input, `${kindLabel}${block.name && block.name !== kindLabel ? ` – ${block.name}` : ''}`),
      name: block.name,
      source: fromHoldings ? 'smsf_holdings' : ein.source,
      itemisation,
      assets: shownAssets,
      liabilities: shownLiabilities,
      assetsTotal,
      liabilitiesTotal,
      net,
      basis: block.basis,
      includedPercent: pct,
      recordedOwnershipPercent: block.recordedOwnershipPercent,
      contribution,
      contributionText,
      nettedLoans: block.nettedLoans,
      notItemisedNote,
      liabilitiesNotRecorded,
      netOnlyInModel,
      shownNotCounted,
      enteredAs,
      notIncluded: notIncludedOf(assetLinesAll.concat(liabilityLinesAll)),
      notes,
      levelExplanation: levels.explanation.family,
      rowCount: shownAssets.length + shownLiabilities.length + 6,
    });
  }

  // ---- FAMILY -----------------------------------------------------------------------------------------------------
  const familyTotals: TotalsView = { assets: levels.family.totalAssets, liabilities: levels.family.liabilities, net: levels.family.net };
  const familyLevels: FamilyLevelRow[] = [
    {
      key: 'personal',
      label: 'Personal level (Self, Spouse/Partner, joint shares)',
      basisText: 'Your own and joint items; excludes every entity',
      assets: personalTotals.assets,
      liabilities: personalTotals.liabilities,
      net: personalTotals.net,
      netOnly: false,
    },
    ...levels.entities.blocks.map((b, i): FamilyLevelRow => {
      const e = entities[i];
      const netOnly = e.netOnlyInModel;
      return {
        key: b.id,
        label: `${NET_WORTH_ENTITY_KIND_LABELS[b.kind]}${b.name && b.name !== NET_WORTH_ENTITY_KIND_LABELS[b.kind] ? ` – ${b.name}` : ''}`,
        basisText: b.basis === 'ownership_share' ? `${b.includedPercent}% ownership share` : 'In full',
        assets: e.contribution === null ? null : b.included.totalAssets,
        liabilities: e.contribution === null ? null : b.included.liabilities,
        net: e.contribution,
        netOnly,
      };
    }),
  ];
  const contributions = [
    { key: 'personal', label: 'Personal net worth', net: personalTotals.net as number | null },
    ...entities.map((e) => ({ key: e.entityId, label: `${e.header.subtitle} (${e.basis === 'ownership_share' ? `${e.includedPercent}% share` : 'in full'})`, net: e.contribution })),
  ];
  const contributionSum = cents(contributions.reduce((s, c) => s + (c.net ?? 0), 0));
  if (entities.every((e) => e.contribution !== null) && !sameMoney(contributionSum, familyTotals.net)) {
    messages.push(`Family level: personal net worth plus the entity contributions is ${contributionSum}, but the Dashboard model reports ${familyTotals.net}.`);
  }
  if (!sameMoney(personalTotals.net, personalTotals.assets - personalTotals.liabilities)) {
    messages.push('Personal level: net worth is not assets minus liabilities.');
  }
  if (levels.bridge.parityOk === false) messages.push('The Dashboard’s bridge to the previously reported net worth reports an unexplained difference.');
  if (levels.bridge.personalParityOk === false) messages.push('The Dashboard summary’s personal net worth differs from the personal level of the model.');

  // The Dashboard summary computes its personal figures independently of the model: they must agree line by line.
  const dp = input.dashboardPersonal ?? null;
  if (dp) {
    if (!sameMoney(dp.netWorth, personalTotals.net)) messages.push(`The Dashboard personal net worth is ${dp.netWorth}, but the personal statement shows ${personalTotals.net}.`);
    if (!sameMoney(dp.totalAssets, personalTotals.assets)) messages.push(`The Dashboard personal total assets are ${dp.totalAssets}, but the personal statement shows ${personalTotals.assets}.`);
    if (!sameMoney(dp.totalLiabilities, personalTotals.liabilities)) messages.push(`The Dashboard personal total liabilities are ${dp.totalLiabilities}, but the personal statement shows ${personalTotals.liabilities}.`);
  }
  if (input.dashboardHistoryNetWorth !== null && input.dashboardHistoryNetWorth !== undefined && levels.bridge.previouslyReported !== null && !sameMoney(input.dashboardHistoryNetWorth, levels.bridge.previouslyReported)) {
    messages.push('The Dashboard history-basis net worth differs from the previously reported figure the model was proven against.');
  }
  const headline = input.dashboardHeadline ?? null;
  const headlineMatches = headline ? sameMoney(headline.value, personalTotals.net) : null;
  if (headlineMatches === false) messages.push(`The Dashboard headline (${headline!.label}) is ${headline!.value}, but the personal statement shows ${personalTotals.net}.`);
  const bridgeLines = levels.bridge.lines.map((l) => ({ label: l.label, amount: l.amount }));
  const familyDashText = levels.hasEntities
    ? `Dashboard: personal ${formatMoneyPlain(personalTotals.net, currency)}, family ${formatMoneyPlain(familyTotals.net, currency)}. These are the same figures as in this statement.`
    : `Dashboard: ${formatMoneyPlain(personalTotals.net, currency)}. No entities are recorded, so the family figure equals the personal figure.`;

  const familyNotIncluded = [...personalNotIncluded, ...entities.flatMap((e) => e.notIncluded)];
  const family: FamilyStatement = {
    kind: 'family',
    header: headerOf(input, 'Family (consolidated)'),
    levels: familyLevels,
    totals: familyTotals,
    contributions,
    contributionSum,
    personalGroups: assetGroups.map((g) => ({ key: g.key, label: g.label, subtotal: g.subtotal })),
    personalLiabilities: itemisedLiabilities,
    dashboard: {
      personalNet: personalTotals.net,
      familyNet: familyTotals.net,
      headline,
      headlineMatches,
      previouslyReported: levels.bridge.previouslyReported,
      bridgeLines,
      bridgeOk: levels.bridge.parityOk,
      text: familyDashText,
    },
    notIncluded: familyNotIncluded,
    importedNotInNetWorth: personal.importedNotInNetWorth,
    fxNote: fxNoteOf(input, [...personalFxLines, ...entities.flatMap((e) => [...e.assets, ...e.liabilities])]),
    levelExplanation: levels.explanation.family,
    notes: [...personal.notes.filter((n) => !n.startsWith('Some information could not be read')), ...entities.flatMap((e) => e.notes.filter((n) => n.includes(NOT_PROVIDED_LABEL)))],
    rowCount: familyLevels.length + contributions.length + assetGroups.length + 10,
  };
  if (levels.dataStatus.unavailable.length > 0) family.notes.push(personal.notes.find((n) => n.startsWith('Some information could not be read'))!);
  for (const e of entities) {
    if (e.shownNotCounted.length > 0) {
      family.notes.push(`${e.header.subtitle} fund record ${e.shownNotCounted.map((l) => `"${l.name}" ${l.amount === null ? NOT_PROVIDED_LABEL : formatMoneyPlain(l.amount, currency)}`).join(', ')} is shown but not counted, because a separate fund-level row already carries the fund (see the ${e.header.subtitle} statement).`);
    }
  }
  if (entities.some((e) => e.netOnlyInModel)) family.notes.push('Where an entity’s value was entered as one net figure, the model counts it on the assets side; its liabilities are not itemised.');

  return {
    currency,
    asAt: input.asAt,
    asAtLabel: personal.header.asAtLabel,
    personal,
    entities,
    family,
    parity: { ok: messages.length === 0, messages },
    hasEntities: levels.hasEntities,
    source: { levelsSchemaVersion: levels.schemaVersion },
  };
}

/** The views the Reports page offers, in order. `all` prints every statement, one page each. */
export type StatementView = 'personal' | 'family' | 'all' | { entity: string };

export function statementViewKey(v: StatementView): string {
  return typeof v === 'string' ? v : `entity:${v.entity}`;
}

export function parseStatementView(raw: string | null | undefined, set: Pick<NetWorthStatementSet, 'entities'>): StatementView {
  if (!raw || raw === 'personal') return 'personal';
  if (raw === 'family' || raw === 'all') return raw;
  if (raw.startsWith('entity:')) {
    const id = raw.slice('entity:'.length);
    if (set.entities.some((e) => e.entityId === id)) return { entity: id };
  }
  return 'personal';
}

/** Statements to render for a view, in print order (personal, entities, family). */
export function statementsForView(set: NetWorthStatementSet, view: StatementView): (PersonalStatement | EntityStatement | FamilyStatement)[] {
  if (view === 'personal') return [set.personal];
  if (view === 'family') return [set.family];
  if (view === 'all') return [set.personal, ...set.entities, set.family];
  const e = set.entities.find((x) => x.entityId === view.entity);
  return e ? [e] : [set.personal];
}
