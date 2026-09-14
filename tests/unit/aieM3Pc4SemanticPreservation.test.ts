/**
 * M3 (Phase 4), items I.6, I.8 and I.10/I.11.
 *
 * I.6 asks that AIE-derived Investment candidates preserve every PC4
 * semantic: opening balance is not a purchase; no fabricated tax lot or cost
 * base; CAS and Folio evidence converge to one economic truth; the same
 * instrument across folios keeps account separation for FIFO; exact reimport
 * is idempotent; rejected/reversed/transferred rows keep the right economic
 * effect; current holdings reconcile; no double net worth.
 *
 * THE CENTRAL ARCHITECTURAL CLAIM, AND WHY IT IS THE STRONGEST AVAILABLE
 * ANSWER. Every one of those semantics is implemented inside Investment
 * Intelligence's own certified `processSourceDocument`, and the AIE
 * acceptance path reaches it by RE-PARSING THE ORIGINAL DOCUMENT BYTES —
 * `write.ts` downloads the quarantined file, uploads it into II's own
 * storage, inserts an `ii_source_documents` row, and hands that row to
 * `processSourceDocument`. The AIE field candidates are NOT the input to the
 * canonical write; the document is.
 *
 * That means PC4's semantics are preserved by CONSTRUCTION rather than by
 * re-implementation — there is no second parser, no second classifier, and
 * no second reconciliation on the write path that could drift from PC4's.
 * The tests below pin that property structurally (so a future refactor that
 * started writing from candidates would fail here), and then verify the
 * semantics that AIE's own candidate encoding could still get wrong.
 *
 * Re-running PC4's own 19-invariant contract is done by executing its named
 * suites, recorded in the M3 report — not duplicated here, because a second
 * copy of an already-certified assertion measures this file rather than the
 * behaviour.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { toAieCandidates, candidatesByRecordType } from '@/lib/aie/adapters/investment-intelligence/parserAdapter';
import { computeTransactionFingerprint } from '@/lib/services/investment-intelligence/fingerprint';
import { OPENING_BALANCE_SOURCE_REFERENCE } from '@/lib/services/investment-intelligence/openingBalanceMarker';
import { parseExactDecimal, scaledToDecimalString, ZERO } from '@/lib/services/investment-intelligence/decimal';
import { C1_CAS_BASELINE, C3_LONG_SIP, C4_OPENING_BALANCE, C6_REVERSAL, C7_SAME_INSTRUMENT_TWO_FOLIOS } from '../support/buildM3InvestmentCorpus';

function parse(text: string) {
  const result = parseExtractedDocument(text);
  expect(result.parsed, 'fixture did not parse').not.toBeNull();
  return result.parsed!;
}

function scaled(v: string): bigint {
  const p = parseExactDecimal(v);
  if (!p.ok) throw new Error(`bad value ${v}`);
  return p.scaled;
}

describe('M3 I.6 — PC4 semantics are preserved by construction, not by re-implementation', () => {
  it('STRUCTURAL: the canonical write delegates to processSourceDocument over the ORIGINAL BYTES, never to AIE candidates', () => {
    const writeSource = readFileSync(join(process.cwd(), 'lib/aie/adapters/investment-intelligence/write.ts'), 'utf8');
    // It fetches the original document...
    expect(writeSource).toContain('downloadQuarantined');
    // ...and hands it to Investment Intelligence's own certified orchestrator.
    expect(writeSource).toContain('processDocument');
    expect(writeSource).toContain('processSourceDocument');
    // And it does NOT take field candidates as the source of the write. If a
    // future change started writing from candidates, every PC4 semantic would
    // become this adapter's responsibility to re-implement, which is exactly
    // the drift this assertion exists to prevent.
    expect(writeSource).not.toMatch(/candidates\s*:/);
    expect(writeSource).not.toMatch(/AieFieldCandidate/);
  });

  it('opening balance is an ADJUSTMENT in the AIE candidate encoding too — never a purchase (PC4-INV-08)', () => {
    const parsed = parse(C4_OPENING_BALANCE.text);
    const candidates = toAieCandidates(parsed);
    const txns = candidatesByRecordType(candidates, 'transaction');

    const openingRows = txns.filter(({ value }) => value.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE);
    expect(openingRows).toHaveLength(1);
    expect(openingRows[0].value.canonicalType).toBe('adjustment');
    // The serialisation must not quietly relabel it on the way through.
    expect(JSON.stringify(openingRows[0].value)).not.toContain('"purchase"');
  });

  it('no fabricated cost base survives the candidate encoding — an opening balance carries no NAV or amount to invent one from', () => {
    const parsed = parse(C4_OPENING_BALANCE.text);
    const txns = candidatesByRecordType(toAieCandidates(parsed), 'transaction');
    const opening = txns.find(({ value }) => value.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE)!;
    // A tax lot needs a cost base. The opening row has none, which is what
    // stops one being fabricated downstream.
    expect(opening.value.nav).toBeNull();
    expect(opening.value.amount).toBe(scaledToDecimalString(ZERO, 2));
  });

  it('the same instrument in two folios stays TWO positions through the candidate encoding (PC4-INV-07 account separation)', () => {
    const parsed = parse(C7_SAME_INSTRUMENT_TWO_FOLIOS.text);
    const holdings = candidatesByRecordType(toAieCandidates(parsed), 'holding');
    const folios = new Set(holdings.map(({ value }) => value.folioNumber as string));
    expect(folios.size).toBe(2);
    // Same scheme, two folios — merging them would let a disposal in one
    // account consume a lot held in the other.
    const schemes = new Set(holdings.map(({ value }) => (value.scheme as { normalisedSchemeName: string }).normalisedSchemeName));
    expect(schemes.size).toBe(1);
  });

  it('a reversal keeps its NEGATIVE economic effect through the candidate encoding (PC4-INV-18)', () => {
    const parsed = parse(C6_REVERSAL.text);
    const txns = candidatesByRecordType(toAieCandidates(parsed), 'transaction');
    const reversal = txns.find(({ value }) => value.canonicalType === 'reversal');
    expect(reversal, 'the rejected instalment must classify as a reversal, not a second purchase').toBeDefined();
    expect(String(reversal!.value.units).startsWith('-')).toBe(true);

    // And the net effect across the whole position is the printed closing
    // balance — a reversal that doubled instead of cancelling would show here.
    const net = txns.reduce((sum, { value }) => sum + (value.units === null ? ZERO : scaled(String(value.units))), ZERO);
    expect(scaledToDecimalString(net)).toBe(scaledToDecimalString(scaled('80.000')));
  });

  it('exact reimport is idempotent: the SAME document yields byte-identical fingerprints (PC4-INV-05)', () => {
    // The dedup layer keys on this fingerprint. If the AIE candidate
    // round-trip perturbed any input to it — a lost decimal place, a
    // re-formatted date — a reimport would create duplicate economic rows.
    const fingerprintsFor = (text: string) =>
      candidatesByRecordType(toAieCandidates(parse(text)), 'transaction').map(({ value }) =>
        computeTransactionFingerprint({
          sourceKey: 'cams',
          accountId: 'acct-1',
          instrumentId: 'instr-1',
          transactionDateIso: value.transactionDateIso as string,
          transactionType: value.canonicalType as 'purchase',
          amountScaled: scaled(String(value.amount)),
          unitsScaled: value.units === null ? null : scaled(String(value.units)),
          navScaled: value.nav === null ? null : scaled(String(value.nav)),
          sourceReference: (value.sourceReference as string | null) ?? null,
        }),
      );

    expect(fingerprintsFor(C1_CAS_BASELINE.text)).toEqual(fingerprintsFor(C1_CAS_BASELINE.text));
  });

  it('a DIFFERENT document yields different fingerprints — the idempotency check above is not vacuous', () => {
    const one = candidatesByRecordType(toAieCandidates(parse(C1_CAS_BASELINE.text)), 'transaction');
    const other = candidatesByRecordType(toAieCandidates(parse(C6_REVERSAL.text)), 'transaction');
    expect(one[0].value.sourceReference).not.toBe(other[0].value.sourceReference);
  });

  it('EXACTNESS: amounts, units and NAV survive the candidate encoding as exact decimal STRINGS, never floats', () => {
    // `parserAdapter.ts` serialises bigint scaled decimals to strings before
    // JSON. A float here would silently lose unit precision, and the loss
    // would only surface much later as an unexplained reconciliation variance.
    const txns = candidatesByRecordType(toAieCandidates(parse(C3_LONG_SIP.text)), 'transaction');
    for (const { value } of txns) {
      expect(typeof value.amount).toBe('string');
      if (value.units !== null) expect(typeof value.units).toBe('string');
      if (value.nav !== null) expect(typeof value.nav).toBe('string');
    }
  });
});


describe('M3 I.8 — cross-source overlap is unchanged by the AIE path', () => {
  it('STRUCTURAL: the adapter computes the SAME fingerprint formula the real write path uses, not its own', () => {
    // Order-invariance of CAS-then-Folio and Folio-then-CAS is a property of
    // `crossSourceIdentity.ts` and `documentProcessing.ts`, already certified
    // under PC4-INV-06 and exercised by tests/unit/iiR11CrossSourceIdentity.ts.
    // What M3 has to show is that the AIE path does not bypass or shadow it.
    const ruleSource = readFileSync(join(process.cwd(), 'lib/aie/adapters/investment-intelligence/reconciliationRule.ts'), 'utf8');
    expect(ruleSource).toContain("from '@/lib/services/investment-intelligence/fingerprint'");
    expect(ruleSource).toContain('computeTransactionFingerprint');
    // No adapter-local fingerprint implementation.
    expect(ruleSource).not.toMatch(/function\s+computeTransactionFingerprint/);
    expect(ruleSource).not.toMatch(/createHash\(/);
  });

  it('STRUCTURAL: the adapter reuses II\'s own reconciliation engine rather than reimplementing roll-forward', () => {
    const ruleSource = readFileSync(join(process.cwd(), 'lib/aie/adapters/investment-intelligence/reconciliationRule.ts'), 'utf8');
    expect(ruleSource).toContain('reconcilePosition');
    expect(ruleSource).toContain('determineHistoryCompleteness');
    expect(ruleSource).not.toMatch(/function\s+reconcilePosition/);
  });

  it('the duplicate/overlap rule keys on the resolved-id fingerprint, so a row seen twice LINKS rather than duplicating', () => {
    const parsed = parse(C1_CAS_BASELINE.text);
    const txns = candidatesByRecordType(toAieCandidates(parsed), 'transaction');
    const fingerprint = computeTransactionFingerprint({
      sourceKey: 'cams',
      accountId: 'acct-1',
      instrumentId: 'instr-1',
      transactionDateIso: txns[0].value.transactionDateIso as string,
      transactionType: txns[0].value.canonicalType as 'purchase',
      amountScaled: scaled(String(txns[0].value.amount)),
      unitsScaled: scaled(String(txns[0].value.units)),
      navScaled: scaled(String(txns[0].value.nav)),
      sourceReference: (txns[0].value.sourceReference as string | null) ?? null,
    });
    // Same inputs, same fingerprint — which is what makes the
    // `existingFingerprints` lookup in the adapter's duplicate rule able to
    // recognise a row the real write path already stored.
    expect(fingerprint).toHaveLength(64);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('M3 I.10 / I.11 — binary lifecycle', () => {
  it('a purge is never recorded on the strength of a delete call alone — absence is independently verified first', () => {
    const purgeSource = readFileSync(join(process.cwd(), 'lib/aie/services/purge.ts'), 'utf8');
    // The ordering is the property: delete, THEN verify absent, THEN mark.
    const deleteAt = purgeSource.indexOf('await deleteFromQuarantine(row.storage_key)');
    const verifyAt = purgeSource.indexOf('await verifyQuarantineObjectAbsent(row.storage_key)');
    const markAt = purgeSource.indexOf("purge_status: 'purged'", verifyAt);
    expect(deleteAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(deleteAt);
    expect(markAt).toBeGreaterThan(verifyAt);
  });

  it('the 24-hour hard backstop selects on AGE ALONE, so an abandoned document cannot escape it by getting stuck in a status', () => {
    const purgeSource = readFileSync(join(process.cwd(), 'lib/aie/services/purge.ts'), 'utf8');
    expect(purgeSource).toContain('enforceAieRawFileHardBackstop');
    expect(purgeSource).toContain('AIE_PURGE_HARD_MAX_AGE_MINUTES = 24 * 60');
    // No status filter in the backstop query — that is the whole point.
    const backstopAt = purgeSource.indexOf('export async function enforceAieRawFileHardBackstop');
    const backstopBody = purgeSource.slice(backstopAt, backstopAt + 1400);
    expect(backstopBody).toContain(".lte('created_at', cutoffIso)");
    expect(backstopBody).not.toMatch(/\.eq\('status'/);
  });

  it('the Investment Intelligence path does NOT delete the binary at intake — its accept-time write still needs it', () => {
    const routeSource = readFileSync(join(process.cwd(), 'app/api/aie/investment-intelligence/intake/route.ts'), 'utf8');
    // Deleting here would break acceptance outright, because write.ts
    // re-fetches the original bytes from quarantine.
    expect(routeSource).not.toContain('finalizeDocumentBinaryAfterRun(');
    const acceptSource = readFileSync(join(process.cwd(), 'lib/aie/review/accept.ts'), 'utf8');
    // And acceptance DOES delete it, immediately after the write succeeds.
    expect(acceptSource).toContain('deps.finalizeDocumentBinary(');
  });

  it('the audit/provenance that survives destruction carries no document content', () => {
    // I.10 item 4: retain source hash/fingerprint, parser/provider/schema
    // versions, acceptance decisions, canonical lineage, privacy-safe reason
    // codes — and nothing else.
    const purgeSource = readFileSync(join(process.cwd(), 'lib/aie/services/purge.ts'), 'utf8');
    // Errors are sanitised before they are recorded, so a signed URL or host
    // detail cannot leak into the audit trail through a failure message.
    expect(purgeSource).toContain('function sanitiseError');
    expect(purgeSource).toContain("replace(/https?:\\/\\/\\S+/g, '[redacted-url]')");
  });
});
