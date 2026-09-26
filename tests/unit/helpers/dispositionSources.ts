/**
 * Upload field-disposition gate -- the ENUMERATION side (WP-00).
 *
 * This module reads the REAL source tree and never trusts the registry:
 *  (a) TypeScript interfaces, parsed with the `typescript` compiler API;
 *  (b) zod AI-fallback schemas, imported at runtime (`.shape` keys);
 *  (c) database columns, replayed from supabase/migrations in ledger order
 *      (CREATE TABLE + ALTER TABLE ADD/DROP/RENAME COLUMN);
 *  (d) enum constants, imported at runtime;
 *  (e) literal `as const` field-name lists (insurance), parsed from source.
 *
 * `SOURCES` is the list of everything the registry must cover. Each entry has
 * a FLOOR -- the minimum number of keys the enumerator must find -- so a
 * parser that silently breaks (and finds nothing) fails loudly instead of
 * passing vacuously (registry rule R8).
 *
 * Every function here is pure over (file text) so the anti-vacuity tests can
 * feed it an in-memory, deliberately-modified copy of a real file.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { FDH_ECONOMIC_TRANSACTION_TYPES } from '@/lib/financial-data-hub/constants/enums';
import { LIABILITY_ACTIVITY_TYPES } from '@/lib/financial-data-hub/liability/types';
import { RETIREMENT_ACTIVITY_TYPES } from '@/lib/financial-data-hub/retirement/types';
import { AU_STATEMENT_TRANSACTION_TYPES } from '@/lib/financial-data-hub/investment/types';
import { bankStatementDocumentFactsSchema, bankStatementTransactionSchema } from '@/lib/aie/adapters/bankStatement/schema';
import { payslipDocumentFactsSchema } from '@/lib/aie/adapters/payslip/schema';
import { liabilityStatementActivitySchema, liabilityStatementDocumentFactsSchema } from '@/lib/aie/adapters/liability/schema';
import { retirementActivitySchema, retirementDocumentFactsSchema, retirementPositionSchema } from '@/lib/aie/adapters/retirement/schema';
import { auInvestmentActivitySchema, auInvestmentDocumentFactsSchema, auInvestmentHoldingSchema } from '@/lib/aie/adapters/auInvestment/schema';
import type { AdapterId, SourceKind } from '@/lib/canonical-data/disposition/types';

export const REPO_ROOT = path.resolve(__dirname, '../../..');

/** sourceRef prefixes (kept free of the FDH module path literal on purpose;
 * see lib/canonical-data/disposition/types.ts). */
export const SOURCE_PREFIX_DIRS: Record<string, string> = {
  'fdh:': 'lib/financial-data-hub/',
  'aie:': 'lib/aie/adapters/',
  'ii:': 'lib/services/investment-intelligence/',
};

export function resolveSourceFile(sourceRef: string): string {
  const [file] = sourceRef.split('#');
  for (const [prefix, dir] of Object.entries(SOURCE_PREFIX_DIRS)) {
    if (file.startsWith(prefix)) return path.join(REPO_ROOT, dir, file.slice(prefix.length));
  }
  throw new Error(`unresolvable sourceRef ${sourceRef}`);
}

// ---------------------------------------------------------------------------
// (a) TypeScript interface properties
// ---------------------------------------------------------------------------

/** Property names of `interfaceName` in `sourceText` (own members only). */
export function interfaceProperties(sourceText: string, interfaceName: string, fileName = 'x.ts'): string[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: string[] | null = null;
  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      found = node.members
        .filter((m): m is ts.PropertySignature => ts.isPropertySignature(m))
        .map((m) => (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : m.name.getText(sf)));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`interface ${interfaceName} not found in ${fileName}`);
  return found;
}

/** Elements of an exported `const NAME = [ ... ] as const` string list (identifiers resolved within the file). */
export function constStringList(sourceText: string, constName: string, fileName = 'x.ts'): string[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const strings = new Map<string, string>();
  let list: ts.ArrayLiteralExpression | null = null;
  const unwrap = (e: ts.Expression): ts.Expression => (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e);
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isStringLiteral(init)) strings.set(node.name.text, init.text);
      if (node.name.text === constName && ts.isArrayLiteralExpression(init)) list = init;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!list) throw new Error(`const ${constName} not found in ${fileName}`);
  return (list as ts.ArrayLiteralExpression).elements.map((el) => {
    if (ts.isStringLiteral(el)) return el.text;
    if (ts.isIdentifier(el) && strings.has(el.text)) return strings.get(el.text)!;
    throw new Error(`unsupported element in ${constName}: ${el.getText(sf)}`);
  });
}

// ---------------------------------------------------------------------------
// (b) zod schema keys
// ---------------------------------------------------------------------------

type ZodLike = { _def?: { schema?: ZodLike; innerType?: ZodLike }; shape?: Record<string, unknown> };
export function zodShapeKeys(schema: unknown): string[] {
  let s = schema as ZodLike;
  for (let i = 0; i < 5 && s && !s.shape; i += 1) s = (s._def?.schema ?? s._def?.innerType) as ZodLike;
  if (!s?.shape) throw new Error('not a zod object schema');
  return Object.keys(s.shape);
}

// ---------------------------------------------------------------------------
// (c) database columns, replayed from the migration ledger
// ---------------------------------------------------------------------------

const NON_COLUMN_ITEMS = new Set(['constraint', 'primary', 'unique', 'check', 'foreign', 'exclude', 'like']);

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => {
    // A `--` inside a single-quoted string is rare in DDL; the ledger has none
    // in any CREATE/ALTER TABLE statement this parser reads.
    const i = l.indexOf('--');
    return i === -1 ? l : l.slice(0, i);
  }).join('\n');
}

/** Split on commas at parenthesis depth 0 (and outside quotes). */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (const ch of body) {
    if (ch === "'") quote = !quote;
    if (!quote) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function matchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let quote = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === '(') depth += 1;
    if (ch === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

const unquote = (s: string) => s.replace(/^"|"$/g, '');
const tableName = (s: string) => unquote(s.replace(/^public\./i, ''));

/**
 * Replays CREATE TABLE / ALTER TABLE (ADD, DROP, RENAME COLUMN) / DROP TABLE
 * across `migrations` (oldest first) for the named tables. Returns each
 * table's final column list in declaration order.
 */
export function replayColumns(migrations: readonly { name: string; sql: string }[], tables: readonly string[]): Record<string, string[]> {
  const want = new Set(tables);
  const cols: Record<string, string[]> = {};
  for (const m of migrations) {
    const sql = stripSqlComments(m.sql);
    const stmtRe = /\b(create\s+table|alter\s+table|drop\s+table)\s+(if\s+not\s+exists\s+|if\s+exists\s+)?(only\s+)?([a-z0-9_."]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = stmtRe.exec(sql))) {
      const kind = match[1].toLowerCase().replace(/\s+/g, ' ');
      const table = tableName(match[4].toLowerCase());
      if (!want.has(table)) continue;
      const after = match.index + match[0].length;
      if (kind === 'drop table') { delete cols[table]; continue; }
      if (kind === 'create table') {
        const open = sql.indexOf('(', after);
        const close = matchingParen(sql, open);
        if (open === -1 || close === -1) continue;
        if (cols[table] && /if\s+not\s+exists/i.test(match[2] ?? '')) continue;
        cols[table] = splitTopLevel(sql.slice(open + 1, close))
          .map((item) => item.trim().split(/\s+/)[0]?.toLowerCase() ?? '')
          .filter((first) => first && !NON_COLUMN_ITEMS.has(first))
          .map(unquote);
        continue;
      }
      // alter table ... ; -- actions up to the statement's semicolon (depth 0).
      let end = after;
      let depth = 0;
      let quote = false;
      for (; end < sql.length; end += 1) {
        const ch = sql[end];
        if (ch === "'") quote = !quote;
        if (quote) continue;
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ';' && depth === 0) break;
      }
      const actions = splitTopLevel(sql.slice(after, end));
      const list = cols[table] ?? (cols[table] = []);
      for (const raw of actions) {
        const a = raw.trim();
        let mm: RegExpMatchArray | null;
        if ((mm = a.match(/^add\s+column\s+(if\s+not\s+exists\s+)?([a-z0-9_"]+)/i)) || (mm = a.match(/^add\s+(?!constraint\b|primary\b|unique\b|check\b|foreign\b|exclude\b)([a-z0-9_"]+)\s/i))) {
          const col = unquote((mm[2] ?? mm[1]).toLowerCase());
          if (!list.includes(col)) list.push(col);
        } else if ((mm = a.match(/^drop\s+column\s+(if\s+exists\s+)?([a-z0-9_"]+)/i))) {
          const col = unquote(mm[2].toLowerCase());
          const i = list.indexOf(col);
          if (i !== -1) list.splice(i, 1);
        } else if ((mm = a.match(/^rename\s+column\s+([a-z0-9_"]+)\s+to\s+([a-z0-9_"]+)/i))) {
          const i = list.indexOf(unquote(mm[1].toLowerCase()));
          if (i !== -1) list[i] = unquote(mm[2].toLowerCase());
        }
      }
    }
  }
  return cols;
}

let ledgerCache: { name: string; sql: string }[] | null = null;
export function migrationLedger(): { name: string; sql: string }[] {
  if (!ledgerCache) {
    const dir = path.join(REPO_ROOT, 'supabase/migrations');
    ledgerCache = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf8') }));
  }
  return ledgerCache;
}

// ---------------------------------------------------------------------------
// The sources the registry must cover
// ---------------------------------------------------------------------------

export interface DispositionSource {
  adapter: AdapterId;
  sourceKind: SourceKind;
  sourceRef: string;
  /** Minimum keys the enumerator must find (R8 anti-vacuity floor). */
  floor: number;
  /** Enumerate from the live tree; `override` lets a test substitute file text. */
  enumerate(override?: { sourceText?: string; values?: readonly string[] }): string[];
}

const readSource = (sourceRef: string) => fs.readFileSync(resolveSourceFile(sourceRef), 'utf8');

function tsSource(adapter: AdapterId, sourceRef: string, floor: number): DispositionSource {
  const [, name] = sourceRef.split('#');
  return { adapter, sourceKind: 'ts_interface', sourceRef, floor, enumerate: (o) => interfaceProperties(o?.sourceText ?? readSource(sourceRef), name, sourceRef) };
}
function constListSource(adapter: AdapterId, sourceRef: string, floor: number): DispositionSource {
  const [, name] = sourceRef.split('#');
  return { adapter, sourceKind: 'field_list', sourceRef, floor, enumerate: (o) => constStringList(o?.sourceText ?? readSource(sourceRef), name, sourceRef) };
}
function zodSource(adapter: AdapterId, sourceRef: string, schema: unknown, floor: number): DispositionSource {
  return { adapter, sourceKind: 'zod_schema', sourceRef, floor, enumerate: (o) => (o?.values ? [...o.values] : zodShapeKeys(schema)) };
}
function enumSource(adapter: AdapterId, sourceRef: string, values: readonly string[], floor: number): DispositionSource {
  return { adapter, sourceKind: 'enum_value', sourceRef, floor, enumerate: (o) => [...(o?.values ?? values)] };
}
function dbSource(adapter: AdapterId, table: string, floor: number): DispositionSource {
  return {
    adapter, sourceKind: 'db_column', sourceRef: `db:${table}`, floor,
    enumerate: (o) => {
      const ledger = o?.sourceText ? [...migrationLedger(), { name: '9999_override.sql', sql: o.sourceText }] : migrationLedger();
      return replayColumns(ledger, [table])[table] ?? [];
    },
  };
}

export const SOURCES: readonly DispositionSource[] = [
  // Bank statements (CSV, native PDF, AI-fallback draft) and their evidence tables.
  tsSource('bank_csv', 'fdh:bank-csv/normalize.ts#NormalizedTransactionCandidate', 11),
  tsSource('bank_pdf', 'fdh:bank-pdf/orchestrator.ts#AcceptedPdfTransactionPlan', 16),
  tsSource('bank_pdf', 'fdh:bank-pdf/metadata.ts#PdfStatementMetadata', 5),
  zodSource('bank_ai_draft', 'aie:bankStatement/schema.ts#bankStatementDocumentFactsSchema', bankStatementDocumentFactsSchema, 10),
  zodSource('bank_ai_draft', 'aie:bankStatement/schema.ts#bankStatementTransactionSchema', bankStatementTransactionSchema, 5),
  dbSource('bank_ledger', 'fdh_transactions', 48),
  dbSource('bank_ledger', 'fdh_statement_uploads', 67),
  enumSource('economic_type', 'enum:FDH_ECONOMIC_TRANSACTION_TYPES', FDH_ECONOMIC_TRANSACTION_TYPES, 13),
  // Payslip.
  tsSource('payslip_native', 'fdh:payslip/types.ts#PayrollExtraction', 36),
  tsSource('payslip_native', 'fdh:payslip/types.ts#PayrollComponent', 5),
  zodSource('payslip_ai', 'aie:payslip/schema.ts#payslipDocumentFactsSchema', payslipDocumentFactsSchema, 24),
  dbSource('payslip_native', 'fdh_payroll_events', 56),
  dbSource('payslip_native', 'fdh_payroll_components', 9),
  // Credit card / loan statements.
  tsSource('liability_native', 'fdh:liability/types.ts#LiabilityStatementExtraction', 28),
  tsSource('liability_native', 'fdh:liability/types.ts#LiabilityStatementActivity', 10),
  zodSource('liability_ai', 'aie:liability/schema.ts#liabilityStatementDocumentFactsSchema', liabilityStatementDocumentFactsSchema, 15),
  zodSource('liability_ai', 'aie:liability/schema.ts#liabilityStatementActivitySchema', liabilityStatementActivitySchema, 8),
  dbSource('liability_native', 'fdh_liability_statements', 55),
  dbSource('liability_native', 'fdh_liability_statement_activities', 23),
  enumSource('liability_ledger', 'enum:LIABILITY_ACTIVITY_TYPES', LIABILITY_ACTIVITY_TYPES, 10),
  // AU investment statements.
  tsSource('au_investment_native', 'fdh:investment/types.ts#AuInvestmentStatementExtraction', 18),
  tsSource('au_investment_native', 'fdh:investment/types.ts#AuStatementPositionEvidence', 10),
  tsSource('au_investment_native', 'fdh:investment/types.ts#AuStatementTransactionEvidence', 15),
  zodSource('au_investment_ai', 'aie:auInvestment/schema.ts#auInvestmentDocumentFactsSchema', auInvestmentDocumentFactsSchema, 9),
  zodSource('au_investment_ai', 'aie:auInvestment/schema.ts#auInvestmentHoldingSchema', auInvestmentHoldingSchema, 7),
  zodSource('au_investment_ai', 'aie:auInvestment/schema.ts#auInvestmentActivitySchema', auInvestmentActivitySchema, 9),
  enumSource('au_investment_native', 'enum:AU_STATEMENT_TRANSACTION_TYPES', AU_STATEMENT_TRANSACTION_TYPES, 15),
  dbSource('au_investment_native', 'fdh_investment_statements', 32),
  dbSource('au_investment_native', 'fdh_investment_statement_positions', 21),
  dbSource('au_investment_native', 'fdh_investment_statement_activities', 31),
  // Retirement statements.
  tsSource('retirement_native', 'fdh:retirement/types.ts#RetirementStatementExtraction', 31),
  tsSource('retirement_native', 'fdh:retirement/types.ts#RetirementActivityEvidence', 11),
  tsSource('retirement_native', 'fdh:retirement/types.ts#RetirementPositionEvidence', 10),
  zodSource('retirement_ai', 'aie:retirement/schema.ts#retirementDocumentFactsSchema', retirementDocumentFactsSchema, 23),
  zodSource('retirement_ai', 'aie:retirement/schema.ts#retirementActivitySchema', retirementActivitySchema, 7),
  zodSource('retirement_ai', 'aie:retirement/schema.ts#retirementPositionSchema', retirementPositionSchema, 6),
  enumSource('retirement_native', 'enum:RETIREMENT_ACTIVITY_TYPES', RETIREMENT_ACTIVITY_TYPES, 17),
  dbSource('retirement_native', 'fdh_retirement_statements', 52),
  dbSource('retirement_native', 'fdh_retirement_statement_activities', 29),
  dbSource('retirement_native', 'fdh_retirement_statement_positions', 15),
  // India CAS (Investment Intelligence) -- ALREADY CLOSED, registry only.
  tsSource('ii_cas', 'ii:parsers/types.ts#ParsedAccountRecord', 8),
  tsSource('ii_cas', 'ii:parsers/types.ts#ParsedInstrumentRecord', 7),
  tsSource('ii_cas', 'ii:parsers/types.ts#ParsedTransactionRecord', 12),
  tsSource('ii_cas', 'ii:parsers/types.ts#ParsedHoldingRecord', 6),
  tsSource('ii_cas', 'ii:parsers/types.ts#ParseMetadata', 8),
  // Insurance -- ACTIVE USER FLOW: NO (not_active).
  constListSource('insurance', 'aie:insurance/types.ts#CANONICAL_INSURANCE_FIELD_NAMES', 10),
  constListSource('insurance', 'aie:insurance/types.ts#EVIDENCE_ONLY_INSURANCE_FIELD_NAMES', 11),
];

export interface EnumeratedKey {
  adapter: AdapterId;
  sourceRef: string;
  field: string;
}

export function enumerateAll(): { source: DispositionSource; keys: string[] }[] {
  return SOURCES.map((source) => ({ source, keys: source.enumerate() }));
}
