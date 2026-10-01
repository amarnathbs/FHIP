import { ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { createResendMailer } from '@/lib/services/premiumReminderMailer';
import { runPremiumExpiryReminders, type ReminderDb } from '@/lib/services/premiumExpiryReminderRunner';

export const dynamic = 'force-dynamic';

/**
 * Premium expiry e-mail reminders — the scheduled run (hourly via pg_cron +
 * pg_net, registered by migration 0238 on PRODUCTION only).
 *
 * Mirrors the other cron routes' auth exactly: the shared CRON_SECRET in the
 * x-cron-secret header, no user session. DISABLED BY DEFAULT: the kill switch
 * (premium_reminder_job_control 'expiry_email') ships false and the runner fails
 * closed on anything but a literal true, so a deployed route with the switch off
 * is a cheap no-op that claims and sends nothing.
 *
 * The response carries counts only: never an address, a body or a code.
 */
export async function POST(req: Request) {
  const secret = req.headers.get('x-cron-secret');
  if (!secret || secret !== process.env.CRON_SECRET) {
    return bad('Unauthorized', 401);
  }

  const baseUrl = (process.env.APP_BASE_URL || 'https://app.financialhealthplatform.com').replace(/\/+$/, '');
  try {
    const summary = await runPremiumExpiryReminders({
      db: createAdminClient() as unknown as ReminderDb,
      mailer: createResendMailer(),
      baseUrl,
    });
    return ok(summary);
  } catch (e) {
    console.error('premium expiry reminders run failed:', e instanceof Error ? e.name : 'error');
    return bad('Run failed', 500);
  }
}
