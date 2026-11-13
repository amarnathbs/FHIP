// NAV2 -- the e-mail alert of the weekly RBI refresh (PO decision 13-11-2026: "build both catch-up and e-mail alert").
//
// WHEN. Only a LIVE call sends anything, and only once per case: the case is first recorded as ONE open review item (the database keeps one open
// item per series and date), and the e-mail goes out only when that item is NEWLY recorded. Three cases:
//   blocked          RBI refused a page: the job stops and makes no request for six hours;
//   needs_review     a result was NOT published automatically (the checks failed) and waits in the review queue;
//   week_not_loaded  the current week's auction is still not loaded after the Friday windows and the Saturday retry.
// A dry run never sends. A missing setting, a mail provider that is down or a slow answer NEVER fails the step: the review item still records the case.
//
// WHAT. Facts only: the auction date (dd-mm-yyyy), what happened in plain words, and what to do. No secret, no link with a token, no stored value
// beyond the reason codes of the gate.
//
// WHERE. The repo's existing Resend mailer (the same path as the Contact form and the Premium reminders). The recipient is the one setting
// RISK_FREE_ALERT_TO_EMAIL; without it nothing is sent.

import type { Mailer } from '@/lib/services/premiumReminderMailer';
import { dmy } from './riskFreeCsv';

export type RefreshAlertKind = 'blocked' | 'needs_review' | 'week_not_loaded';

/** What the send attempt came to: reported in the step answer so a dry reading of step 6 shows whether mail is wired. */
export type MailOutcome = 'sent' | 'not_configured' | 'failed' | 'skipped_time';

export interface RefreshAlertInput {
  kind: RefreshAlertKind;
  /** The Wednesday of the auction this is about (ISO). */
  auctionDate: string;
  /** Short, non-sensitive gate reason codes (needs_review). */
  reasons?: string[];
}

/** A call that has already used this long does not start a mail: the next windows are still there, and Amplify ends every request at 28 seconds. */
export const ALERT_START_BUDGET_MS = 14_000;
/** The mail provider gets this long at most. */
export const ALERT_SEND_TIMEOUT_MS = 8_000;

export function buildRefreshAlert(a: RefreshAlertInput): { subject: string; text: string } {
  const d = dmy(a.auctionDate);
  const footer = 'This is an automatic message from the weekly RBI refresh. Nothing was changed in your stored rates by this message.';
  if (a.kind === 'blocked') {
    return {
      subject: `FHIP weekly T-bill refresh stopped: RBI refused a page (auction ${d})`,
      text: [
        `RBI refused a page while the weekly 91-day T-bill refresh was working on the auction of ${d}.`,
        'The job has stopped and will make no further request to RBI for six hours. It does not try to get around the refusal.',
        'What to do: if RBI keeps refusing, load the rate by the admin upload from RBI\'s own release. A review item is waiting in the risk-free review queue.',
        '',
        footer,
      ].join('\n'),
    };
  }
  if (a.kind === 'needs_review') {
    const why = a.reasons && a.reasons.length > 0 ? a.reasons.join(', ') : 'the publication checks did not all pass';
    return {
      subject: `FHIP weekly T-bill refresh needs a decision (auction ${d})`,
      text: [
        `The 91-day T-bill result for the auction of ${d} was NOT published automatically.`,
        `Reason: ${why}.`,
        'What to do: compare the figure with RBI\'s own "Treasury Bills: Full Auction Result" for that date, then accept it in the risk-free review queue or load it by the admin upload. The evidence is attached to the review item.',
        '',
        footer,
      ].join('\n'),
    };
  }
  return {
    subject: `FHIP weekly T-bill refresh: the auction of ${d} is still not loaded`,
    text: [
      `The 91-day T-bill result for the auction of ${d} is still not in the series after the Wednesday, Thursday, Friday and Saturday windows.`,
      'The job keeps looking back for four weeks and will load it by itself if RBI makes it available inside that time.',
      'What to do: open RBI\'s release for that date. If it is there, load it by the admin upload. The series goes stale if no value arrives for about three weeks. A review item is waiting in the risk-free review queue.',
      '',
      footer,
    ].join('\n'),
  };
}

export interface SendAlertArgs {
  mailer: Mailer | null | undefined;
  to: string | null | undefined;
  alert: RefreshAlertInput;
  /** Wall-clock milliseconds the step has already used (the caller's clock), to respect the 28-second request limit. */
  usedMs: number;
}

/** Never throws. */
export async function sendRefreshAlert(a: SendAlertArgs): Promise<MailOutcome> {
  try {
    const to = (a.to ?? '').trim();
    if (!a.mailer || !to || !a.mailer.configured()) return 'not_configured';
    if (a.usedMs > ALERT_START_BUDGET_MS) return 'skipped_time';
    const { subject, text } = buildRefreshAlert(a.alert);
    const send = a.mailer.send({ to, from: a.mailer.from(), subject, text, idempotencyKey: `risk-free-refresh-${a.alert.kind}-${a.alert.auctionDate}` });
    const timeout = new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), ALERT_SEND_TIMEOUT_MS));
    const r = await Promise.race([send, timeout]);
    return r.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
