/**
 * Owner-before-upload -- privacy (PO final-completion item h).
 *
 *   1. Owner metadata SURVIVES the raw-file purge: no purge patch (FDH, Investment Intelligence, AIE) may name
 *      an owner column. Who a document belongs to is a retained fact about the derived data, not raw material.
 *   2. Nothing that carries the owner can carry a full account / PAN / card number: the wire format is strict
 *      (an extra key such as `accountNumber` or `pan` is refused, so it can never be stored), the owner
 *      conflict messages contain no long digit run, and the owner modules never write to a console.
 *   3. Owner data is never an AI input: no AI prompt / provider module imports ownership code or reads an owner.
 *
 * Every static scan has a NEGATIVE CONTROL showing the scanner flags a seeded violation.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildStatementUploadPurgePatch, PURGE_RETAINED_STATEMENT_UPLOAD_COLUMNS } from '@/lib/financial-data-hub/domain/privacy';
import { validateOwnerSelectionAgainst, type OwnerContext } from '@/lib/ownership/validateOwnerSelection';
import { BankIdenticalUploadOwnerConflictError, BankOwnerConflictError } from '@/lib/financial-data-hub/services/bankOwnerAttribution';
import { DocumentOwnerConflictError } from '@/lib/financial-data-hub/services/documentOwnerRequest';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const OWNER_COLUMN = /\bowner_(member_id|business_entity_id|role|selection_source|allocation|review|selection)\b/;

/** PURE. The object-literal keys passed to every `.update({ ... })` in a source file. */
export function updatedColumns(source: string): string[] {
  const out: string[] = [];
  const re = /\.update\(\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    for (const key of m[1].matchAll(/(?:^|[,\s])([a-z_][a-z0-9_]*)\s*:/gi)) out.push(key[1]);
  }
  return out;
}

describe('owner metadata survives the raw-document purge', () => {
  it('the FDH statement-upload purge patch names no owner column, and every retained owner column is listed', () => {
    const patch = Object.keys(buildStatementUploadPurgePatch(new Date().toISOString()));
    expect(patch.filter((k) => OWNER_COLUMN.test(k))).toEqual([]);
    expect([...PURGE_RETAINED_STATEMENT_UPLOAD_COLUMNS].sort()).toEqual(['owner_allocation', 'owner_business_entity_id', 'owner_member_id', 'owner_role', 'owner_selection_source']);
    for (const col of PURGE_RETAINED_STATEMENT_UPLOAD_COLUMNS) expect(patch).not.toContain(col);
  });

  it('no FDH purge service update writes an owner column', () => {
    expect(updatedColumns(read('lib/financial-data-hub/services/purge.ts')).filter((c) => OWNER_COLUMN.test(c))).toEqual([]);
    expect(updatedColumns(read('lib/financial-data-hub/services/uploadLifecycle.ts')).filter((c) => OWNER_COLUMN.test(c))).toEqual([]);
  });

  it('the Investment Intelligence source-document purge only writes storage_purge_* columns (the owner stays on the row)', () => {
    const cols = updatedColumns(read('lib/services/investment-intelligence/sourceDocumentPurge.ts'));
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.filter((c) => !/^storage_purge/.test(c))).toEqual([]);
  });

  it('the AIE purge never touches aie_document_intake.owner_selection (the validated owner outlives the quarantined bytes)', () => {
    expect(updatedColumns(read('lib/aie/services/purge.ts')).filter((c) => OWNER_COLUMN.test(c))).toEqual([]);
    // the ONLY writer of owner_selection is the intake-time recorder
    const writers = ['lib/aie/db/repository.ts', 'lib/aie/services/purge.ts', 'lib/aie/review/accept.ts'].filter((f) => /owner_selection/.test(read(f)));
    expect(writers).toEqual([]);
    expect(read('lib/aie/intakeOwner.ts')).toMatch(/update\(\{ owner_selection: selection/);
  });

  it('NEGATIVE CONTROL: the scanner flags a purge that would null an owner column', () => {
    const bad = "await admin.from('fdh_statement_uploads').update({ raw_document_storage_reference: null, owner_role: null }).eq('id', id);";
    expect(updatedColumns(bad).filter((c) => OWNER_COLUMN.test(c))).toEqual(['owner_role']);
  });
});

describe('the owner wire format cannot carry an identifier', () => {
  const ctx: OwnerContext = {
    homeCountry: 'IN',
    members: [{ id: 'a1111111-1111-4111-8111-111111111111', fullName: 'Anil', relationship: 'self', isActive: true }],
    entities: [{ id: 'e1111111-1111-4111-8111-111111111111', name: 'Sharma Family Trust', entityType: 'family_trust', isActive: true }],
  };
  const SELF = 'a1111111-1111-4111-8111-111111111111';
  const code = (input: unknown, flow: 'bank' | 'ii_cas' = 'ii_cas') => {
    const r = validateOwnerSelectionAgainst(ctx, input, flow);
    return r.ok ? 'ok' : r.code;
  };

  it('a PAN / account / card number smuggled in as an extra key is refused, never stored', () => {
    expect(code({ kind: 'member', memberId: SELF, pan: 'ABCDE1234F' })).toBe('owner_invalid');
    expect(code({ kind: 'member', memberId: SELF, accountNumber: '4111111111111111' })).toBe('owner_invalid');
    expect(code({ kind: 'entity', entityId: 'e1111111-1111-4111-8111-111111111111', cardNumber: '4111111111111111' })).toBe('owner_invalid');
    expect(code({ kind: 'smsf', accountNumber: '123456789' }, 'bank')).toBe('owner_invalid');
    expect(code({ kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 5000, pan: 'ABCDE1234F' }, { memberId: SELF, basisPoints: 5000 }] })).toBe('owner_invalid');
  });

  it('CONTROL: the same selection without the extra key is accepted', () => {
    expect(code({ kind: 'member', memberId: SELF })).toBe('ok');
  });

  it('the owner identity is an id, never free text: a name or number in place of a uuid is refused', () => {
    expect(code({ kind: 'member', memberId: 'Anil Sharma' })).toBe('owner_invalid');
    expect(code({ kind: 'member', memberId: '4111111111111111' })).toBe('owner_invalid');
  });

  it('owner-conflict messages carry no long digit run (no account / PAN / card number can appear in them)', () => {
    const messages = [
      new BankOwnerConflictError('self', 'spouse', 'acc-1').message,
      new BankOwnerConflictError('joint', 'smsf', 'acc-2').message,
      new BankIdenticalUploadOwnerConflictError('doc-1', 'self', 'spouse').message,
      new BankIdenticalUploadOwnerConflictError('doc-2', null, 'joint').message,
      new DocumentOwnerConflictError('doc-3', 'self').message,
    ];
    for (const m of messages) expect(m).not.toMatch(/\d{5,}/);
  });
});

describe('no owner module logs, and no AI input carries the owner', () => {
  const OWNER_MODULES = [
    'lib/ownership/ownerSelection.ts',
    'lib/ownership/validateOwnerSelection.ts',
    'lib/ownership/ownerOptions.ts',
    'lib/ownership/jointDraft.ts',
    'lib/ownership/documentOwnerKey.ts',
    'lib/aie/intakeOwner.ts',
    'lib/financial-data-hub/services/bankOwnerAttribution.ts',
    'lib/financial-data-hub/services/bankOwnerRequest.ts',
    'lib/financial-data-hub/services/documentOwnerRequest.ts',
    'lib/financial-data-hub/services/bankAccountAssignment.ts',
    'lib/investment-import-bridge/auDocumentOwner.ts',
    'lib/services/investment-intelligence/uploadOwner.ts',
    'app/api/ownership/options/route.ts',
    'app/api/ownership/self/route.ts',
  ];
  const consoleCalls = (src: string) => src.split('\n').filter((l) => /\bconsole\.(log|info|warn|error|debug)\b/.test(l) && !/^\s*(\*|\/\/)/.test(l));

  it('none of the owner modules writes to a console (no identifier can reach a log through them)', () => {
    for (const rel of OWNER_MODULES) expect(consoleCalls(read(rel)), rel).toEqual([]);
  });

  it('NEGATIVE CONTROL: the console scanner flags a real console call and ignores a comment', () => {
    expect(consoleCalls("console.log('account', accountNumber);")).toHaveLength(1);
    expect(consoleCalls(" * console.log is not used here")).toHaveLength(0);
  });

  it('no AI prompt / provider module imports ownership code or reads an owner field', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.ts$/.test(e.name)) {
          const src = read(rel);
          if (/@\/lib\/ownership|ownerSelection|owner_selection|owner_member_id|ownerMemberId|owner_business_entity_id/.test(src)) offenders.push(rel);
        }
      }
    };
    walk('lib/aie/provider');
    expect(offenders).toEqual([]);
    for (const rel of ['lib/services/investment-intelligence/aiFallbackDocumentExtraction.ts']) {
      expect(/@\/lib\/ownership|owner_selection|ownerSelection/.test(read(rel)), rel).toBe(false);
    }
  });

  it('the GET options route is read-only and never cached across users', () => {
    const src = read('app/api/ownership/options/route.ts');
    expect(src).toMatch(/dynamic = 'force-dynamic'/);
    expect(src).toMatch(/Cache-Control': 'no-store'/);
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
});
