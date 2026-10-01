// Premium expiry e-mail reminders — the runner behind the scheduled route.
//
// FAIL CLOSED, IN THIS ORDER:
//   1. The kill switch (premium_reminder_job_control 'expiry_email') must read
//      literally enabled = true. A missing row, a read error, or anything else
//      means DISABLED: nothing is claimed and nothing is sent.
//   2. The mailer must be configured; otherwise nothing is claimed (so no ledger
//      row is burned for a mail that could not have been sent).
//   3. premium_reminder_claim() atomically returns only the reminders THIS run
//      owns (new ones it inserted, plus failed ones it re-claimed within the
//      bounded budget). Overlapping or repeated runs get disjoint sets.
//   4. Every claimed row is settled with premium_reminder_record(); a mailer
//      failure is recorded (failed -> retried later up to the attempt budget ->
//      abandoned) and never sent twice, because a row is only ever claimed
//      'pending' by one run and an outcome-unknown row is never re-sent.
//
// The mailer and the clock are injected; tests never send mail.

import { composeExpiryReminderEmail, PREMIUM_EXPIRY_EMAIL_BATCH_SIZE, PREMIUM_EXPIRY_EMAIL_JOB_KEY, PREMIUM_EXPIRY_EMAIL_MAX_ATTEMPTS, PREMIUM_EXPIRY_EMAIL_RETRY_MINUTES, PREMIUM_EXPIRY_EMAIL_THRESHOLD_DAYS } from '@/lib/services/premiumExpiryReminderEmail';
import type { Mailer } from '@/lib/services/premiumReminderMailer';
import { utcToday } from '@/lib/services/entitlementWindow';

interface DbError {
  code?: string;
  message?: string;
}

/** The slice of the service-role Supabase client this runner needs. */
export interface ReminderDb {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): { maybeSingle(): PromiseLike<{ data: unknown; error: DbError | null }> };
    };
  };
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: DbError | null }>;
}

export interface ClaimedReminder {
  ledger_id: string;
  user_id: string;
  email: string;
  country: string | null;
  entitlement_source: 'admin_grant' | 'promo_code';
  ends_on: string;
  threshold_days: number;
  attempt: number;
}

export type RunStatus = 'disabled' | 'mailer_not_configured' | 'claim_failed' | 'ran';

export interface RunSummary {
  status: RunStatus;
  claimed: number;
  sent: number;
  failed: number;
}

export interface RunOptions {
  db: ReminderDb;
  mailer: Mailer;
  /** Defaults to the UTC date. */
  today?: string;
  baseUrl: string;
  thresholds?: readonly number[];
}

async function isEnabled(db: ReminderDb): Promise<boolean> {
  try {
    const { data, error } = await db.from('premium_reminder_job_control').select('enabled').eq('job_key', PREMIUM_EXPIRY_EMAIL_JOB_KEY).maybeSingle();
    if (error) return false;
    return (data as { enabled?: unknown } | null)?.enabled === true;
  } catch {
    return false;
  }
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

export async function runPremiumExpiryReminders(opts: RunOptions): Promise<RunSummary> {
  const { db, mailer } = opts;
  const today = opts.today ?? utcToday();

  if (!(await isEnabled(db))) return { status: 'disabled', claimed: 0, sent: 0, failed: 0 };
  if (!mailer.configured()) return { status: 'mailer_not_configured', claimed: 0, sent: 0, failed: 0 };

  const { data, error } = await db.rpc('premium_reminder_claim', {
    p_today: today,
    p_thresholds: [...(opts.thresholds ?? PREMIUM_EXPIRY_EMAIL_THRESHOLD_DAYS)],
    p_batch: PREMIUM_EXPIRY_EMAIL_BATCH_SIZE,
    p_max_attempts: PREMIUM_EXPIRY_EMAIL_MAX_ATTEMPTS,
    p_retry_after_minutes: PREMIUM_EXPIRY_EMAIL_RETRY_MINUTES,
  });
  if (error || !Array.isArray(data)) return { status: 'claim_failed', claimed: 0, sent: 0, failed: 0 };

  const claimed = data as ClaimedReminder[];
  let sent = 0;
  let failed = 0;
  for (const c of claimed) {
    // Defence in depth: the database already guarantees managed source and a real address; refuse anything else.
    const valid = (c.entitlement_source === 'admin_grant' || c.entitlement_source === 'promo_code') && typeof c.email === 'string' && c.email.includes('@');
    let result: { ok: boolean; messageId?: string; error?: string };
    if (!valid) {
      result = { ok: false, error: 'invalid_claim' };
    } else {
      const mail = composeExpiryReminderEmail({ endsOn: c.ends_on, daysLeft: daysBetween(today, c.ends_on), country: c.country, baseUrl: opts.baseUrl });
      try {
        result = await mailer.send({ to: c.email, from: mailer.from(), subject: mail.subject, text: mail.text, idempotencyKey: `premium-expiry-${c.ledger_id}` });
      } catch {
        result = { ok: false, error: 'mailer_threw' };
      }
    }
    await db.rpc('premium_reminder_record', {
      p_ledger_id: c.ledger_id,
      p_ok: result.ok,
      p_message_id: result.messageId ?? null,
      p_error: result.ok ? null : result.error ?? 'send failed',
      p_retry_after_minutes: PREMIUM_EXPIRY_EMAIL_RETRY_MINUTES,
      p_max_attempts: PREMIUM_EXPIRY_EMAIL_MAX_ATTEMPTS,
    });
    if (result.ok) sent += 1;
    else failed += 1;
  }
  return { status: 'ran', claimed: claimed.length, sent, failed };
}
