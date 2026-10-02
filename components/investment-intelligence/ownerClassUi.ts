// Investment Intelligence -- owner-class UI helpers (2026-10-01). Pure, unit-tested.

export const ALL_OWNER_CLASSES = 'all';
export const CONSOLIDATED_CHIP_LABEL = 'Consolidated (macro view only)';

/** Adds `ownerClass=<key>` to a same-origin API URL (existing query string kept). The default "all" adds nothing. */
export function withOwnerClass(url: string, ownerClass: string): string {
  if (!ownerClass || ownerClass === ALL_OWNER_CLASSES) return url;
  return `${url}${url.includes('?') ? '&' : '?'}ownerClass=${encodeURIComponent(ownerClass)}`;
}

export interface OwnerClassOption {
  key: string;
  kind: 'personal' | 'joint' | 'entity' | 'entity_shared' | 'unallocated';
  label: string;
  detail: string | null;
  accountCount: number;
}

/** "Rao Family Trust (Family trust)". */
export const ownerClassOptionLabel = (o: Pick<OwnerClassOption, 'label' | 'detail'>) => (o.detail ? `${o.label} (${o.detail})` : o.label);

export const ownerClassHeading = (kind: OwnerClassOption['kind']): string =>
  ({
    personal: 'Personal',
    joint: 'Joint (household members)',
    entity: 'Trust / HUF / Company',
    entity_shared: 'Shared with a trust, HUF or company',
    unallocated: 'Unallocated',
  })[kind];
