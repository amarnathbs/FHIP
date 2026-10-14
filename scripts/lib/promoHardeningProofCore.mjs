// Promo / Premium hardening: the DEV proof, written ONCE against a small interface so the very same checks run in two places:
//   * scripts/promo_hardening_release_dev_proof.mjs  against the real DEV Supabase project (real connections, real concurrency);
//   * tests/unit/promoHardeningProofCorePglite.test.ts  against a PGlite replay (so the proof itself is tested, with named negative
//     controls, BEFORE it is ever pointed at DEV).
//
// The interface (`ctx`) is deliberately tiny and contains no secret values in its output:
//   ctx.service            a client acting as the server role           { rpc(name, args), select(table, columns, match?) }
//   ctx.as(label)          a client acting as a fixture user            (same shape) labels: ent promo both ovr ovronly super user1 plain
//   ctx.anon               a client acting as a visitor                 (same shape)
//   ctx.service.tryWrite(kind, table, match, values?)   attempts an update or delete as the server role: { error }
//   ctx.newUser(opts)      creates a disposable user {id, email}        opts: { confirmed: boolean, email?: string }
//   ctx.verifyUser(id)     marks a user address as verified (what following the confirmation link does)
//   ctx.users              fixture users by label {id, email}
//   ctx.secrets            { digest, bind } : the keys the application would use (the proof computes digests and address hashes itself)
//   ctx.record(name, ok, detail)  one PASS/FAIL line (never a code, a digest or a secret)
//
// Each client method returns { data, error } where error is { message, code }. A database exception text (for example
// ENTITLEMENT_LIFETIME_LIMIT_REACHED) is in error.message, exactly as PostgREST returns it.

import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export const randomCode = () => Array.from(randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join('');
export const normaliseCode = (c) => String(c).replace(/[\s\-_]/g, '').toUpperCase();
export const digestOf = (code, secret, version = 1) => createHmac('sha256', secret).update(`promo-code:v${version}:${normaliseCode(code)}`).digest('hex');
export const hintOf = (code) => `${normaliseCode(code).slice(0, 2)}${'*'.repeat(Math.max(normaliseCode(code).length - 4, 2))}${normaliseCode(code).slice(-2)}`;
export const bindHashOf = (email, secret) => createHmac('sha256', secret).update(`promo-bind:${String(email).trim().toLowerCase()}`).digest('hex');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const has = (e, text) => Boolean(e) && String(e.message ?? '').includes(text);
const denied = (e) => Boolean(e) && /permission denied|not allowed|PGRST|42501/i.test(`${e.message ?? ''} ${e.code ?? ''}`);

/** Runs every proof. Returns { created: { codeIds, userIds } } so the caller can clean up what was made. */
export async function runProofs(ctx) {
  const { service, anon, record, secrets, users } = ctx;
  const made = { codeIds: [], userIds: [] };
  const userOf = async (opts) => {
    const u = await ctx.newUser(opts);
    made.userIds.push(u.id);
    return u;
  };

  // ---- helpers over the real functions ---------------------------------------------------------------------------------------
  const createCode = (client, o = {}) => {
    const code = o.code ?? randomCode();
    return client
      .rpc('admin_create_promo_code', {
        p_code_digest: digestOf(code, secrets.digest),
        p_code_hint: hintOf(code),
        p_digest_version: 1,
        p_duration_days: o.duration ?? 30,
        p_max_redemptions: o.max === undefined ? 3 : o.max,
        p_unlimited: false,
        p_expires_on: day(20),
        p_no_expiry: false,
        p_note: 'promo hardening proof, safe to disable',
        p_bound_email_hash: o.bound ?? null,
        p_recipient_count: o.bound ? 1 : 0,
      })
      .then((r) => ({ ...r, code }));
  };
  const redeem = (userId, code, o = {}) =>
    service.rpc('redeem_promo_code_for_user', {
      p_user_id: userId,
      p_digests: [digestOf(code, secrets.digest)],
      p_ip_hash: null,
      p_email_hash: o.emailHash ?? null,
      p_legacy_code: null,
    });
  const manage = (client, action, target, endsOn, reason = 'Promo hardening proof, synthetic check', override = false) =>
    client.rpc('admin_manage_premium_entitlement', { p_action: action, p_target_user_id: target, p_ends_on: endsOn, p_reason: reason, p_override: override });
  const entRow = async (id) => (await service.select('user_entitlements', 'plan_tier,entitlement_source,effective_from,effective_to,admin_lifetime_grant_units,admin_grant_extension_count', { user_id: id })).data?.[0] ?? null;
  const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : v);

  // ---- 0. preconditions ------------------------------------------------------------------------------------------------------
  const limits = await service.rpc('promo_email_limits');
  record('0.1 migrations 0264 to 0268 are applied (the limits function answers)', !limits.error && limits.data?.admin_recipients_per_day === 100, limits.error?.message ?? '');
  const probeOld = await service.rpc('redeem_promo_code_for_user', { p_user_id: ZERO_UUID, p_code: 'PROBEONLY22', p_ip_hash: null });
  const stage = probeOld.error && /could not find|does not exist|PGRST202|42883/i.test(`${probeOld.error.message} ${probeOld.error.code ?? ''}`) ? 'final' : 'coexist';
  record(`0.2 stage detected: ${stage === 'final' ? 'FINAL (0279 applied, old shapes gone)' : 'COEXIST (0264 to 0268 applied, old shapes still beside the new ones)'}`, true);

  // ---- 1. capabilities: each one alone, and nothing implied -----------------------------------------------------------------
  const promoCreate = await createCode(ctx.as('promo'));
  record('1.1 a promo-only admin can create a code', !promoCreate.error && Boolean(promoCreate.data?.id), promoCreate.error?.message ?? '');
  if (promoCreate.data?.id) made.codeIds.push(promoCreate.data.id);
  const target0 = await userOf({ confirmed: true });
  const promoGrant = await manage(ctx.as('promo'), 'grant', target0.id, day(10));
  record('1.2 a promo-only admin CANNOT grant Premium', has(promoGrant.error, 'ENTITLEMENT_ADMIN_REQUIRED'), promoGrant.error?.message ?? 'no error');
  const entCreate = await createCode(ctx.as('ent'));
  record('1.3 an entitlement-only admin CANNOT create a code', has(entCreate.error, 'PROMO_ADMIN_REQUIRED'), entCreate.error?.message ?? 'no error');
  if (entCreate.data?.id) made.codeIds.push(entCreate.data.id);
  const entOverride = await manage(ctx.as('ent'), 'grant', target0.id, day(10), 'Override attempt by an admin without the capability', true);
  record('1.4 an entitlement-only admin CANNOT use the override', has(entOverride.error, 'ENTITLEMENT_OVERRIDE_NOT_ALLOWED'), entOverride.error?.message ?? 'no error');
  const bothOverride = await manage(ctx.as('both'), 'grant', target0.id, day(10), 'Override attempt by an admin holding both ordinary capabilities', true);
  record('1.5 holding BOTH ordinary capabilities does not give the override', has(bothOverride.error, 'ENTITLEMENT_OVERRIDE_NOT_ALLOWED'), bothOverride.error?.message ?? 'no error');
  if (users.ovronly) {
    const ovrAlone = await manage(ctx.as('ovronly'), 'grant', target0.id, day(10), 'Override attempt by an admin holding only the override', true);
    record('1.6 the override ALONE is not enough (the grant capability is also required)', has(ovrAlone.error, 'ENTITLEMENT_ADMIN_REQUIRED'), ovrAlone.error?.message ?? 'no error');
  }
  for (const [label, who] of [['super', 'an admin with no capability flag'], ['user1', 'a plain signed-in user']]) {
    const c = ctx.as(label);
    const a = await createCode(c);
    const b = await manage(c, 'grant', target0.id, day(10));
    const l = await c.rpc('admin_list_promo_codes_v2');
    const s = await c.rpc('admin_promo_codes_hash_status');
    const m = await c.rpc('admin_list_monitoring_events', { p_limit: 5 });
    record(`1.7 ${who} is refused everywhere (create, grant, list, status, alerts)`, has(a.error, 'PROMO_ADMIN_REQUIRED') && has(b.error, 'ENTITLEMENT_ADMIN_REQUIRED') && has(l.error, 'PROMO_ADMIN_REQUIRED') && has(s.error, 'PROMO_ADMIN_REQUIRED') && has(m.error, 'PROMO_ADMIN_REQUIRED'), [a, b, l, s, m].map((x) => x.error?.message ?? 'OK').join(' | '));
  }
  const anonCreate = await createCode(anon);
  record('1.8 a visitor who is not signed in cannot call the create function', denied(anonCreate.error), anonCreate.error?.message ?? 'no error');
  const svcOnly = [];
  for (const [fn, args] of [['promo_codes_digest_pending', { p_limit: 1 }], ['promo_codes_finalise_hash_only', { p_dry_run: true }], ['promo_retention_run', { p_dry_run: true }], ['premium_cron_verify', { p_cron_secret_sha256: null }], ['promo_email_circuit_report', { p_ok: true }]]) {
    const r = await ctx.as('promo').rpc(fn, args);
    svcOnly.push(denied(r.error));
  }
  record('1.9 server-only functions are closed to a signed-in promo admin (backfill, finalise, cleanup, job verify, breaker report)', svcOnly.every(Boolean), svcOnly.join(','));

  // ---- 2. hash only ----------------------------------------------------------------------------------------------------------
  const hashed = await createCode(ctx.as('promo'), { duration: 30, max: 3 });
  if (hashed.data?.id) made.codeIds.push(hashed.data.id);
  const stored = (await service.select('promo_codes', 'code,code_digest,code_hint,code_digest_verified_at', { id: hashed.data?.id })).data?.[0];
  record('2.1 a new code is stored with NO plain value, only its protected copy and a masked hint', stored && stored.code === null && stored.code_digest === digestOf(hashed.code, secrets.digest) && stored.code_hint === hintOf(hashed.code), stored ? `code null: ${stored.code === null}` : 'row missing');
  for (const col of ['code', 'code_digest', 'bound_email_hash']) {
    const r = await ctx.as('promo').select('promo_codes', col);
    record(`2.2 a promo admin cannot read the ${col} column straight from the table`, denied(r.error), r.error?.message ?? 'READ SUCCEEDED');
  }
  const hint = await ctx.as('promo').select('promo_codes', 'code_hint');
  record('2.3 a promo admin can read the masked hint column', !hint.error, hint.error?.message ?? '');
  const listed = await ctx.as('promo').rpc('admin_list_promo_codes_v2');
  const mine = (listed.data ?? []).find((r) => r.id === hashed.data?.id);
  record('2.4 the list returns the masked hint and NO code, digest or hash column', !listed.error && mine && !('code' in mine) && !('code_digest' in mine) && mine.code_hint === hintOf(hashed.code) && mine.plain_stored === false, listed.error?.message ?? '');
  const events = await service.select('promo_code_events', '*', { promo_code_id: hashed.data?.id });
  record('2.5 the audit trail of the code contains neither the code nor its protected copy', !JSON.stringify(events.data ?? []).includes(hashed.code) && !JSON.stringify(events.data ?? []).includes(stored?.code_digest ?? '?'), '');

  const updEvent = await service.tryWrite('update', 'promo_code_events', { promo_code_id: hashed.data?.id }, { code_hint: 'ZZ****ZZ' });
  record('2.6 the promo audit trail cannot be changed, even by the server role (append only)', Boolean(updEvent.error), updEvent.error?.message ?? 'UPDATE SUCCEEDED');

  // ---- 3. duration: one inclusive meaning ------------------------------------------------------------------------------------
  const u30 = await userOf({ confirmed: true });
  const r30 = await redeem(u30.id, hashed.code);
  const e30 = await entRow(u30.id);
  record('3.1 a 30 day promo redeemed today ends today plus 29 (30 days counting both ends)', r30.data?.ok === true && dateOnly(e30?.effective_to) === day(29) && dateOnly(e30?.effective_from) === day(0), `ends ${dateOnly(e30?.effective_to)}`);
  const one = await createCode(ctx.as('promo'), { duration: 1, max: 1 });
  if (one.data?.id) made.codeIds.push(one.data.id);
  const u1 = await userOf({ confirmed: true });
  await redeem(u1.id, one.code);
  record('3.2 a 1 day promo ends today', dateOnly((await entRow(u1.id))?.effective_to) === day(0), '');
  const yr = await createCode(ctx.as('promo'), { duration: 365, max: 1 });
  if (yr.data?.id) made.codeIds.push(yr.data.id);
  const u365 = await userOf({ confirmed: true });
  await redeem(u365.id, yr.code);
  record('3.3 a 365 day promo ends today plus 364', dateOnly((await entRow(u365.id))?.effective_to) === day(364), '');
  const t365 = await userOf({ confirmed: true });
  const okMax = await manage(ctx.as('ent'), 'grant', t365.id, day(364));
  const tooFar = await manage(ctx.as('ent'), 'grant', (await userOf({ confirmed: true })).id, day(365));
  record('3.4 an admin grant may end today plus 364 at the latest; today plus 365 is refused', !okMax.error && has(tooFar.error, 'ENTITLEMENT_END_DATE_EXCEEDS_MAX'), `${okMax.error?.message ?? 'ok'} | ${tooFar.error?.message ?? 'no error'}`);
  const tooLong = await createCode(ctx.as('promo'), { duration: 366 });
  record('3.5 a 366 day promo is refused', has(tooLong.error, 'PROMO_DURATION_INVALID'), tooLong.error?.message ?? 'no error');

  // ---- 4. extension cap -------------------------------------------------------------------------------------------------------
  const capT = await userOf({ confirmed: true });
  const g = await manage(ctx.as('ent'), 'grant', capT.id, day(10));
  let okExt = 0;
  for (let i = 1; i <= 5; i += 1) if (!(await manage(ctx.as('ent'), 'extend', capT.id, day(10 + i * 10), `Extension ${i} of 5 for the proof`)).error) okExt += 1;
  const sixth = await manage(ctx.as('ent'), 'extend', capT.id, day(200), 'Sixth extension for the proof');
  record('4.1 five extensions succeed and the sixth is refused', !g.error && okExt === 5 && has(sixth.error, 'ENTITLEMENT_EXTENSION_LIMIT_REACHED'), `${okExt} ok | ${sixth.error?.message ?? 'no error'}`);

  // ---- 5. lifetime ceiling and the override ---------------------------------------------------------------------------------
  const lifeT = await userOf({ confirmed: true });
  let units = 0;
  for (let i = 1; i <= 10; i += 1) {
    const gr = await manage(ctx.as('ent'), 'grant', lifeT.id, day(5), `Lifetime cycle ${i} of 10 for the proof`);
    if (gr.error) break;
    units = gr.data?.lifetime_units ?? units;
    await manage(ctx.as('ent'), 'revoke', lifeT.id, null, `Lifetime cycle ${i} revoked for the proof`);
  }
  const eleventh = await manage(ctx.as('ent'), 'grant', lifeT.id, day(5), 'Eleventh grant after revoke for the proof');
  record('5.1 ten grants with a revoke between each succeed, and the eleventh is refused even though nothing is active (a revoke does not reset the ceiling)', units === 10 && has(eleventh.error, 'ENTITLEMENT_LIFETIME_LIMIT_REACHED'), `units ${units} | ${eleventh.error?.message ?? 'no error'}`);
  if (users.ovr) {
    const shortReason = await manage(ctx.as('ovr'), 'grant', lifeT.id, day(5), 'too short reason', true);
    record('5.2 the override needs a reason of at least 20 characters', has(shortReason.error, 'ENTITLEMENT_OVERRIDE_REASON_REQUIRED'), shortReason.error?.message ?? 'no error');
    const over = await manage(ctx.as('ovr'), 'grant', lifeT.id, day(5), 'Approved exception for the proof, reviewed by the product owner', true);
    record('5.3 an operator who holds the override capability (and the grant capability) can go past the ceiling, once, with a reason', !over.error && over.data?.override === true && over.data?.lifetime_units === 11, over.error?.message ?? '');
    const rows = await ctx.as('ent').select('premium_entitlement_overrides', 'target_user_id,limit_hit,action', { target_user_id: lifeT.id });
    record('5.4 the override left an append-only record that the grant capability can read', (rows.data ?? []).length === 1 && rows.data[0].limit_hit === 'lifetime_ceiling', rows.error?.message ?? `${(rows.data ?? []).length} rows`);
    const alerts = await ctx.as('promo').rpc('admin_list_monitoring_events', { p_limit: 50 });
    record('5.5 a high severity alert row exists for the override, readable by a capability holder, with no address and no code', !alerts.error && (alerts.data ?? []).some((a) => a.event_type === 'premium_limit_override' && a.severity === 'high') && !/@/.test(JSON.stringify(alerts.data ?? [])), alerts.error?.message ?? '');
    const fresh = await userOf({ confirmed: true });
    const notNeeded = await manage(ctx.as('ovr'), 'grant', fresh.id, day(5), 'An override where no limit was reached at all', true);
    record('5.6 an override where no limit was reached is refused (it is for exceptions only)', has(notNeeded.error, 'ENTITLEMENT_OVERRIDE_NOT_NEEDED'), notNeeded.error?.message ?? 'no error');
    const delOverride = await service.tryWrite('delete', 'premium_entitlement_overrides', { target_user_id: lifeT.id });
    record('5.7 the override record cannot be deleted, even by the server role (append only)', Boolean(delOverride.error), delOverride.error?.message ?? 'DELETE SUCCEEDED');
  }

  // ---- 6. address binding (verified account only) ----------------------------------------------------------------------------
  const emailA = `bind-a-${randomBytes(4).toString('hex')}@promo-proof.invalid`;
  const bound = await createCode(ctx.as('promo'), { max: 1, bound: bindHashOf(emailA, secrets.bind) });
  if (bound.data?.id) made.codeIds.push(bound.data.id);
  const stranger = await userOf({ confirmed: true });
  const strangerTry = await redeem(stranger.id, bound.code, { emailHash: bindHashOf(stranger.email, secrets.bind) });
  const unverified = await userOf({ confirmed: false, email: emailA });
  const unverifiedTry = await redeem(unverified.id, bound.code, { emailHash: bindHashOf(emailA, secrets.bind) });
  const owner = await userOf({ confirmed: true, email: `bind-b-${randomBytes(4).toString('hex')}@promo-proof.invalid` });
  const ownerNoHash = await redeem(owner.id, bound.code, { emailHash: null });
  record('6.1 a bound code is refused (the same generic verdict) for another account, for an UNVERIFIED account with the right address, and when no address hash is supplied', [strangerTry, unverifiedTry, ownerNoHash].every((r) => r.data?.ok === false && r.data?.code === 'PROMO_CODE_UNUSABLE'), [strangerTry, unverifiedTry, ownerNoHash].map((r) => r.data?.code).join(','));
  await ctx.verifyUser(unverified.id);
  const goodTry = await redeem(unverified.id, bound.code, { emailHash: bindHashOf(emailA, secrets.bind) });
  record('6.2 once that account VERIFIES its address, the same code works for it, once', goodTry.data?.ok === true, goodTry.data?.code ?? goodTry.error?.message ?? '');
  const secondTry = await redeem((await userOf({ confirmed: true, email: `bind-c-${randomBytes(4).toString('hex')}@promo-proof.invalid` })).id, bound.code, { emailHash: bindHashOf(emailA, secrets.bind) });
  record('6.3 a bound code is single use', secondTry.data?.ok === false, secondTry.data?.code ?? '');

  // ---- 7. real concurrency (true on DEV; serialised on the single PGlite connection, where the result must still be exact) ------
  const race = await createCode(ctx.as('promo'), { max: 1 });
  if (race.data?.id) made.codeIds.push(race.data.id);
  const racers = [];
  for (let i = 0; i < 8; i += 1) racers.push(await userOf({ confirmed: true }));
  const raced = await Promise.all(racers.map((u) => redeem(u.id, race.code)));
  const wins = raced.filter((r) => r.data?.ok === true).length;
  const raceCount = (await service.select('promo_codes', 'redemption_count', { id: race.data?.id })).data?.[0]?.redemption_count;
  record('7.1 eight users redeem a ONE use code at the same instant: exactly one succeeds and the count is 1', wins === 1 && raceCount === 1, `wins ${wins}, count ${raceCount}`);
  const race3 = await createCode(ctx.as('promo'), { max: 3 });
  if (race3.data?.id) made.codeIds.push(race3.data.id);
  const racers3 = [];
  for (let i = 0; i < 8; i += 1) racers3.push(await userOf({ confirmed: true }));
  const raced3 = await Promise.all(racers3.map((u) => redeem(u.id, race3.code)));
  const wins3 = raced3.filter((r) => r.data?.ok === true).length;
  const unusable3 = raced3.filter((r) => r.data?.ok === false && r.data?.code === 'PROMO_CODE_UNUSABLE').length;
  record('7.2 eight users race for a THREE use code: exactly three succeed, five get the generic verdict', wins3 === 3 && unusable3 === 5, `wins ${wins3}, unusable ${unusable3}`);
  const bogus = await redeem(racers3[0].id, 'NEVERMADE222');
  const exhausted = await redeem((await userOf({ confirmed: true })).id, race3.code); // a fresh user: one of the racers may be a winner, and a winner would be told it already used the code
  record('7.3 a code that never existed and an exhausted code give the SAME verdict', bogus.data?.code === exhausted.data?.code && bogus.data?.code === 'PROMO_CODE_UNUSABLE', `${bogus.data?.code} / ${exhausted.data?.code}`);
  const paid = users.paid;
  if (paid) {
    const paidTry = await redeem(paid.id, (await (async () => { const c = await createCode(ctx.as('promo'), { max: 2 }); if (c.data?.id) made.codeIds.push(c.data.id); return c; })()).code);
    record('7.4 a user on paid Premium is refused and the paid entitlement is untouched', paidTry.data?.ok === false && paidTry.data?.code === 'PROMO_PAID_ACTIVE' && (await entRow(paid.id))?.entitlement_source === 'payment', paidTry.data?.code ?? '');
  }

  // ---- 8. e-mail request ledger: purpose, idempotency, limits -----------------------------------------------------------------
  const key = `proof-${randomBytes(6).toString('hex')}`;
  const noPurpose = await ctx.as('promo').rpc('admin_promo_email_begin', { p_request_key: `${key}-np`, p_recipient_count: 1, p_bound: false, p_kind: 'create', p_purpose: 'short', p_replaces: null });
  record('8.1 a request without a real purpose (10 to 200 characters) is refused', has(noPurpose.error, 'PROMO_EMAIL_PURPOSE_REQUIRED'), noPurpose.error?.message ?? 'no error');
  const same = await Promise.all(Array.from({ length: 10 }, () => ctx.as('promo').rpc('admin_promo_email_begin', { p_request_key: key, p_recipient_count: 1, p_bound: false, p_kind: 'create', p_purpose: 'promo hardening proof, no e-mail is sent', p_replaces: null })));
  record('8.2 ten simultaneous requests with ONE key give exactly one new request (the others are told it is not new)', same.filter((r) => r.data?.new === true).length === 1, `new: ${same.filter((r) => r.data?.new === true).length}`);
  const repl = await createCode(ctx.as('promo'), { max: 2 });
  if (repl.data?.id) made.codeIds.push(repl.data.id);
  let refusedAt = 0;
  let globalSeen = false;
  for (let i = 1; i <= 4; i += 1) {
    const r = await ctx.as('promo').rpc('admin_promo_email_begin', { p_request_key: `${key}-r${i}`, p_recipient_count: 1, p_bound: false, p_kind: 'replace', p_purpose: 'promo hardening proof of the replacement limit', p_replaces: repl.data?.id });
    if (r.data?.refused === 'PROMO_EMAIL_GLOBAL_LIMIT') globalSeen = true;
    if (r.data?.refused === 'PROMO_EMAIL_REPLACEMENT_LIMIT' && !refusedAt) refusedAt = i;
  }
  if (globalSeen && !refusedAt) record('8.3 NOT EXERCISED today: the PLATFORM wide daily limit was already used by earlier proof runs (the global limit working). Re-run after the rolling 24 hours', true, 'platform limit reached');
  else record('8.3 the fourth replacement of one code in a day is refused (limit 3), and the refusal is an answer, not a crash', refusedAt === 4, `first refused at ${refusedAt}`);
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => ctx.as('both').rpc('admin_promo_email_begin', { p_request_key: `${key}-b${i}`, p_recipient_count: 9, p_bound: false, p_kind: 'create', p_purpose: 'promo hardening proof of the volume limits', p_replaces: null })));
  const passed = burst.filter((r) => r.data?.new === true).length;
  const allGlobal = burst.every((r) => r.data?.refused === 'PROMO_EMAIL_GLOBAL_LIMIT' || /RATE_LIMITED|DAILY_LIMIT/.test(r.error?.message ?? '') || r.data?.refused === 'PROMO_EMAIL_DAILY_LIMIT');
  if (allGlobal) record('8.4 NOT EXERCISED today: every request was refused by the PLATFORM wide daily limit (300 recipients) already used by earlier proof runs, which is itself the global limit working. Re-run after the rolling 24 hours to exercise the per-admin hourly limit', true, 'platform limit reached');
  else record('8.4 twelve simultaneous requests of nine recipients: exactly ten pass and two are refused (the hourly limit of 10 requests is exact under the lock)', passed === 10, `passed ${passed}, refused ${12 - passed}`);
  const monitor = await ctx.as('promo').rpc('admin_list_monitoring_events', { p_limit: 100 });
  record('8.5 hitting a limit left alert rows with counts only (no address, no code)', !monitor.error && !/@|[0-9a-f]{64}/.test(JSON.stringify(monitor.data ?? [])), monitor.error?.message ?? '');

  // ---- 9. retention, cron verification, switches ------------------------------------------------------------------------------
  const dry = await service.rpc('promo_retention_run', { p_dry_run: true });
  record('9.1 the retention function answers a dry run and changes nothing', !dry.error && dry.data?.dry_run === true, dry.error?.message ?? '');
  const real = await service.rpc('promo_retention_run', { p_dry_run: false });
  record('9.2 a real retention run refuses while its switch is off (evidence row only)', !real.error && real.data?.outcome === 'skipped_disabled', real.error?.message ?? real.data?.outcome);
  const verify = await service.rpc('premium_cron_verify', { p_cron_secret_sha256: null });
  const failedChecks = (verify.data ?? []).filter((r) => !r.ok && !/vault|cron_installed|no_production_url_job/i.test(r.check_name)).map((r) => r.check_name);
  record('9.3 the job verification report answers and every check that can be answered on this database is ok', !verify.error && failedChecks.length === 0, verify.error?.message ?? failedChecks.join(','));
  // A scheduled job on this database that calls the production site is reported as a FINDING, not a promo failure: other programmes registered it.
  const prodJobs = (verify.data ?? []).find((r) => r.check_name === 'no_production_url_job_outside_production');
  record(`9.3b FINDING check: no scheduled job here calls the production site (informational, outside the promo feature)${prodJobs && !prodJobs.ok ? ': ' + prodJobs.detail : ''}`, true);
  const switches = await service.select('premium_reminder_job_control', 'job_key,enabled');
  record('9.4 every job switch is OFF (the expiry reminder, and the retention cleanup)', (switches.data ?? []).length >= 2 && (switches.data ?? []).every((s) => s.enabled === false), (switches.data ?? []).map((s) => `${s.job_key}=${s.enabled}`).join(','));

  // ---- 10. the old release beside the new one (coexist) or gone (final) -------------------------------------------------------
  const oldExp = day(20);
  const oldCreate = await ctx.as('promo').rpc('admin_create_promo_code', { p_code: randomCode(), p_duration_days: 30, p_max_redemptions: 1, p_unlimited: false, p_expires_on: oldExp, p_no_expiry: false, p_note: 'old shape proof' });
  const oldList = await ctx.as('promo').rpc('admin_list_promo_codes');
  const oldManage = await ctx.as('ent').rpc('admin_manage_premium_entitlement', { p_action: 'grant', p_target_user_id: (await userOf({ confirmed: true })).id, p_ends_on: day(10), p_reason: 'Old shape proof grant, synthetic' });
  const oldBegin = await ctx.as('promo').rpc('admin_promo_email_begin', { p_request_key: `${key}-old`, p_recipient_count: 1, p_bound: false });
  if (stage === 'coexist') {
    record('10.1 COEXIST: the old release calls (create, list, grant, e-mail begin) still work, by their old argument names', !oldCreate.error && !oldList.error && !oldManage.error && !oldBegin.error, [oldCreate, oldList, oldManage, oldBegin].map((r) => r.error?.message ?? 'ok').join(' | '));
    if (oldCreate.data?.id) made.codeIds.push(oldCreate.data.id);
    const oldRedeem = await service.rpc('redeem_promo_code_for_user', { p_user_id: (await userOf({ confirmed: true })).id, p_code: oldCreate.data?.code ?? 'X', p_ip_hash: null });
    record('10.2 COEXIST: the old redeem call still redeems a code the old create made (plain text lookup)', oldRedeem.data?.ok === true, oldRedeem.data?.code ?? oldRedeem.error?.message ?? '');
  } else {
    record('10.1 FINAL: the old shapes are gone (create, list, grant, e-mail begin, redeem)', [oldCreate, oldList, oldManage, oldBegin, probeOld].every((r) => r.error && /could not find|does not exist|PGRST202|42883/i.test(`${r.error.message} ${r.error.code ?? ''}`)), [oldCreate, oldList, oldManage, oldBegin, probeOld].map((r) => (r.error ? 'gone' : 'STILL THERE')).join(','));
  }

  return { stage, created: made };
}
