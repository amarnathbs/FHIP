/**
 * Financial Data Hub — FDH-3 orphan-artefact detection (spec sections 49,
 * 69). Pure set comparison: given the storage keys that actually exist in
 * the bucket and the storage keys the database currently references, find
 * both directions of drift. No deletion logic lives here — detection and
 * deletion are deliberately separate (spec: "do not automatically purge
 * unknown production objects without safeguards").
 */

export interface OrphanReport {
  /** A storage object exists with no owning document row referencing it. */
  orphanStorageObjects: string[];
  /** A document row references a storage key that does not exist in the bucket. */
  orphanDbReferences: string[];
}

export function detectOrphans(liveStorageKeys: readonly string[], liveDocumentStorageKeys: readonly string[]): OrphanReport {
  const referenced = new Set(liveDocumentStorageKeys);
  const existing = new Set(liveStorageKeys);
  return {
    orphanStorageObjects: liveStorageKeys.filter((k) => !referenced.has(k)),
    orphanDbReferences: liveDocumentStorageKeys.filter((k) => !existing.has(k)),
  };
}
