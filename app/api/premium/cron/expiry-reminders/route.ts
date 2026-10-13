import { ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { createResendMailer } from '@/lib/services/premiumReminderMailer';
import { runPremiumExpiryReminders, type ReminderDb } from '@/lib/services/premiumExpiryReminderRunner';
import { cronSecretMatches } from '@/lib/services/premiumCronAuth';
import { promoSecretProblems } from '@/lib/services/promoSecrets';
import { premiumExpiryEmailThresholds } from '@/lib/services/premiumExpiryReminderEmail';

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
  // CRON_SECRET is mandatory and dedicated (no fallback). If it is missing, too short or reused the route refuses explicitly
  // (503) instead of comparing against an empty value; a wrong or absent header is a plain 401 in constant time.
  const problems = promoSecretProblems('cron');
  if (problems.missing.length > 0 || problems.reused.length > 0) {
    console.error('premium expiry reminders refused: server secrets not configured', { missing: problems.missing, reused: problems.reused });
    return bad('Scheduled job not configured', 503);
  }
  if (!cronSecretMatches(req.headers.get('x-cron-secret'))) {
    return bad('Unauthorized', 401);
  }

  const baseUrl = (process.env.APP_BASE_URL || 'https://app.financialhealthplatform.com').replace(/\/+$/, '');
  try {
    const summary = await runPremiumExpiryReminders({
      db: createAdminClient() as unknown as ReminderDb,
      mailer: createResendMailer(),
      baseUrl,
      thresholds: premiumExpiryEmailThresholds(),
    });
    return ok(summary);
  } catch (e) {
    console.error('premium expiry reminders run failed:', e instanceof Error ? e.name : 'error');
    return bad('Run failed', 500);
  }
}
