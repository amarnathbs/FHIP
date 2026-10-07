// Promo code e-mail: real Resend certification on DEV (SKELETON). NOT RUN as part of the hardening work. Nothing is sent by default.
//
// The runbook is docs/admin/PROMO_EMAIL_RESEND_DEV_CERTIFICATION_RUNBOOK.md. This script has three modes:
//
//   node scripts/promo_email_resend_dev_certification.mjs                      print the plan (default, no network)
//   node scripts/promo_email_resend_dev_certification.mjs --dns <domain> [--dkim-selector <s>]
//                                                                               read only SPF, DKIM and DMARC lookups
//   node scripts/promo_email_resend_dev_certification.mjs --send --confirm-owned-mailboxes \
//        --to you@gmail.example --to you@outlook.example [--repeat-key] [--wrong-key]
//                                                                               REAL SENDS (needs RESEND_API_KEY and the sender variables)
//
// SAFETY (all enforced below, and unit tested in tests/unit/promoHardening/operatorScripts.test.ts):
//   * --send needs --confirm-owned-mailboxes and at least one --to, at most five;
//   * --send refuses unless NEXT_PUBLIC_SUPABASE_URL is the DEV project (so a production environment can never be used);
//   * the body is docs/admin/po_apply_promo_hardening_release/resend_sample_body.txt with the sample code ZZZZZ-ZZZZZ, which no admin ever created and
//     which cannot be redeemed; a test keeps the file equal to the real message;
//   * it never prints the API key, never prints a code other than the sample, and prints addresses only as given on the command line.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_REF = 'vqycarelcoijzwlpkpcz';
const SAMPLE_BODY = path.join(HERE, '..', 'docs', 'admin', 'po_apply_promo_hardening_release', 'resend_sample_body.txt');
const SUBJECT = 'Your FHIP Premium access code';
const MAX_TO = 5;

export function projectRefOf(url) {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(String(url ?? ''));
  return m ? m[1].toLowerCase() : null;
}

export function parseArgs(argv) {
  const out = { send: false, confirm: false, to: [], repeatKey: false, wrongKey: false, dns: null, dkimSelector: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--send') out.send = true;
    else if (a === '--confirm-owned-mailboxes') out.confirm = true;
    else if (a === '--repeat-key') out.repeatKey = true;
    else if (a === '--wrong-key') out.wrongKey = true;
    else if (a === '--to') out.to.push(argv[++i] ?? '');
    else if (a === '--dns') out.dns = argv[++i] ?? null;
    else if (a === '--dkim-selector') out.dkimSelector = argv[++i] ?? null;
  }
  return out;
}

/** An error message when the send must not happen, otherwise null. */
export function sendRefusal(args, env) {
  if (!args.send) return null;
  if (!args.confirm) return 'Add --confirm-owned-mailboxes to confirm every --to is a mailbox you own.';
  if (args.to.length === 0 || args.to.length > MAX_TO) return `Give between 1 and ${MAX_TO} --to addresses.`;
  for (const a of args.to) if (!/^[^\s@<>,;:"']+@[^\s@<>,;:"']+\.[a-z]{2,}$/i.test(a)) return 'One of the --to values is not a plain e-mail address.';
  const ref = projectRefOf(env.NEXT_PUBLIC_SUPABASE_URL);
  if (ref !== DEV_REF) return `The project ref is ${ref ?? 'unknown'}. Real sends run only with the DEV environment loaded.`;
  if (!env.RESEND_API_KEY) return 'RESEND_API_KEY is missing.';
  if (!(env.PREMIUM_REMINDER_FROM_EMAIL || env.CONTACT_FROM_EMAIL)) return 'No sender address is configured (PREMIUM_REMINDER_FROM_EMAIL or CONTACT_FROM_EMAIL).';
  return null;
}

function printPlan() {
  console.log(fs.readFileSync(path.join(HERE, '..', 'docs', 'admin', 'PROMO_EMAIL_RESEND_DEV_CERTIFICATION_RUNBOOK.md'), 'utf8'));
}

/**
 * TXT records for a name. The resolver built into Node can fail on some machines (ECONNREFUSED, found on the build machine),
 * and a failed lookup used to be printed as a missing record. So the operating system resolver (nslookup) is the fallback and a
 * lookup that could not run is reported as such, never as "no record".
 */
async function txt(name) {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
  } catch (e) {
    const code = e && e.code ? e.code : 'lookup_failed';
    if (code === 'ENODATA' || code === 'ENOTFOUND') return [`(no record: ${code})`];
    try {
      const { stdout } = await execFileAsync('nslookup', ['-type=TXT', name], { timeout: 15000 });
      if (/non-existent domain|NXDOMAIN/i.test(stdout)) return ['(no record: NXDOMAIN)'];
      const pieces = [...stdout.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      return pieces.length ? [pieces.join('')] : ['(no record: none)'];
    } catch {
      return [`(lookup failed: ${code})`];
    }
  }
}

const present = (records) => records.filter((r) => !r.startsWith('(no record') && !r.startsWith('(lookup failed'));

async function dnsChecks(domain, selector) {
  // Resend publishes SPF (and the return path MX) on a send. subdomain of the sending domain, so look at both names.
  const spf = [];
  for (const n of [domain, `send.${domain}`]) for (const r of present(await txt(n))) if (r.startsWith('v=spf1')) spf.push(`${n}: ${r}`);
  console.log(`SPF    ${spf.length >= 1 ? 'ok  ' : 'FAIL'}  records starting v=spf1 (on the domain or its send. subdomain): ${spf.length}${spf.length ? `  ${spf.join('  |  ')}` : ''}`);
  const parent = domain.split('.').slice(1).join('.');
  let dmarc = present(await txt(`_dmarc.${domain}`)).filter((r) => r.startsWith('v=DMARC1'));
  if (dmarc.length === 0 && parent.includes('.')) dmarc = present(await txt(`_dmarc.${parent}`)).filter((r) => r.startsWith('v=DMARC1'));
  console.log(`DMARC  ${dmarc.length === 1 ? 'ok  ' : 'FAIL'}  ${dmarc[0] ?? 'no DMARC record on the domain or its parent'}`);
  const sel = selector || 'resend';
  const dkim = present(await txt(`${sel}._domainkey.${domain}`));
  console.log(`DKIM   ${dkim.length ? 'ok  ' : 'FAIL'}  ${sel}._domainkey.${domain}${selector ? '' : ' (default selector resend; pass --dkim-selector if the dashboard shows another)'}`);
  console.log('What the provider requires for this domain is read from its dashboard: these are the standard record names only.');
}

async function sendOne(env, to, key, useWrongKey) {
  const from = env.PREMIUM_REMINDER_FROM_EMAIL || env.CONTACT_FROM_EMAIL;
  const name = (env.PREMIUM_PROMO_EMAIL_FROM_NAME || 'FHIP').replace(/[^A-Za-z0-9 .&_-]/g, '').slice(0, 60) || 'FHIP';
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${useWrongKey ? 'invalid-key-for-failure-test' : env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ from: `${name} <${address}>`, to: [to], subject: SUBJECT, text: fs.readFileSync(SAMPLE_BODY, 'utf8') }),
    signal: AbortSignal.timeout(10_000),
  });
  let id = null;
  try {
    id = (await res.json())?.id ?? null;
  } catch {
    /* no body */
  }
  return { status: res.status, id };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dns) return dnsChecks(args.dns, args.dkimSelector);
  if (!args.send) return printPlan();
  const why = sendRefusal(args, process.env);
  if (why) {
    console.error(`REFUSED: ${why}`);
    process.exit(2);
  }
  const stamp = `cert-${Date.now().toString(36)}`;
  for (const to of args.to) {
    const key = `promo-code-${stamp}-sample`;
    const first = await sendOne(process.env, to, key, args.wrongKey);
    console.log(`${to}  message 1  HTTP ${first.status}  id ${first.id ?? '(none)'}`);
    if (args.repeatKey) {
      const again = await sendOne(process.env, to, key, args.wrongKey);
      console.log(`${to}  message 2 (same idempotency key)  HTTP ${again.status}  id ${again.id ?? '(none)'}  same id: ${again.id !== null && again.id === first.id}`);
    }
  }
  console.log('Now follow section 3 of the runbook on each received message. Unset PREMIUM_PROMO_EMAIL_ENABLED on DEV when finished.');
}

if (process.argv[1] && process.argv[1].endsWith('promo_email_resend_dev_certification.mjs')) {
  main().catch((e) => {
    console.error(`failed: ${e instanceof Error ? e.message : 'error'}`);
    process.exit(1);
  });
}
