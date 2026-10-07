-- STOP promo code e-mails right now, without a redeploy (hand-run, safe to repeat)
-- Use this if anything about the e-mails looks wrong (a wrong message, an unexpected volume, a provider problem).
-- It opens the e-mail pause for 24 hours. While it is open nothing is sent: every new code is created and shown ONCE to the
-- administrator on screen instead, with the message that sending is paused. Nothing already sent is affected.
-- It needs migration 0266 (the pause table). To resume earlier, run RESUME_promo_emails.sql.
-- This does not change the PREMIUM_PROMO_EMAIL_ENABLED setting. That setting is read when the site is built, so changing it needs a redeploy.

insert into public.promo_email_circuit (id) values (true) on conflict (id) do nothing;

update public.promo_email_circuit
   set open_until = now() + interval '24 hours', last_failure_at = now(), updated_at = now()
 where id;

select open_until, now() as checked_at, (open_until > now()) as sending_is_paused
  from public.promo_email_circuit
 where id;
