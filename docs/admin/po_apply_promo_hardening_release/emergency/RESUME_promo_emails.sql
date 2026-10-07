-- RESUME promo code e-mails after STOP_promo_emails.sql (hand-run, safe to repeat)
-- It closes the e-mail pause and clears the count of failures. The next code an administrator e-mails is sent again.

update public.promo_email_circuit
   set open_until = null, consecutive_failures = 0, updated_at = now()
 where id;

select open_until, consecutive_failures, (open_until is null or open_until <= now()) as sending_is_allowed
  from public.promo_email_circuit
 where id;
