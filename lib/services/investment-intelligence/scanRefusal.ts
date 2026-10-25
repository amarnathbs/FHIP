// Investment Intelligence -- what a malware-scan state MEANS, and what the person is told (Document2 (4) WP-H2, 22-10-2026).
//
// THE DEFECT THIS REPLACES. Every non-clean, non-pending scan status used to mean the same thing: "blocked, delete the file, tell the
// person it could not be cleared by our security scan". That included a scan that never finished (timeout), a scanner that could not
// run (failed, access denied, identity mismatch) and a file the scanner cannot read at all (an encrypted PDF is UNSUPPORTED), none of
// which is a finding about the file. Three different situations now get three different outcomes and wordings:
//
//   blocked      the scanner looked and refused the content (threats found, or a file type it cannot check): final, the stored copy is
//                deleted, the person is told so plainly.
//   unavailable  the scanner could not give an answer (timed out, failed, was denied access to its own copy, or is not configured):
//                nothing is processed and NOTHING IS DELETED; the next attempt scans again. Fail closed, never fail destructive.
//   pending      the scan has not finished: keep everything, ask the person to try again in a minute.
//
// The stored status column keeps its existing vocabulary (a closed CHECK list; no schema change). The extra detail that tells an
// UNSUPPORTED file from an ACCESS_DENIED one is already stored in the scan object reference (`detail`).

export type ScanRefusalCode =
  | 'threats_found'
  | 'unsupported'
  | 'unrecognised_result'
  | 'access_denied'
  | 'scan_failed'
  | 'scan_timeout'
  | 'unknown_result'
  | 'scanner_not_configured'
  | 'password_required'
  | 'wrong_password'
  | 'unreadable_protection'
  | 'password_rate_limited';

export type ScanStateClass =
  | { cls: 'clean' }
  | { cls: 'pending' }
  | { cls: 'not_scanned' }
  | { cls: 'blocked'; code: ScanRefusalCode }
  | { cls: 'unavailable'; code: ScanRefusalCode };

/** Pure: stored `malware_scan_status` (+ the stored detail text) -> what it means. */
export function classifyScanState(status: string | null | undefined, detail?: string | null): ScanStateClass {
  const d = (detail ?? '').toUpperCase();
  switch (status ?? 'not_required') {
    case 'clean':
      return { cls: 'clean' };
    case 'pending':
      return { cls: 'pending' };
    case 'not_required':
      return { cls: 'not_scanned' };
    case 'malicious':
      return { cls: 'blocked', code: 'threats_found' };
    case 'suspicious':
      // `suspicious` is the stored status for every SKIPPED scan and for an unrecognised result on a COMPLETED one (realScanGate.ts).
      if (d.startsWith('UNSUPPORTED')) return { cls: 'blocked', code: 'unsupported' };
      if (d.startsWith('ACCESS_DENIED')) return { cls: 'unavailable', code: 'access_denied' };
      return { cls: 'blocked', code: 'unrecognised_result' };
    case 'scan_failed':
      return { cls: 'unavailable', code: 'scan_failed' };
    case 'scan_timeout':
      return { cls: 'unavailable', code: 'scan_timeout' };
    case 'unknown':
    default:
      return { cls: 'unavailable', code: 'unknown_result' };
  }
}

export const II_SCAN_PENDING_MESSAGE = 'Your document is still being scanned for safety. This can take a minute or two. Nothing has been changed and nothing was deleted. Please try again in a minute.';
export const II_SCAN_BLOCKED_MESSAGE = 'This file could not be cleared by our security scan, so it was not processed and has been deleted. Please upload the document again.';
export const II_SCAN_UNSUPPORTED_MESSAGE =
  'Our safety scan cannot check this kind of file, so it was not processed and has been deleted. If it is a password-protected statement, upload it again and enter its password when asked.';
export const II_SCAN_INCOMPLETE_MESSAGE =
  'The safety check could not be completed just now (it did not finish or could not run). This is not a finding about your file. Nothing was processed and your file has not been deleted. Please try again in a minute.';
export const II_SCAN_UNAVAILABLE_MESSAGE = 'Our document safety scanner is temporarily unavailable, so this document has not been processed. Please try again later.';
export const II_SCAN_PASSWORD_NEEDED_MESSAGE =
  'This statement is password protected. Enter its password so we can open it for the safety check. The password is used only for this and is not stored. Nothing was deleted.';
export const II_SCAN_WRONG_PASSWORD_MESSAGE = 'That password did not open the statement. Enter the document password again. Nothing was deleted.';
export const II_SCAN_UNREADABLE_PROTECTION_MESSAGE =
  'This statement uses a protection we cannot open for the safety check, so it was not processed. Nothing was deleted. Ask your statement provider for an unprotected copy, or contact support.';
export const II_SCAN_RATE_LIMITED_MESSAGE = 'Too many password attempts for this document recently. Please try again later.';

export interface ScanRefusalHttp {
  status: number;
  code: string;
  message: string;
}

/** The one place a refusal becomes an HTTP answer, so the upload, process and replacement routes can never word it differently. */
export function scanRefusalHttp(r: { reason: 'pending' } | { reason: 'blocked'; code: ScanRefusalCode } | { reason: 'scanner_unavailable'; code: ScanRefusalCode } | { reason: 'password_required' | 'wrong_password' | 'unreadable_protection' | 'password_rate_limited' }): ScanRefusalHttp {
  switch (r.reason) {
    case 'pending':
      return { status: 409, code: 'malware_scan_pending', message: II_SCAN_PENDING_MESSAGE };
    case 'blocked':
      return r.code === 'unsupported'
        ? { status: 422, code: 'malware_scan_unsupported', message: II_SCAN_UNSUPPORTED_MESSAGE }
        : { status: 422, code: 'malware_scan_blocked', message: II_SCAN_BLOCKED_MESSAGE };
    case 'scanner_unavailable':
      return r.code === 'scanner_not_configured'
        ? { status: 503, code: 'malware_scan_unavailable', message: II_SCAN_UNAVAILABLE_MESSAGE }
        : { status: 503, code: 'malware_scan_incomplete', message: II_SCAN_INCOMPLETE_MESSAGE };
    case 'password_required':
      return { status: 422, code: 'password_required_for_scan', message: II_SCAN_PASSWORD_NEEDED_MESSAGE };
    case 'wrong_password':
      return { status: 422, code: 'wrong_password_for_scan', message: II_SCAN_WRONG_PASSWORD_MESSAGE };
    case 'unreadable_protection':
      return { status: 422, code: 'unreadable_protection', message: II_SCAN_UNREADABLE_PROTECTION_MESSAGE };
    case 'password_rate_limited':
      return { status: 429, code: 'password_rate_limited', message: II_SCAN_RATE_LIMITED_MESSAGE };
  }
}
