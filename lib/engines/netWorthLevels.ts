/**
 * Net Worth at TWO levels (PO decision 16-10-2026) -- the ONE canonical model.
 *
 *   1. PERSONAL / INDIVIDUAL level: what each person (Self, Spouse/Partner) owns and owes, with Joint
 *      items divided by the ownership split (a recorded split when there is one, otherwise the K.6
 *      default of equal shares). A joint item is counted ONCE: its shares always add back to 100%.
 *   2. CONSOLIDATED FAMILY level: the personal level PLUS every entity, shown as its own labelled
 *      block: SMSF in full, Family Trusts in full, HUFs in full, Companies at the household's
 *      ownership share (PO decision 16-10-2026). Entity data stays captured separately at input; this
 *      is a reporting-time view that is never silently blended into the individual figures.
 *
 * The 2026-09-21 entity-data-separation ruling is respected: the personal figures contain no entity
 * rows at all. The family figure adds them back explicitly, line by line (reconciliation below).
 *
 * NO DOUBLE COUNTING (each rule is enforced by construction and by tests):
 *  - joint: shares come from attributeByBasisPoints (largest remainder), total exactly 10000 bp;
 *  - an SMSF property loan that a Detailed-mode fund has ALREADY netted inside the fund's retirement
 *    balance (smsf_compute_detailed_net_value, migration 0084) is NOT subtracted a second time. It is
 *    listed as a memo and in the bridge to the previously reported figure;
 *  - a registered Company / Trust / HUF enters ONCE: as its net asset value (assets minus liabilities)
 *    times the included share. Its underlying assets are never also counted anywhere else;
 *  - SMSF member balances (retirement rows owned by a person) are personal; rows tagged SMSF are the
 *    fund's own and live in the SMSF block. Neither set appears in the other.
 *
 * MISSING != ZERO: a row in a currency that cannot be converted is left out of every figure and
 * counted in dataStatus.unconverted. Currency conversion itself happens upstream, once, at the single
 * household rate (this module only adds already-converted reporting amounts).
 *
 * TODAY'S FIGURE STAYS REPRODUCIBLE: `bridge` turns the family figure back into the Dashboard's
 * previously reported net worth with explicit lines (see NetWorthBridge), and flags any unexplained
 * residual rather than hiding it.
 *
 * PURE: no I/O, no clock. Loader: lib/services/netWorthLevelsData.ts.
 */
import { attributeByBasisPoints } from '@/lib/services/investment-intelligence/ownerAttribution';
import { computeBusinessEntityNetAssetValue, type BusinessEntityWithLineItems } from '@/lib/engines/businessEntityValuation';
import { convertToReportingCurrency, type SupportedCurrency } from '@/lib/engines/fx';

export type NetWorthRegister = 'assets' | 'investments' | 'retirement' | 'liabilities';
export type NetWorthRole = 'self' | 'spouse' | 'other';
export type NetWorthEntityKind = 'smsf' | 'family_trust' | 'huf' | 'company';

/** The household's declared split for a Joint item: roles, in basis points, totalling exactly 10000. */
export interface NetWorthJointShare {
  role: NetWorthRole;
  basisPoints: number;
}

/** K.6's default where no better evidence exists: equal shares between the two partners. */
export const DEFAULT_JOINT_SHARES: readonly NetWorthJointShare[] = [
  { role: 'self', basisPoints: 5000 },
  { role: 'spouse', basisPoints: 5000 },
];

export interface NetWorthRowInput {
  id: string;
  register: NetWorthRegister;
  name: string;
  /** The register row's owner tag: self | spouse | joint | child | other | smsf | family_trust | company | null. */
  owner: string | null;
  /** Amount in the REPORTING currency; null = the currency cannot be converted (left out, counted). */
  amountReporting: number | null;
  currencyCode?: string | null;
  /** Joint items only: a recorded split. Absent or invalid = the default equal split. */
  jointShares?: readonly NetWorthJointShare[] | null;
  /** Liabilities only: linked to an SMSF fund as its property loan (effective owner = the SMSF). */
  smsfLinkedLoan?: boolean;
  /** Liabilities only: that loan is ALREADY netted inside a Detailed-mode fund's retirement balance. */
  nettedInFundBalance?: boolean;
}

export interface NetWorthEntityInput {
  id: string;
  name: string;
  kind: 'company' | 'family_trust' | 'huf';
  /** The household's declared share (0, 100]. Applied to companies only (PO decision 16-10-2026). */
  ownershipPercent: number;
  /** Entity net asset value at 100%, reporting currency. */
  netAssetValue: number;
  /** Detailed mode only: gross assets / liabilities at 100%, reporting currency. */
  detail: { assets: number; liabilities: number } | null;
}

export interface Totals {
  /** Assets register (property, cash, vehicles, other). */
  assets: number;
  investments: number;
  retirement: number;
  /** Net value of a registered Company / Trust / HUF whose detail is not itemised (summary mode). */
  entityValue: number;
  totalAssets: number;
  liabilities: number;
  net: number;
}

export interface NetWorthParty {
  key: 'self' | 'spouse' | 'other_household';
  label: string;
  /** Items recorded in this person's own name. */
  direct: Totals;
  /** This person's share of Joint items. */
  jointShare: Totals;
  total: Totals;
}

export interface NetWorthEntityBlock {
  id: string;
  kind: NetWorthEntityKind;
  /** owner_tag = register rows tagged with the entity; registry = a Company / Trust / HUF recorded in Entities. */
  source: 'owner_tag' | 'registry';
  name: string;
  /** The ownership percentage the user recorded (registry entities only). */
  recordedOwnershipPercent: number | null;
  /** 100 for everything except a company's recorded share. */
  includedPercent: number;
  basis: 'recorded' | 'full' | 'ownership_share';
  /** The entity's own position at 100%. */
  entityTotals: Totals;
  /** What flows into the family figure. */
  included: Totals;
  /** SMSF only: property loans already inside the fund balance (not subtracted again). */
  nettedLoans: { count: number; amount: number } | null;
  note: string | null;
}

export interface NetWorthReconciliationLine {
  key: string;
  label: string;
  net: number;
}

export interface NetWorthBridgeLine {
  key: 'smsf_loan_counted_once' | 'trust_huf_included_in_full' | 'unexplained';
  label: string;
  /** Amount that turns the FAMILY figure into the previously reported figure (add to family net). */
  amount: number;
}

export interface NetWorthLevels {
  schemaVersion: 1;
  currency: string;
  personal: {
    parties: NetWorthParty[];
    /** The full Joint pool before it is divided (its parts are inside the parties' jointShare). */
    jointPool: Totals;
    jointSplitBasis: 'none' | 'default_equal' | 'recorded' | 'mixed';
    total: Totals;
  };
  entities: {
    blocks: NetWorthEntityBlock[];
    byKind: Record<NetWorthEntityKind, Totals>;
    total: Totals;
  };
  /** Personal + entities. */
  family: Totals;
  /** personal total + each entity kind = family total, line by line. */
  reconciliation: NetWorthReconciliationLine[];
  bridge: {
    /** The Dashboard's previously reported net worth, when supplied. */
    previouslyReported: number | null;
    /** What the family figure and the lines below reproduce; equals previouslyReported when parityOk. */
    reproduced: number;
    lines: NetWorthBridgeLine[];
    /** null when no previous figure was supplied. */
    parityOk: boolean | null;
  };
  dataStatus: {
    unconvertedCount: number;
    unconvertedByCurrency: Record<string, number>;
    unavailable: { section: string; reason: string }[];
    /** Set when the same company/trust could be counted twice (legacy tag + registry entity). */
    duplicateRisk: string | null;
  };
  hasEntities: boolean;
  /** Plain-language explanation of each level (identical wording on every surface). */
  explanation: { personal: string; family: string; jointSplit: string | null };
}

export interface NetWorthLevelsInput {
  currency: string;
  rows: readonly NetWorthRowInput[];
  entities?: readonly NetWorthEntityInput[];
  /** The Dashboard's previously reported net worth, to prove the bridge. */
  previouslyReported?: number | null;
  unavailable?: readonly { section: string; reason: string }[];
}

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function emptyTotals(): Totals {
  return { assets: 0, investments: 0, retirement: 0, entityValue: 0, totalAssets: 0, liabilities: 0, net: 0 };
}

function addToTotals(t: Totals, register: NetWorthRegister, amount: number): void {
  if (register === 'liabilities') t.liabilities += amount;
  else if (register === 'assets') t.assets += amount;
  else if (register === 'investments') t.investments += amount;
  else t.retirement += amount;
}

function finalise(t: Totals): Totals {
  const totalAssets = t.assets + t.investments + t.retirement + t.entityValue;
  return {
    assets: cents(t.assets),
    investments: cents(t.investments),
    retirement: cents(t.retirement),
    entityValue: cents(t.entityValue),
    totalAssets: cents(totalAssets),
    liabilities: cents(t.liabilities),
    net: cents(totalAssets - t.liabilities),
  };
}

function sumTotals(list: readonly Totals[]): Totals {
  const t = emptyTotals();
  for (const x of list) {
    t.assets += x.assets;
    t.investments += x.investments;
    t.retirement += x.retirement;
    t.entityValue += x.entityValue;
    t.liabilities += x.liabilities;
  }
  return finalise(t);
}

function scaleTotals(t: Totals, factor: number): Totals {
  return finalise({
    assets: t.assets * factor,
    investments: t.investments * factor,
    retirement: t.retirement * factor,
    entityValue: t.entityValue * factor,
    totalAssets: 0,
    liabilities: t.liabilities * factor,
    net: 0,
  });
}

function validShares(shares: readonly NetWorthJointShare[] | null | undefined): shares is readonly NetWorthJointShare[] {
  if (!shares || shares.length === 0) return false;
  let total = 0;
  for (const s of shares) {
    if (!Number.isInteger(s.basisPoints) || s.basisPoints <= 0) return false;
    total += s.basisPoints;
  }
  return total === 10000;
}

const KIND_LABEL: Record<NetWorthEntityKind, string> = {
  smsf: 'SMSF',
  family_trust: 'Family Trust',
  huf: 'HUF',
  company: 'Company',
};
export const NET_WORTH_ENTITY_KIND_LABELS: Readonly<Record<NetWorthEntityKind, string>> = KIND_LABEL;

const KIND_ORDER: NetWorthEntityKind[] = ['smsf', 'family_trust', 'huf', 'company'];

/** Register-row owner tag -> entity kind, or null for a personal / household owner. */
function entityKindOfOwner(owner: string | null): NetWorthEntityKind | null {
  if (owner === 'smsf') return 'smsf';
  if (owner === 'family_trust') return 'family_trust';
  if (owner === 'company') return 'company';
  return null;
}

export const NET_WORTH_PERSONAL_EXPLANATION =
  'Personal level: what you and your partner own and owe in your own names, plus your share of joint items (split equally unless a different split is recorded). It does not include any SMSF, trust, HUF or company assets.';
export const NET_WORTH_FAMILY_EXPLANATION =
  'Family level: the personal level plus your entities, shown separately: SMSF, family trusts and HUFs in full, and companies at your ownership share. Entity data stays recorded separately; this is a combined view for reporting.';

export function computeNetWorthLevels(input: NetWorthLevelsInput): NetWorthLevels {
  const unconvertedByCurrency: Record<string, number> = {};
  let unconvertedCount = 0;

  const selfDirect = emptyTotals();
  const spouseDirect = emptyTotals();
  const otherDirect = emptyTotals();
  const selfJoint = emptyTotals();
  const spouseJoint = emptyTotals();
  const otherJoint = emptyTotals();
  const jointPool = emptyTotals();
  let usedDefaultSplit = false;
  let usedRecordedSplit = false;

  interface TagAccumulator {
    totals: Totals;
    count: number;
    netted: { count: number; amount: number };
  }
  const tags = new Map<NetWorthEntityKind, TagAccumulator>();
  const tagOf = (k: NetWorthEntityKind): TagAccumulator => {
    let a = tags.get(k);
    if (!a) {
      a = { totals: emptyTotals(), count: 0, netted: { count: 0, amount: 0 } };
      tags.set(k, a);
    }
    return a;
  };

  for (const row of input.rows) {
    if (row.amountReporting === null || !Number.isFinite(row.amountReporting)) {
      unconvertedCount += 1;
      const code = row.currencyCode ?? 'unknown';
      unconvertedByCurrency[code] = (unconvertedByCurrency[code] ?? 0) + 1;
      continue;
    }
    const amount = row.amountReporting;
    const isLiability = row.register === 'liabilities';

    // LR-12R: a loan linked to an SMSF fund is the fund's debt whatever its owner tag says.
    const effectiveOwner = isLiability && row.smsfLinkedLoan ? 'smsf' : row.owner;

    if (isLiability && row.smsfLinkedLoan && row.nettedInFundBalance) {
      // Already subtracted inside the fund's own balance: counted once, there. Memo only.
      const acc = tagOf('smsf');
      acc.netted.count += 1;
      acc.netted.amount += amount;
      continue;
    }

    const entityKind = entityKindOfOwner(effectiveOwner);
    if (entityKind) {
      const acc = tagOf(entityKind);
      addToTotals(acc.totals, row.register, amount);
      acc.count += 1;
      continue;
    }

    if (effectiveOwner === 'self') {
      addToTotals(selfDirect, row.register, amount);
    } else if (effectiveOwner === 'spouse') {
      addToTotals(spouseDirect, row.register, amount);
    } else if (effectiveOwner === 'joint') {
      addToTotals(jointPool, row.register, amount);
      let shares: readonly NetWorthJointShare[] = DEFAULT_JOINT_SHARES;
      if (validShares(row.jointShares)) {
        shares = row.jointShares;
        usedRecordedSplit = true;
      } else {
        usedDefaultSplit = true;
      }
      const split = attributeByBasisPoints(
        amount,
        shares.map((s, i) => ({ key: `${i}`, basisPoints: s.basisPoints })),
      );
      // attributeByBasisPoints only fails on an invalid split, which validShares/the default rule out.
      const parts = split ?? [{ key: '0', basisPoints: 10000, amount }];
      parts.forEach((p, i) => {
        const role = (split ? shares[i].role : 'self') as NetWorthRole;
        addToTotals(role === 'self' ? selfJoint : role === 'spouse' ? spouseJoint : otherJoint, row.register, p.amount);
      });
    } else {
      // child, other, no owner recorded: a household item with no individual owner.
      addToTotals(otherDirect, row.register, amount);
    }
  }

  const selfD = finalise(selfDirect);
  const spouseD = finalise(spouseDirect);
  const otherD = finalise(otherDirect);
  const selfJ = finalise(selfJoint);
  const spouseJ = finalise(spouseJoint);
  const otherJ = finalise(otherJoint);

  const parties: NetWorthParty[] = [
    { key: 'self', label: 'Self', direct: selfD, jointShare: selfJ, total: sumTotals([selfD, selfJ]) },
    { key: 'spouse', label: 'Spouse/Partner', direct: spouseD, jointShare: spouseJ, total: sumTotals([spouseD, spouseJ]) },
  ];
  const otherTotal = sumTotals([otherD, otherJ]);
  if (otherTotal.totalAssets !== 0 || otherTotal.liabilities !== 0) {
    parties.push({ key: 'other_household', label: 'Other household items (child, other, no owner recorded)', direct: otherD, jointShare: otherJ, total: otherTotal });
  }
  const personalTotal = sumTotals(parties.map((p) => p.total));

  // ---- Entities -----------------------------------------------------------
  const blocks: NetWorthEntityBlock[] = [];
  for (const kind of KIND_ORDER) {
    const acc = tags.get(kind);
    if (!acc) continue;
    const totals = finalise(acc.totals);
    const nettedLoans = kind === 'smsf' && acc.netted.count > 0 ? { count: acc.netted.count, amount: cents(acc.netted.amount) } : null;
    blocks.push({
      id: `tag:${kind}`,
      kind,
      source: 'owner_tag',
      name: kind === 'smsf' ? 'SMSF' : kind === 'family_trust' ? 'Family Trust (items tagged with this owner)' : 'Company (items tagged with this owner)',
      recordedOwnershipPercent: null,
      includedPercent: 100,
      basis: 'recorded',
      entityTotals: totals,
      included: totals,
      nettedLoans,
      note:
        kind === 'smsf'
          ? nettedLoans
            ? `${nettedLoans.count} SMSF property loan${nettedLoans.count === 1 ? '' : 's'} already deducted inside the fund balance are not deducted again.`
            : null
          : 'Recorded with this owner tag and counted as entered. The tag carries no ownership percentage.',
    });
  }
  for (const e of input.entities ?? []) {
    const percent = e.kind === 'company' ? e.ownershipPercent : 100;
    const factor = percent / 100;
    const full = emptyTotals();
    if (e.detail) {
      full.entityValue = 0;
      full.assets = e.detail.assets;
      full.liabilities = e.detail.liabilities;
    } else {
      full.entityValue = e.netAssetValue;
    }
    const entityTotals = finalise(full);
    blocks.push({
      id: `entity:${e.id}`,
      kind: e.kind,
      source: 'registry',
      name: e.name,
      recordedOwnershipPercent: e.ownershipPercent,
      includedPercent: percent,
      basis: e.kind === 'company' ? 'ownership_share' : 'full',
      entityTotals,
      included: scaleTotals(entityTotals, factor),
      nettedLoans: null,
      note:
        e.kind === 'company'
          ? `Counted at your ${e.ownershipPercent}% ownership share of the company's net value.`
          : e.ownershipPercent < 100
            ? `Counted in full. The ${e.ownershipPercent}% ownership percentage recorded is not applied to a ${KIND_LABEL[e.kind]} (PO decision 16-10-2026).`
            : 'Counted in full.',
    });
  }

  const byKind = {} as Record<NetWorthEntityKind, Totals>;
  for (const kind of KIND_ORDER) byKind[kind] = sumTotals(blocks.filter((b) => b.kind === kind).map((b) => b.included));
  const entitiesTotal = sumTotals(blocks.map((b) => b.included));
  const family = sumTotals([personalTotal, entitiesTotal]);

  const reconciliation: NetWorthReconciliationLine[] = [
    { key: 'personal', label: 'Personal level (Self, Spouse/Partner, joint shares)', net: personalTotal.net },
    ...KIND_ORDER.filter((k) => blocks.some((b) => b.kind === k)).map((k) => ({
      key: k,
      label: `${KIND_LABEL[k]}${k === 'company' ? ' (at ownership share)' : ' (in full)'}`,
      net: byKind[k].net,
    })),
    { key: 'family', label: 'Family level (consolidated)', net: family.net },
  ];

  // ---- Bridge to the previously reported figure ---------------------------
  const bridgeLines: NetWorthBridgeLine[] = [];
  const smsfBlock = blocks.find((b) => b.kind === 'smsf' && b.source === 'owner_tag');
  if (smsfBlock?.nettedLoans) {
    bridgeLines.push({
      key: 'smsf_loan_counted_once',
      label: 'SMSF property loan already deducted inside the fund balance (previously deducted twice)',
      amount: -smsfBlock.nettedLoans.amount,
    });
  }
  const trustHufDelta = (input.entities ?? [])
    .filter((e) => e.kind !== 'company')
    .reduce((sum, e) => sum - e.netAssetValue * (1 - e.ownershipPercent / 100), 0);
  if (cents(trustHufDelta) !== 0) {
    bridgeLines.push({
      key: 'trust_huf_included_in_full',
      label: 'Family Trust / HUF now counted in full instead of at the recorded ownership percentage',
      amount: cents(trustHufDelta),
    });
  }
  let reproduced = family.net + bridgeLines.reduce((s, l) => s + l.amount, 0);
  let parityOk: boolean | null = null;
  const prev = input.previouslyReported ?? null;
  if (prev !== null && Number.isFinite(prev)) {
    const residual = cents(prev - reproduced);
    parityOk = Math.abs(residual) <= 0.05;
    if (!parityOk) bridgeLines.push({ key: 'unexplained', label: 'Difference not explained by the rules above (please report this)', amount: residual });
    reproduced = cents(reproduced + (parityOk ? 0 : residual));
  } else {
    reproduced = cents(reproduced);
  }

  // ---- Duplicate-entry risk (legacy tag AND registry entity for the same kind) ----
  const dupKinds = (['family_trust', 'company'] as const).filter(
    (k) => blocks.some((b) => b.kind === k && b.source === 'owner_tag') && blocks.some((b) => b.kind === k && b.source === 'registry'),
  );
  const duplicateRisk =
    dupKinds.length > 0
      ? `You have items tagged "${dupKinds.map((k) => KIND_LABEL[k]).join('" and "')}" as an owner AND a registered ${dupKinds.map((k) => KIND_LABEL[k]).join(' / ')} entity. Check the same assets are not entered in both places, because both are counted.`
      : null;

  const jointSplitBasis: NetWorthLevels['personal']['jointSplitBasis'] =
    usedDefaultSplit && usedRecordedSplit ? 'mixed' : usedRecordedSplit ? 'recorded' : usedDefaultSplit ? 'default_equal' : 'none';
  const jointSplit =
    jointSplitBasis === 'none'
      ? null
      : jointSplitBasis === 'recorded'
        ? 'Joint items are divided by the ownership split recorded for each account.'
        : jointSplitBasis === 'default_equal'
          ? 'Joint items are divided equally (50/50) because no other split is recorded. Each joint item is counted once.'
          : 'Joint items are divided by the recorded split where there is one, otherwise equally (50/50). Each joint item is counted once.';

  return {
    schemaVersion: 1,
    currency: input.currency,
    personal: { parties, jointPool: finalise(jointPool), jointSplitBasis, total: personalTotal },
    entities: { blocks, byKind, total: entitiesTotal },
    family,
    reconciliation,
    bridge: { previouslyReported: prev, reproduced, lines: bridgeLines, parityOk },
    dataStatus: {
      unconvertedCount,
      unconvertedByCurrency,
      unavailable: [...(input.unavailable ?? [])],
      duplicateRisk,
    },
    hasEntities: blocks.length > 0,
    explanation: { personal: NET_WORTH_PERSONAL_EXPLANATION, family: NET_WORTH_FAMILY_EXPLANATION, jointSplit },
  };
}

/**
 * Converts a registered entity (summary or detailed) to the model's input. The arithmetic is the
 * certified computeBusinessEntityNetAssetValue (single FX rate), unchanged.
 */
export function toNetWorthEntityInput(
  row: BusinessEntityWithLineItems,
  reportingCurrency: SupportedCurrency,
  fxRateAudInr: number,
): NetWorthEntityInput | null {
  if (!row.entity.is_active) return null;
  const t = row.entity.entity_type;
  const kind: NetWorthEntityInput['kind'] = t === 'family_trust' ? 'family_trust' : t === 'huf' ? 'huf' : 'company';
  const net = computeBusinessEntityNetAssetValue(row, reportingCurrency, fxRateAudInr);
  let detail: NetWorthEntityInput['detail'] = null;
  if (row.entity.valuation_mode === 'detailed') {
    // Same conversion the certified net-value function applies; gross sides shown so the entity reads like a balance sheet.
    const assets = row.assets.reduce((s, a) => s + convertAmount(a.value, a.currency_code, reportingCurrency, fxRateAudInr), 0);
    const liabilities = row.liabilities.reduce((s, l) => s + convertAmount(l.value, l.currency_code, reportingCurrency, fxRateAudInr), 0);
    detail = { assets, liabilities };
  }
  return {
    id: row.entity.id,
    name: row.entity.name?.trim() || KIND_LABEL[kind],
    kind,
    ownershipPercent: Number(row.entity.ownership_percentage),
    netAssetValue: net,
    detail,
  };
}

function convertAmount(amount: number, code: string | null | undefined, reporting: SupportedCurrency, fx: number): number {
  const c = code === 'AUD' || code === 'INR' ? code : null;
  return c ? convertToReportingCurrency(amount, c, reporting, fx) : amount;
}

/**
 * One plain-language summary of both levels, used verbatim on the Dashboard, the Net Worth section
 * and the report so no surface words it differently. `fmt` formats a reporting-currency amount.
 */
export function describeNetWorthLevels(levels: NetWorthLevels, fmt: (n: number) => string): string {
  const parts: string[] = [];
  parts.push(
    `Personal net worth (you and your partner, including your share of joint items): ${fmt(levels.personal.total.net)}.`,
  );
  if (levels.hasEntities) {
    const bits = KIND_ORDER.filter((k) => levels.entities.blocks.some((b) => b.kind === k)).map(
      (k) => `${KIND_LABEL[k]} ${fmt(levels.entities.byKind[k].net)}${k === 'company' ? ' (your ownership share)' : ''}`,
    );
    parts.push(
      `Family net worth, which adds your entities (${bits.join(', ')}), is ${fmt(levels.family.net)}. SMSF, trusts and HUFs are counted in full and companies at your ownership share.`,
    );
  } else {
    parts.push(`Family net worth is ${fmt(levels.family.net)}: you have no SMSF, trust, HUF or company items recorded, so it equals the personal figure.`);
  }
  const explained = levels.bridge.lines.filter((l) => l.key !== 'unexplained');
  if (levels.bridge.previouslyReported !== null && explained.length > 0) {
    parts.push(
      `Net worth was previously reported as ${fmt(levels.bridge.previouslyReported)}; that earlier figure is the family figure adjusted by: ${explained
        .map((l) => `${l.label} (${l.amount >= 0 ? '+' : '-'}${fmt(Math.abs(l.amount))})`)
        .join('; ')}.`,
    );
  }
  return parts.join(' ');
}
