/**
 * `fdh_document_audit_events_event_type_check` — the chain, as a whole.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT PART OF ANY ONE PHASE'S TEST. Every
 * phase that widens this constraint DROPs it and recreates it with the full
 * cumulative list, so its history is a chain and most of the interesting
 * claims are about the chain rather than about any single link. Those claims
 * were previously carried inside `fdh10LiabilityCorrection.test.ts`, which
 * tied them to one phase for no reason; they live here now so the next
 * phase's test does not have to restate them.
 *
 * The per-link claim — "migration N adds exactly the constants belonging to
 * N" — is asserted here for EVERY link, and again in each phase's own contract
 * test for that phase's link. The duplication is deliberate: the phase test is
 * where a reader of that phase looks, and the sweep here is what guarantees no
 * link is left uncovered when a new one is added.
 *
 * Nothing in this file pins a migration FILENAME. A new widening costs one
 * entry in `AUDIT_EVENT_PHASE_CONSTANTS` and no edit here. The only numbers
 * are floors, which never need raising.
 */

import { describe, expect, it } from 'vitest';

import {
  AUDIT_EVENT_PHASE_CONSTANTS,
  auditEventBaseMigration,
  auditEventChainValues,
  auditEventDeltaFor,
  auditEventMigrationNamesBySubstring,
  auditEventPhaseConstantsFor,
  auditEventTypesIn,
  migrationNumberOf,
  namedAuditEventMigrations,
} from './helpers/auditEventChain';
import {
  FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES,
} from '@/lib/financial-data-hub/constants/enums';

describe('the fdh_document_audit_events event_type chain, as a whole', () => {
  it('the traversal finds every constraint-defining migration, and only those', () => {
    // The anti-vacuity guard for everything below. Two independent
    // derivations — parsing each value list, and a plain substring search for
    // the `add constraint` statement — must agree exactly. A traversal that
    // silently truncated, or picked up a migration that only MENTIONS the
    // constraint in a comment, fails here rather than quietly weakening the
    // claims that consume it.
    const parsed = namedAuditEventMigrations().map((m) => m.name);
    expect(parsed).toEqual(auditEventMigrationNamesBySubstring());
    // A floor, not a pin: this only ever grows.
    expect(parsed.length).toBeGreaterThanOrEqual(12);
    // ...and the ASYMMETRY is asserted rather than left implicit: the base is
    // deliberately absent from both NAMED derivations, because it never writes
    // the constraint name. A future reader who finds 0058 missing here should
    // find this line before concluding the traversal is broken.
    expect(parsed).not.toContain(auditEventBaseMigration().name);
  });

  it('the base is 0058, and its values are exactly the BASE TypeScript constant', () => {
    // 0058 never writes the constraint NAME (it is an unnamed inline column
    // check that Postgres names implicitly), so it is located separately and
    // is easy to leave out of the chain by accident — which makes 0064 look
    // like a 19-value base needing two named constants to explain.
    const base = auditEventBaseMigration();
    expect(base.name).toMatch(/^0058_/);
    expect([...base.values].sort()).toEqual([...FDH_DOCUMENT_AUDIT_EVENT_TYPES].sort());
  });

  it('the LATEST constraint-defining migration matches the TypeScript enum exactly', () => {
    // The "nothing in the enum is unreachable in SQL, and nothing in SQL is
    // missing from the enum" guarantee, which the per-phase subtraction form
    // slowly lost. Whichever migration is newest owns this claim, derived from
    // the ledger — NO filename is pinned, so the next widening needs no edit.
    const chain = namedAuditEventMigrations();
    const latest = chain[chain.length - 1];
    // ...and "latest" really is the highest-numbered one, established without
    // relying on the traversal that produced it.
    const highest = auditEventMigrationNamesBySubstring().slice(-1)[0];
    expect(latest.name).toBe(highest);
    expect([...auditEventTypesIn(latest.sql)].sort())
      .toEqual([...FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES].sort());
  });

  it('every link is a strict superset of the one before it', () => {
    // This is the assertion that would have caught 0185-drafted-against-0173
    // at any point in the two days it sat unmerged, and it will catch the next
    // one without being edited. Runs over the WHOLE chain, base included, so
    // the 0058 -> 0064 link is covered like every other.
    const chain = auditEventChainValues();
    expect(chain.length).toBeGreaterThanOrEqual(13);
    for (let i = 1; i < chain.length; i += 1) {
      const { values: before } = chain[i - 1];
      const { values: after } = chain[i];
      for (const value of before) {
        expect(after, `${chain[i].name} revokes ${value}, which ${chain[i - 1].name} grants`)
          .toContain(value);
      }
      expect(after.length, `${chain[i].name} widens nothing`).toBeGreaterThan(before.length);
    }
  });

  it('revokes NOTHING, anywhere in its entire history', () => {
    // The standing invariant, stated once against the whole ledger rather than
    // inferred link by link. It is currently true, and it is exactly what
    // migration 0185 broke for two days before it was caught. Kept separate
    // from the superset claim above so a failure names revocation as the
    // finding rather than a superset arithmetic detail.
    const chain = auditEventChainValues();
    const granted = new Set<string>();
    for (const link of chain) {
      for (const value of granted) {
        expect(link.values, `${link.name} revokes ${value}, granted earlier in the chain`)
          .toContain(value);
      }
      for (const value of link.values) granted.add(value);
    }
    expect(granted.size).toBe(FDH_ALL_DOCUMENT_AUDIT_EVENT_TYPES.length);
  });

  it('every link adds exactly the phase constants registered for it', () => {
    // The replacement for six per-phase "enum minus every later phase"
    // subtractions. Each link is compared only against ITS OWN constants, so
    // adding a widening never edits an existing assertion.
    //
    // This also covers the links no phase contract test owns — 0068 and 0071
    // belong to r8/fdh5SchemaContract.test.ts, which use the cumulative
    // additive form instead and so were never part of the subtrahend problem.
    for (const { name } of auditEventChainValues()) {
      const number = migrationNumberOf(name);
      const { added, revoked } = auditEventDeltaFor(number);
      expect(revoked, `${name} revokes values its predecessor granted`).toEqual([]);
      expect([...added].sort(), `${name}'s delta is not its registered phase constants`)
        .toEqual([...auditEventPhaseConstantsFor(number)].sort());
    }
  });

  it('every constraint-defining migration is registered, and every registration is real', () => {
    // Completeness in BOTH directions. Left to right: a new widening that
    // forgets its map entry fails here (and in the delta sweep above) instead
    // of silently widening the enum with nothing asserting what it added.
    // Right to left: an entry for a migration that no longer defines the
    // constraint is dead weight that would make the map lie about the ledger.
    const inLedger = auditEventChainValues().map((link) => migrationNumberOf(link.name)).sort();
    const registered = [...AUDIT_EVENT_PHASE_CONSTANTS.keys()].sort();
    expect(registered).toEqual(inLedger);
  });

  it('no two migrations in the chain claim the same version number', () => {
    const numbers = auditEventChainValues().map((link) => migrationNumberOf(link.name));
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
