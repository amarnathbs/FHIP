/**
 * Canonical-cert UI journey (DEV, 2026-09-27, fdh14 e2e "Expenses -> Import bank statement"): a file the
 * upload step rejected (garbage bytes -> failed / file_corrupt) also comes back with account_resolution
 * 'ambiguous' (nothing could be read, so nothing matched). The Expenses panel checked the account match
 * FIRST and told the user to "add the last few digits of the account" -- advice that cannot help with a
 * corrupt file -- instead of "This file appears to be corrupted or unreadable."
 *
 * Rule: the ambiguous-account question is asked only for a file the upload step accepted (no error_code,
 * or the password_required signal, whose flow is unchanged); a rejected file is reported as rejected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const src = fs.readFileSync(path.join(process.cwd(), 'components/expenses/BankStatementImportPanel.tsx'), 'utf8');
const body = src.slice(src.indexOf('async function handleUpload'));
const ambiguousLine = body.split(/\r?\n/).find((l) => l.includes("data.account_resolution === 'ambiguous'")) ?? '';

/** The panel's own decision, as written: which message a given upload response leads to (first match wins). */
function outcome(data: { account_resolution?: string; error_code?: string | null; password_required?: boolean }, csv = false): string {
  const cond = ambiguousLine.slice(ambiguousLine.indexOf('if (') + 3, ambiguousLine.lastIndexOf(') {') + 1);
  const ambiguous = new Function('data', `return ${cond};`)(data) as boolean;
  if (ambiguous) return 'ambiguous_account';
  if (!csv && data.password_required) return 'awaiting_password';
  if (data.error_code) return `failed:${data.error_code}`;
  return 'continue';
}

describe('Expenses bank import: a rejected file is reported as rejected', () => {
  it('[NC] a corrupt file that also came back ambiguous is reported as corrupt, not as an account question', () => {
    expect(ambiguousLine, 'ambiguous-account check present').not.toBe('');
    expect(outcome({ account_resolution: 'ambiguous', error_code: 'file_corrupt' })).toBe('failed:file_corrupt');
  });

  it('control: an accepted file that is ambiguous still gets the account question', () => {
    expect(outcome({ account_resolution: 'ambiguous', error_code: null })).toBe('ambiguous_account');
  });

  it('control: a password-protected PDF keeps its previous behaviour', () => {
    expect(outcome({ account_resolution: 'ambiguous', error_code: 'password_required', password_required: true })).toBe('ambiguous_account');
    expect(outcome({ account_resolution: 'matched', error_code: 'password_required', password_required: true })).toBe('awaiting_password');
  });

  it('the corrupt-file message is the one the user sees', () => {
    expect(src).toMatch(/file_corrupt: 'This file appears to be corrupted or unreadable\.'/);
  });
});
