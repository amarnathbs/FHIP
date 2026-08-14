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

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return bad('Invalid request body.');

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  // Honeypot: a real visitor never sees or fills this field (hidden via CSS
  // in the form, not just visually — see ContactForm.tsx); a bot filling
  // every input on the page will fill it. Silently report success rather
  // than a validation error so the bot gets no signal its submission was
  // dropped.
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
  if (insertError) return bad('Could not save your message right now. Please try again shortly.', 500);

  const emailSent = await sendContactNotification({ name, email, message }).catch(() => false);
  if (emailSent) {
    await admin.from('contact_submissions').update({ email_sent: true }).eq('id', row.id);
  }

  // The submission is durably stored either way — a Resend outage or a
  // missing RESEND_API_KEY should not turn into a failure the visitor sees;
  // it just means email_sent stays false for that row until someone checks
  // contact_submissions directly.
  return ok({ submitted: true });
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
