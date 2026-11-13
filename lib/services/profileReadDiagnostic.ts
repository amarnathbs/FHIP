// TEMPORARY DIAGNOSTIC (13-11-2026), used only by proxy.ts. Remove together with it once the production cause is fixed.
//
// On production a signed-in user was sent to /onboarding although the profile row exists and is completed, and the database never received the
// profile query. proxy.ts used to throw away the error of that read. It now puts the error's code and a short message (never any row data) in
// this response header, so the signed-in user's own browser can show why (Network tab, the document request).
export const PROFILE_READ_HEADER = 'x-fhip-profile-read';

// Header values must be plain ASCII and short: a code, then at most 100 characters of the message, anything else replaced by a space.
export function describeProfileReadError(error: { code?: string | null; message?: string | null }): string {
  const code = String(error.code ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 20) || 'no_code';
  const message = String(error.message ?? '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `${code}: ${message}`;
}
