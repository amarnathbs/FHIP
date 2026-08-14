import { createAdminClient } from '@/lib/supabase/admin';
import { bad, ok } from '@/lib/api';

// Public, unauthenticated endpoint behind the marketing "Contact" page
// (app/(marketing)/contact/page.tsx) — createAdminClient() is safe here
// specifically because this route does its own input validation instead of
// relying on RLS to police who can insert (contact_submissions has RLS
// enabled with zero policies, so only this service-role write path can
// touch it at all; the anon key could never write to this table anyway).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_MAX = 200;
const EMAIL_MAX = 320;
const MESSAGE_MAX = 5000;
const RECIPIENT_EMAIL = 'kingkongpark2908@gmail.com';

// TEMPORARY — deployment diagnostic only, to be removed once the production
// env-var propagation issue is resolved. Reports presence/length only, never
// the actual secret values, so this is safe to hit publicly in the interim.
export async function GET() {
  const report = (v: string | undefined) => (v ? { present: true, length: v.length } : { present: false });
  return ok({
    NEXT_PUBLIC_SUPABASE_URL: report(process.env.NEXT_PUBLIC_SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: report(process.env.SUPABASE_SERVICE_ROLE_KEY),
    RESEND_API_KEY: report(process.env.RESEND_API_KEY),
    CONTACT_FROM_EMAIL: report(process.env.CONTACT_FROM_EMAIL),
    // Added to check blast radius, not just this route: CRON_SECRET is the
    // same "server-only, no NEXT_PUBLIC_ prefix" shape as the vars above,
    // and gates app/api/reports/cron/monthly-generate — if it's equally
    // absent at runtime, the scheduled monthly report job has likely been
    // silently failing in production too, unrelated to the contact form.
    CRON_SECRET: report(process.env.CRON_SECRET),
    NODE_ENV: process.env.NODE_ENV ?? null,
    AWS_REGION: process.env.AWS_REGION ?? null,
  });
}

export async function POST(req: Request) {
  // Whole handler wrapped — an uncaught exception in a Next.js Route Handler
  // produces a bare empty-body 500 in production (error detail is masked by
  // design), which left callers (and this route's own debugging) with no
  // signal at all about what actually failed. Same pattern already used by
  // app/api/reports/[id]/revise/route.ts.
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid request body.');

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    // Honeypot: a real visitor never sees or fills this field (hidden via
    // CSS in the form, not just visually — see ContactForm.tsx); a bot
    // filling every input on the page will fill it. Silently report success
    // rather than a validation error so the bot gets no signal its
    // submission was dropped.
    const website = typeof body.website === 'string' ? body.website.trim() : '';
    if (website) return ok({ submitted: true });

    if (!name) return bad('Please enter your name.');
    if (name.length > NAME_MAX) return bad('Name is too long.');
    if (!email || !EMAIL_RE.test(email)) return bad('Please enter a valid email address.');
    if (email.length > EMAIL_MAX) return bad('Email is too long.');
    if (!message) return bad('Please enter a message.');
    if (message.length > MESSAGE_MAX) return bad(`Message is too long (max ${MESSAGE_MAX} characters).`);

    const admin = createAdminClient();
    const { data: row, error: insertError } = await admin
      .from('contact_submissions')
      .insert({ name, email, message })
      .select('id')
      .single();
    if (insertError) return bad(`Could not save your message right now: ${insertError.message}`, 500);

    const emailSent = await sendContactNotification({ name, email, message }).catch(() => false);
    if (emailSent && row) {
      await admin.from('contact_submissions').update({ email_sent: true }).eq('id', row.id);
    }

    // The submission is durably stored either way — a Resend outage or a
    // missing RESEND_API_KEY should not turn into a failure the visitor
    // sees; it just means email_sent stays false for that row until someone
    // checks contact_submissions directly.
    return ok({ submitted: true });
  } catch (e) {
    console.error('Unhandled error in POST /api/contact:', e);
    return bad(e instanceof Error ? e.message : 'Could not send your message right now.', 500);
  }
}

async function sendContactNotification(input: { name: string; email: string; message: string }): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — contact submission saved but no notification email sent.');
    return false;
  }
  const from = process.env.CONTACT_FROM_EMAIL || 'FHIP Contact Form <no-reply@auth.financialhealthplatform.com>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [RECIPIENT_EMAIL],
      reply_to: input.email,
      subject: `New contact form message from ${input.name}`,
      text: `Name: ${input.name}\nEmail: ${input.email}\n\nMessage:\n${input.message}`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`Resend contact-notification send failed (${res.status}): ${detail}`);
    return false;
  }
  return true;
}
