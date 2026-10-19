# Module 11 production proof protocol (AI Coach, Next Best Action, Insight Packs, Standard questions, Explain)

Written 19/10/2026. For the Product Owner, who runs production by hand (Supabase SQL editor, Amplify console, browser). **Nothing in this folder has been run.** I have no production credentials and I changed nothing: I only read the Module 11 branch with git. Every statement below is "read from code" unless it names a branch document, and those documents are another agent's claims that I did not re-verify.

**Evidence labels used** (nothing is rounded up): UNIT-TESTED, PGLITE-VERIFIED, DEV-verified, PRODUCTION-VERIFIED, NOT PERFORMED. Everything you will do in this protocol is NOT PERFORMED until you fill in a row. Nothing about Module 11 is PRODUCTION-VERIFIED today.

## 0. What is in this folder

| File | What it is | Writes? |
|---|---|---|
| `README.md` | this protocol | no |
| `sql/M11_01_schema_inventory_READONLY.sql` | tables, functions, columns, the uniqueness rules, row level security | no |
| `sql/M11_02_controls_and_switches_READONLY.sql` | every kill switch and ceiling, model rows, prompt rows, readiness | no |
| `sql/M11_03_entitlement_population_READONLY.sql` | how many Premium, lapsed, Free, and how many outside the former pilot | no |
| `sql/M11_04_insight_packs_and_stored_answers_READONLY.sql` | packs by month and status, the stored answers they feed, what users were shown, scheduler ledger | no |
| `sql/M11_05_usage_cost_and_refusals_READONLY.sql` | runs, usage ledger, admissions and refusals, spend against ceilings | no |
| `sql/M11_06_duplicates_and_idempotency_READONLY.sql` | duplicate generation and double charge checks (expect zero), stuck work | no |
| `sql/M11_07_scheduler_eligibility_preview_READONLY.sql` | who the monthly scheduler would reach, ticks needed | no |
| `sql/M11_08_one_account_probe_READONLY.sql` | one proof account, before and after each browser step | no |
| `sql/M11_90_ROLLBACK_SWITCHES_WRITE.sql` | **WRITE file.** Backup first, then the stop switches and the way back | **yes** |
| `sql/M11_91_TEMP_LOWER_LIMITS_TEST_WRITE.sql` | **WRITE file.** Lower one limit, test the refusal, restore it | **yes** |

SQL rules followed: one statement per block under a comment header, blocks separated by a line of dashes, paste one block at a time. Read-only files contain only `select` and `with`. Results show counts, booleans, 8 character ids and dates, never question text, answer text, e-mails or secrets. The two address placeholders you must replace are in M11_03 block 3 and in every block of M11_08. All files pass the repository editor-safety lint (`scripts/migration_editor_safety_lint.mjs`, run on the files, 10 of 10 clean). They were **not executed against a database**, so a typing error in a block would show as a normal SQL error and is harmless for the read-only files.

## 1. Branch state (read only)

### 1.1 Which commit I read

| Item | Value |
|---|---|
| Branch | `integration/module11-0-to-11-7-20261014` (a local branch; the owner of that branch may move it) |
| **Tip SHA I read (19/10/2026)** | **`4e0f0343476eed026a1fc5040aaeb02c881c094f`** (a merge of `origin/main` 22db19b) |
| `origin/main` as known to the local clone | `22db19b2c753e21996f876dca36c41aac449dd5f`, already an ancestor of the tip. I did not run `git fetch`, so the real remote may be newer |
| Commits ahead of `origin/main` | **44** (`git rev-list --count origin/main..<tip>`) |
| Last commit that touched the Module 11 gate documents | `a73aa90`, 16/10/2026 20:16 (nothing in the gate documents changed after that) |
| Merged to main? Activated in production? | **No and no.** The branch's own closure report says "CONDITIONAL PASS, NOT READY FOR MERGE, PRODUCTION ACTIVATION NOT AUTHORIZED" (`docs/ai/MODULE11_0_TO_11_7_CLOSURE_REPORT_15-10-2026.md`, lines 24 to 29). That was written before your 16/10/2026 decision that Module 11 goes live for Premium; the gates it names are in section 7 |

Before you use any of this, run `git -C D:/FHIP rev-parse integration/module11-0-to-11-7-20261014` and compare with the SHA above. If it differs, findings in section 8 may be out of date.

### 1.2 Migrations the branch adds on top of main (`git diff --name-status origin/main...<tip> -- supabase`)

| No. | File | What it does | Visible effect on its own |
|---|---|---|---|
| 0175 | `0175_module11_r1_r2_prompt_v2_and_openai_model_row.sql` | Insight Pack prompt PR-AI-013 version 2 as DRAFT. The OpenAI model row `gpt-4o-mini`, **inactive and not approved** | none |
| 0176 | `0176_module11_r3_insight_pack_scheduler.sql` | `scheduler_enabled` switch (default **false**), tables `ai_insight_pack_scheduler_runs` and `ai_insight_pack_scheduler_jobs`, claim and release functions, batch columns. **Registers no cron job** | none |
| 0177 | `0177_module11_r4_admin_ai_operations_capabilities.sql` | Two Admin capability columns (default false) and two functions | none |
| 0178 | `0178_module11_6_next_best_action.sql` | `next_best_action_enabled` switch (default true) and the Next Best Action audit table | audit rows start when people open Next Best Action |
| 0230 | `0230_module11_7_ai_coach_prompt_and_model_task_type.sql` | Coach prompt PR-AI-010 version 2 as DRAFT, adds `general_coach` to the model row | none |
| 0286 | `0286_module11_prompt_v3_coach_and_pack.sql` | Prompt version 3 of the Coach and the Insight Pack as DRAFT (the number you reserved) | none |

The base Module 11 migrations (0110, 0115, 0117, 0121, 0123, 0124, 0126) are already on main. Whether production has them applied is **not verified**: M11_01 block A answers it. The branch's pack says that if they are missing "a separate pack is needed" (`docs/ai/po_apply_module11_production/00_README_PO_ORDERED_STEPS.md`).

### 1.3 What each feature needs before it can work

| Feature | Database needs | Settings needs | Environment needs |
|---|---|---|---|
| Standard questions that need no pack (6 of 25: SQ-AI-003, 013, 018, 020, 021, 025; SQ-AI-013 is always answered as deferred), Explain buttons that use rules only | base 0110 to 0126 | `ai_globally_enabled`, `contextual_explanations_enabled` | none |
| Next Best Action (and SQ-AI-003, SQ-AI-025) | 0178 | `next_best_action_enabled` | none |
| **Standard questions that need an explanation (19 of 25), and Explain buttons that map to them** | the stored answers a pack writes (section 2) | a pack must exist for the person | see Insight Pack |
| Coach (typed questions) | 0230 (task type), an ACTIVE prompt PR-AI-010 (0230 for v2, 0286 for v3), 0175 (OpenAI model row, then made active and approved) | `ai_globally_enabled`, `custom_ai_enabled`, `live_provider_enabled`, OpenAI provider enabled | `MODULE11_AI_PROVIDER=openai`, `OPENAI_API_KEY`, `MODULE11_AI_MODEL` |
| Insight Pack generation (admin triggered) | 0175 (PR-AI-013 v2 and model task type `monthly_insight_pack`), 0286 for v3, an ACTIVE PR-AI-013 | `batch_generation_enabled`, `live_provider_enabled`, `max_output_tokens` at least 3000 (the pack asks for 3000; the default is 800) | same three as the Coach |
| Insight Pack, unattended monthly | everything above plus 0176 | `scheduler_enabled` true, a cron schedule (pg_cron and Vault, **not created by any migration**) | `CRON_SECRET` set to its own value, optionally `MODULE11_SCHEDULER_MAX_HOUSEHOLDS_PER_RUN` |
| Admin AI Operations screen | 0177 | the admin holds `can_view_ai_operations` or `can_manage_ai_operations` | none |
| Every AI answer | main's migration 0285 (`income_sources.tax_amount`): without it the AI context is invalid and every answer fails closed | | |

### 1.4 Amplify environment names, and what the branch's `amplify.yml` does with them

Names the Module 11 code reads (found by searching `process.env` in `lib/ai`, `app/api/ai`, `app/api/admin/ai`; `lib/ai/config.ts`, `app/api/ai/cron/insight-pack-monthly/route.ts:31`):

| Name | Needed? | Meaning |
|---|---|---|
| `MODULE11_AI_PROVIDER` | **yes** | `openai` selects the real provider. **Anything else, including unset, is the built-in mock** (`config.ts:35`) |
| `OPENAI_API_KEY` | **yes** (secret) | Module 11's own OpenAI key (`openaiProvider.ts:86`), separate from the document-reading key `AIE_OPENAI_API_KEY` |
| `MODULE11_AI_MODEL` | recommended | defaults to `gpt-4o-mini`; the model must also be active and approved in the model registry |
| `MODULE11_AI_TIMEOUT_MS` | no | default 30000, capped at 120000 |
| `MODULE11_AI_MAX_TRANSIENT_RETRIES` | no | default 1, capped at 3 |
| `MODULE11_AI_BATCH_MODE` | no | `sync_fanout` (default) or `provider_batch` (not usable until the OpenAI project is entitled) |
| `MODULE11_SCHEDULER_MAX_HOUSEHOLDS_PER_RUN` | no | default 5 in `sync_fanout` (`config.ts:79`) |
| `CRON_SECRET` | scheduler only | the cron route compares the `x-cron-secret` header to it |

**Result for `amplify.yml` on the branch tip.** Line 185 of `amplify.yml` is the build step `env | grep -e ... >> .env.production`. It lists `-e MODULE11_ -e OPENAI_API_KEY` (and `-e CRON_SECRET`, `-e AIE_`, `-e II_AI_FALLBACK_`). The `MODULE11_` entry is a prefix match, so all six `MODULE11_*` names above are forwarded, and `OPENAI_API_KEY` is forwarded by exact name. The comment block at lines 177 to 184 says names only, no values, and that forwarding switches nothing on (with `MODULE11_AI_PROVIDER` unset the stack uses the mock, and the database switches still gate every call). The branch also has a test that fails if Module 11 code reads a variable that the list does not forward (`tests/unit/aiModule11AmplifyForwarding.test.ts`, UNIT-TESTED by the other agent, not re-run by me).

**On `origin/main` (22db19b) neither name is forwarded** (`git show origin/main:amplify.yml`: 0 matches). So merging main alone is not enough: the branch must reach `main`, and the variables must be set in the Amplify console **before** the build that deploys it, because a variable reaches the running server only through a new build. After that build, prove it with the health call in journey a (it shows provider, model and a yes or no for the key, never the key).

## 2. The thing to understand first: what "live for all Premium users" depends on

1. **Coach (typed questions)** needs only: Premium, the switches, an ACTIVE prompt, the OpenAI model active and approved, the two environment variables. It spends your OpenAI money (about one tenth of a cent per answer, the branch's estimate) and uses one of 10 monthly questions.
2. **Next Best Action** is rules only, no OpenAI, no allowance. It needs Premium, the switch and 0178.
3. **Standard questions and Explain buttons do NOT read the Coach and do NOT call OpenAI.** The 19 Standard questions that include an explanation part read a stored answer from the table `ai_insights` (rows written by the monthly Insight Pack, `source_engine = ai_insight_pack_service`, `metric_code` = the explanation intent, `future_ai_explanation` = the text). If no usable stored row exists, the screen shows **"Personalised insight is being prepared"** (`components/aiInsights/StandardQuestionLibrary.tsx:60`) and Explain shows "Your personalised insight is being prepared." (`lib/ai/contextualExplanations/types.ts:48`). The rule is in `lib/ai/standardQuestions/service.ts:269-272` and `:400` (a question with a missing explanation is not answered at all, even if its number is available).
4. **A pack is created only by** the unattended monthly scheduler or by an admin through the admin routes. **There is no user screen or user API route that reads a pack or its blocks.** I searched `components/aiInsights`, `app/(app)/ai-insights` and `app/api` (non admin): none reads `ai_insight_packs`. A user "reads a pack" only indirectly, through the stored answers it created.
5. **The branch's go-live pack leaves the scheduler OFF** (`docs/ai/po_apply_module11_production/03_SCHEDULER_LATER_STEP.md`, decision 16/10/2026). With the scheduler OFF and no admin generated pack, 19 of the 25 Standard questions and the Explain buttons that map to them show the "being prepared" placeholder to every Premium user. For your instruction ("AI live for all eligible Premium users") the scheduler (or another way to create packs for everyone) is therefore part of the go-live, not a later extra. Journeys b, c, e and f test exactly this.

## 3. Before any journey

| Step | Do | Pass when |
|---|---|---|
| 3.1 | Run `M11_01` blocks A, B, C, D on production | every row of A and B says `true`; C: `row_security_on` true everywhere, `write_policy_count` 0 everywhere; D: anon and signed_in false for the six functions |
| 3.2 | Run `M11_02` blocks 1 to 8 and keep the whole output (this is your "before" picture) | you can state every switch value. Block 2 tells you which features the database allows. Note `mock_coach_model_still_active` |
| 3.3 | Run `M11_03` block 1 and block 3 (with the two former pilot addresses typed in your editor) | `premium_current_outside_pilot` is at least 1, otherwise there is nobody to test with |
| 3.4 | Take the backup: `M11_90` blocks B1 to B5 | `controls_saved` true |
| 3.5 | Create your proof accounts through the normal app: **P1** Premium outside the former pilot (Admin grant of 1 to 3 days, or a promo code), **P2** a second Premium, **F1** Free, **A1** an Admin with no Premium grant, **P3** a brand new Premium account with no financial data. For lapse (journey h) you later shorten P2's grant in Admin | each account can sign in |
| 3.6 | Provider health, no spend. Signed in as P1, open the browser console (F12) and run the line below | `healthy: true`, `configuration.provider: "openai"`, `configuration.credential_configured: true` |

```js
await (await fetch('/api/internal/ai/provider/health', { method: 'POST' })).json()
```

If `provider` says `mock` or `credential_configured` is `false`: stop. The Amplify variables did not reach the build. Do not activate a prompt while the provider is the mock: the Coach would then answer with the built-in mock text, which looks like an AI answer and is not one.

## 4. The journeys

Date shape everywhere on screen: dd/mm/yyyy for Australia, dd-mm-yyyy for India. An ISO or US order date on any AI screen is a **failure**. For each journey write the result in the evidence table of section 9. Use M11_08 block 1 on the account **before and after** every step marked DELTA. Do not copy question text or answer text into evidence: use the ids and counts named.

### Journey a. Premium user receives a usable, grounded AI Coach answer

| | |
|---|---|
| Account | P1 |
| Action in the normal app | Financial Insights (`/ai-insights`), tab **Ask FHIP - Beta**. Type a new question that is not one of the 25 standard ones, for example "How does my cash flow compare with what I spend on housing?" and press Ask. If the screen says "No custom AI question used" the question was answered by the rules or from a stored answer: that is allowed (journey c) but it is not this journey, so ask a different new question until you see "Used one custom AI question" |
| Expected | An answer card with a headline, a short answer, key points, limits, a "data as of dd/mm/yyyy" date, and the allowance falls by exactly 1. It is not "AI is temporarily unavailable", not "FHIP does not have enough information", not a boundary text |
| DELTA (M11_08 block 1) | `openai_coach_runs` +1, `quota_used` +1, `quota_remaining` -1, `ledger_live_calls` +1, `admissions_that_used_a_custom_question` +1, `coach_answers_in_history` +1 |
| Sanitized evidence | Browser Network tab, the `POST /api/ai/coach/questions` response: `status` ANSWERED, `resolution_type` LIVE_AI, `provider_called` true, `quota_consumed` true, `remaining_quota`, first 8 characters of `question_id`, number of `source_refs`, `data_as_of`. M11_08 block 2 newest row: `provider` **openai** (not mock), `model` gpt-4o-mini, `execution_status` success, `grounding_status` grounded, input and output tokens above 0, `estimated_cost_usd` above 0, `prompt_version`. Block 6: `question_id8` equals the 8 characters you noted |
| Then | Ask exactly the same question again: label "Answer you already generated", DELTA all zero. Reopen it from Recent questions: DELTA all zero. Press Helpful once: "Thanks for your feedback." Ask one "why" question the data cannot explain: either a short answer that says the data does not show why, or a refusal screen that costs no allowance (the branch records refusals of 15 to 35 percent of "why" questions on DEV, section 7) |
| Fails if | `provider` is mock in block 2, the answer is shown without sources, the allowance does not move, the cost is 0 on a successful run, or any date is ISO |

### Journey b. Monthly Insight Pack generated, stored, and readable by the user

There is no user screen for a pack (section 2). The proof is: the pack and its blocks are stored, the stored answers exist, and the user can read them through Standard questions or Explain.

| | |
|---|---|
| Preconditions | M11_02 block 2: `pack_model_ready`, `pack_prompt_active`, `pack_generation_on`, `live_provider_on`, `output_budget_fits_a_pack` all true |
| Account / who acts | Admin: a Super Admin. Subject: P1. Use a Super Admin who is not the subject |
| Action (admin, not the normal UI) | Step 1, selection check without spend: `POST /api/admin/ai/insight-packs/scheduler/run` with `{"phase":"submit","dryRun":true}`, by an Admin who holds `can_manage_ai_operations` (the Admin AI Operations screen has a Scheduler panel; the route is `app/api/admin/ai/insight-packs/scheduler/run/route.ts`). Step 2, one real pack for P1: `POST /api/admin/ai/insight-packs/generate` with `{"user_id":"<P1 user id>"}` (`app/api/admin/ai/insight-packs/generate/route.ts`; it requires a Super Admin and, as read, does not check the AI Operations capability) |
| Expected | A pack row for P1 in status **READY** or **PARTIAL**, `grounding_status` PASS or PARTIAL, blocks `GROUNDED`, a cost of about US$0.002 to US$0.004 (the branch's estimate), the allowance **unchanged** |
| DELTA (M11_08 block 1) | `openai_pack_runs` +1, `ready_or_partial_packs` +1, `stored_answers` rises (one row per grounded block), **`quota_used` +0**, `admissions_that_used_a_custom_question` +0 |
| Sanitized evidence | M11_08 block 4: `pack_id8`, status, `grounding_status`, prompt version, `grounded_blocks` of `all_blocks`. Block 3: a row with `usage_outcome` BATCH_AI and `quota_consumed` false. M11_04 blocks 1, 2, 4 for the whole system. M11_06 blocks 1 to 4 all 0 |
| Read path | As P1 in the browser, run journey c. A pack that exists but whose stored answers cannot be shown is a **fail** of this journey |
| Fails if | status FAILED, only PARTIAL with the intents you need missing (block 5 of M11_08 shows `missing`), the allowance moved, or M11_04 block 5 or block 6 returns rows (see finding 2) |

### Journey c. Standard questions and contextual Explain return their intended STORED content, not "being prepared"

**What "useful content" means** (read from `lib/ai/standardQuestions/service.ts`, `lib/ai/resolution/storedPersonalisedResolver.ts` and the table definitions). For a Standard question that has an explanation part:

1. the response has `status` **AVAILABLE** (not PACK_NOT_READY, INSUFFICIENT_DATA, DOMAIN_UNAVAILABLE, PREMIUM_REQUIRED, FEATURE_DISABLED);
2. the `answer` has a non-empty headline and summary, and the summary text is the stored `future_ai_explanation` of an `ai_insights` row, not a template;
3. `answer_origins` includes `STORED_PERSONALISED`, or is the combined label `COMPOSED_ZERO_COST` when the question also uses a number or a definition (`lib/ai/standardQuestions/service.ts:155`);
4. a `source_refs` entry has `source_type` `financial_snapshot` and a `source_id` equal to the id of that `ai_insights` row (`storedPersonalisedResolver.ts:106`). **The first 8 characters of that id must equal `row_id8` in M11_08 block 5 for the same intent.** This ties what the screen showed to the stored table;
5. `provider_called` false and `custom_quota_consumed` false (these pages never spend);
6. `data_as_of` is present and printed day first.

For Explain the same test with `POST /api/ai/contextual-explanations/resolve`: availability AVAILABLE, never INSIGHT_PREPARING.

| | |
|---|---|
| Account | P1 (after journey b) |
| Action in the normal app | `/ai-insights`, tab **Standard Questions**. Open at least: "What makes up my net worth?" (SQ-AI-009), "How strong is my monthly cash flow?" (006), "Do I have enough emergency savings?" (011), "What are my strongest financial areas?" (002), "Why is my Financial Health Score what it is?" (004). Then use two Explain or Why buttons inside a module (for example the Dashboard score or a goal). Questions about a domain where P1 has no data may legitimately say not applicable: pick questions P1 has data for |
| Expected | Each question P1 has data for shows an answer built from stored text with an origin label for stored answers, and no placeholder |
| DELTA (M11_08 block 1) | all zero: no OpenAI run, no allowance, no ledger call |
| Sanitized evidence | per question: code, `status`, `answer_origins`, `source_id` first 8 characters, matching `row_id8`. Whole page: M11_08 block 8 (`shown` versus `unavailable`) and M11_04 block 8 for all users |
| Fails if | any question P1 has data for says "being prepared"; a stored row exists (`stored_row_present` true) but the screen still says "being prepared" (finding 2: the numeric binding); or the response is AVAILABLE with no stored origin where an explanation is part of the question (content came from a template) |
| Also record | how many of the 19 pack-dependent questions are AVAILABLE for P1. The other 6 do not need a pack |

### Journey d. Next Best Action: grounded for a user with data, safe empty state without

| | |
|---|---|
| Accounts | P1 (has data), P3 (Premium, no data), F1 (Free) |
| Action | `/ai-insights`, tab **Next Best Actions** (or `GET /api/ai/next-best-actions`) |
| Expected P1 | `status` AVAILABLE with 1 to 3 actions, each with an explanation, evidence and a source reference, or `NO_ACTIONS` when the rules find nothing (never padded). `provider_called` false, `custom_quota_consumed` false, `rules_version` present |
| Expected P3 | an empty list with status `INSUFFICIENT_DATA` or `NO_ACTIONS`, and the screen shows a calm "nothing to suggest" message, no error, no invented action |
| Expected F1 | HTTP 200 with `status` PREMIUM_REQUIRED and an empty list (`lib/ai/nba/service.ts:93`) |
| DELTA | all zero for every account (M11_08 block 1) |
| Evidence | M11_08 block 7 for P1: one new row, `trigger` api, `action_count` between 0 and 3. P3: no new row when INSUFFICIENT_DATA (the service records an evaluation only after the data check), or a row with `action_count` 0. F1: no row. Network: `rules_version`, number of actions, the first 8 characters of `snapshot_id` |
| Note | the earlier note in `../po_apply_premium_wide_access/07_MODULE11_POST_MERGE_NOTES.md` said the Next Best Action route had no Premium check. On the tip the Premium check is inside the service (`nba/service.ts`, the eligibility call), so that note is superseded |

### Journey e. The scheduler reaches ordinary Premium users, beyond the former two-address pilot

What I re-checked on the tip against the earlier notes (`../po_apply_premium_wide_access/07_MODULE11_POST_MERGE_NOTES.md`):

| Earlier finding | Status on tip `4e0f034`, read from code |
|---|---|
| No validity-window filter | **Fixed.** `lib/ai/insightPack/scheduler/schedulerDbClient.ts:41-43` keeps rows whose `effective_from` and `effective_to` include today (UTC). Each person is also re-checked by the live entitlement call (`schedulerService.ts:115`) |
| No cursor, first `maxHouseholds * 4` ids forever | **Fixed.** Keyset paging: `schedulerDbClient.ts:46-47` and `schedulerService.ts:194-210` (`collectUnprocessedSubjects`, up to 50 pages). Progress between ticks is kept by the monthly ledger, not by a stored cursor |
| No "already has this month's pack" exclusion | **Partly.** People already picked this UTC month are excluded before the size bound (`schedulerDbClient.ts:55`, `schedulerService.ts:90,196-201`). That is the job ledger, not the pack table. A person with a pack from an admin run but no job row is picked, then skipped only if the snapshot, data hash, schema and prompt version are identical (`schedulerService.ts:128-135`); otherwise a new pack is generated, subject to the 24 hour regeneration cooldown |
| Pilot e-mails | No pilot, cohort or e-mail list exists in `lib/ai`, `app/api/ai`, `app/(app)/ai-insights` or `components/aiInsights` (search for pilot, cohort, allowlist, process.env; the only hits are comments saying there is none, for example `lib/ai/access/premiumAiAccess.ts`). The only "who" rule is the Premium row |

The branch's tests for the paging fix are UNIT-TESTED and PGLITE-VERIFIED by the other agent (`tests/unit/aiSchedulerDiscoveryPaging.test.ts`, with a mutation proof). The branch has **never run against a real Premium population**. New problems I found in the same code are findings 3 and 4 (a skipped person is parked for the month; the typed-question switch makes everyone `not_premium`).

| | |
|---|---|
| Account | P1 (outside the pilot), P3, F1 as bystanders |
| Action | 1. M11_03 block 3: `premium_current_outside_pilot` at least 1. 2. M11_07 blocks 1, 2, 3, 4: universe, already picked, left to discover, ticks needed, skip reasons. 3. Admin dry run (journey b step 1; a dry run through the cron route is **refused** while `scheduler_enabled` is false, `schedulerService.ts:81`, so use the admin route). 4. Real selection proof: one non-dry admin run `POST .../scheduler/run` with `{"phase":"submit","maxHouseholds":N,"reason":"production proof"}`. The run picks people in user id order, so P1 is reached only if N covers the universe: when M11_07 block 1 `left_to_discover` is small (about 20 or fewer, cost about US$0.003 each), set N to that number. If it is large, prove selection with the dry run counts plus journey b step 2 for P1, and say so in the evidence |
| Expected | the dry run shows `discovered` above 0 and `submitted` (meaning would submit) above 0, skip reasons in `skipReasons` (`not_premium`, `context_uncertified`, `no_certified_snapshot`, `current_pack_exists`); no Free account is ever counted as submitted |
| Sanitized evidence | the JSON counts of the run; M11_04 block 10 (the run row: `triggered_by` admin, `dry_run` true or false, counts); M11_08 block 9 for P1: a job row for the month with its status; M11_07 block 1 before and after (`already_picked_this_month` rises by the number processed) |
| Fails if | P1 is never picked although inside the universe after a full run; Free or lapsed accounts appear as submitted; any run is cut off (`LEASE_EXPIRED` in M11_04 block 10) |
| Platform limits not checked by anyone | In the default mode one request makes one OpenAI call per person, 5 per tick by default: 35 to 50 seconds. The branch could not check the maximum duration of a server function on Amplify, and I know of no check of the pg_net request timeout (`03_SCHEDULER_LATER_STEP.md`). Start at `maxHouseholds` 2 |

### Journey f. Duplicate scheduling neither regenerates nor charges again

Three database rules (M11_01 block B proves they exist):

1. `uq_ai_insight_packs_identity` (migration 0121): one pack per person, snapshot, data hash, context schema, pack schema, prompt code, prompt version, country, language.
2. `idx_ai_admission_events_idempotency` (migration 0115): one admission per person and idempotency key. The pack key is `insight-pack:` plus a hash of the same identity (`lib/ai/insightPack/packIdentity.ts`). A second attempt gets the **first verdict back and nothing is charged again** (`ai_admit_request`, `0115:1504-1553`); a caller that loses the race receives the winning pack (`insightPackService.ts:337-342`).
3. `uq_ai_insight_pack_scheduler_jobs_period_subject` (migration 0176): one scheduler job per person and UTC month.
   In addition a pack admission can never consume an allowance unit (check constraint `ai_admission_events_batch_never_consumes`).

| | |
|---|---|
| Account | P1 after journey b, an Admin acting |
| Action | Take M11_08 block 1 and M11_05 block 4. Repeat the same admin real run (journey e step 4) and call `POST /api/admin/ai/insight-packs/generate` for P1 a second time. Take M11_08 block 1 and M11_05 block 4 again |
| Expected | the generate call returns the existing pack (status EXISTING_READY, same `pack_id8`); the run does not rediscover P1 (already picked this month); `openai_pack_runs` +0, `ledger_estimated_usd_all_time` +0, `ready_or_partial_packs` +0, `quota_used` +0 |
| SQL that proves it | **M11_06 blocks 1, 2, 3, 4: all 0.** Block 8: all 0. M11_01 block B: all true |
| Optional DEV only | a negative control: `begin; insert into ai_insight_pack_scheduler_jobs (billing_period, user_id) select billing_period, user_id from ai_insight_pack_scheduler_jobs limit 1; rollback;` must fail with a unique violation (23505) when the table has at least one row. Do **not** run write statements like this on production |
| Fails if | a second pack row or a second OpenAI run appears for the same identity, or the cost moves |

### Journey g. Free users cannot execute or retrieve protected Premium content

| | |
|---|---|
| Account | F1, and A1 (an Admin with no Premium: Admin status must not give consumer Premium) |
| Action in the normal app | Open `/ai-insights` as F1. The Ask FHIP tab shows a locked "Premium feature" card with no live input; Standard questions show a gated state; Next Best Actions show a gated state |
| Expected | no AI content of any kind for F1 |
| Sanitized evidence | M11_08 block 1 for F1: `entitlement_eligible` false, `entitlement_reason` premium_required, `openai_runs` 0, `quota_used` 0, `ledger_live_calls` 0. Block 8: the attempts appear as `gated`. Block 3: no allowed admission |

API checks, signed in as F1, in the browser console (F12). Each prints only a status and a reason:

```js
(async () => { const r = await fetch('/api/ai/coach/questions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How is my net worth made up?', idempotency_key: crypto.randomUUID() }) }); const j = await r.json(); return [r.status, j.data && j.data.reason]; })()
```

| Route (method) | Guard read from code | Expected for F1 |
|---|---|---|
| `/api/ai/coach/questions` (POST) | session and country confirmed, then the Premium check is the first step of the service (`lib/ai/coach/service.ts:244-250`), then `ai_admit_request` | **403**, reason `premium_required` |
| `/api/ai/coach/questions` (GET history) | same eligibility check (`service.ts:531-536`) | 403 (503 if the cause is a switch, not the plan) |
| `/api/ai/coach/questions/{id}` (GET) | eligibility, then the lookup is keyed by your own user id (`service.ts:540-545`) | 404 for Free, and 404 for any id that is not yours |
| `/api/ai/coach/questions/{id}/feedback` (POST) | eligibility (`service.ts:556-558`) | 403 |
| `/api/ai/next-best-actions` (GET) | eligibility inside the service (`nba/service.ts:93`) | 200, `status` PREMIUM_REQUIRED, empty list |
| `/api/ai/standard-questions` (GET) | eligibility | 200, `entitled` false, every question `PREMIUM_REQUIRED` (the question wording is public, no figures) |
| `/api/ai/standard-questions/{code}/resolve` (POST) | eligibility (`standardQuestions/service.ts:309`) | 200, `status` PREMIUM_REQUIRED, no answer |
| `/api/ai/contextual-explanations` (GET) | eligibility; returns no financial data | 200, `entitled` false |
| `/api/ai/contextual-explanations/resolve` (POST) | eligibility (`contextualExplanations/service.ts:453`); all 20 targets are Premium | 200, PREMIUM_REQUIRED |
| `/api/ai/entitlement` (GET) | session, country confirmed | 200 with `eligible` false |
| `/api/ai/cron/insight-pack-monthly` (POST) | header `x-cron-secret` equals `CRON_SECRET` | 401 without the secret. Do not try it with the real secret |
| `/api/admin/ai/*` | `requireAdmin()`; `operations` and `scheduler/run` also need the AI Operations capability | 401 or 403 for F1 and for A1 where the capability is missing |
| `/api/internal/ai/provider/health`, `/api/internal/ai/context/preview`, `/api/internal/ai/context/validate`, `/api/internal/ai/resolve` | **session and country confirmed only. No Premium check** | **200 for F1**, with F1's own data only. See finding 7 |

Cross-account check (P1's id must be unreachable by P2): as P2 call `GET /api/ai/coach/questions/<P1 question_id>`: expected **404** "Question not found", the same as for an id that does not exist.

### Journey h. Lapsed or expired Premium

| | |
|---|---|
| Account | E1 = P2 after you shorten P2's grant in Admin so that it ended yesterday (UTC date) |
| Action | As E1 repeat: open `/ai-insights`, ask a Coach question, open a Standard question, open Next Best Actions, reopen an old Coach answer |
| Expected | the Coach is refused with the Premium prompt (HTTP 403, `premium_required`, the database reports a lapsed window as `premium_required`, `0115:2261-2263`); history 403; reopen 404; Standard questions, Explain and Next Best Action return the gated state. No new OpenAI run. Old stored rows are **not deleted** |
| Sanitized evidence | M11_08 block 1 for E1: `plan_tier` premium, `premium_to` a past date, `entitlement_eligible` false, `entitlement_reason` premium_required, `openai_runs` unchanged. M11_03 block 1: `premium_lapsed` +1, `premium_current` -1. M11_07 block 1: `premium_in_window` -1 |
| Timing | the window is compared with the **database date (UTC)**, inclusive on both ends: a grant that ends "today" still works until midnight UTC. A person in Melbourne may see it end at 10:00 or 11:00 local time on the next day |
| Fails if | E1 still gets a new answer, a new run appears, or E1 is picked by the scheduler on the next run |
| Note | a lapsed or Free person can still read their own old rows through the database API where a "select own" policy exists (for example `ai_insight_packs`, `0121`); the app screens do not show them. Not tested |

### Journey i. Quota, rate and budget refusal paths, without spending real money

Defaults **as written in migrations** (production values are UNKNOWN until you run M11_02 block 1; the branch pack states it leaves the ceilings unchanged):

| Control (`ai_platform_controls` column) | Default | Refusal reason in `ai_admit_request` | What the person sees (HTTP) |
|---|---|---|---|
| `monthly_custom_question_allowance` | 10 per UTC month, no rollover | `quota_exhausted` | allowance used up (429, `custom_question_limit_reached`) |
| `rate_limit_max_requests` per `rate_limit_window_seconds` | 12 per 3600 seconds | `rate_limited` | slow down (429, `rate_limit_reached`, `Retry-After` 60) |
| `per_user_monthly_cost_ceiling_usd` (soft `per_user_soft_cost_threshold_usd`) | US$5 (soft US$4) | `user_cost_ceiling` | AI usage limit reached (503, `cost_limit_reached`) |
| `platform_monthly_cost_ceiling_usd` (soft `platform_soft_cost_threshold_usd`) | US$500 (soft US$400) | `platform_cost_ceiling` | AI temporarily unavailable (503) |
| `max_cost_per_request_usd` | US$0.50 | `request_cost_limit` | too large to process (public error code `invalid_request`, no special HTTP status in the route) |
| `daily_live_ai_cost_limit_usd` | US$50 per UTC day, live answers only | `daily_cost_limit` | AI temporarily unavailable (503) |
| `max_concurrent_requests_per_subject` | 1, lease 120 seconds | `request_in_progress` | one request at a time (429) |
| token budgets | context 12000, user input 2000, output 800 (the go-live raises output to 3200) | `token_budget_exceeded` | |

These come from `0115_module11_1_ai_entitlements_quotas_cost_controls.sql` (lines 149-210 and 990-1040) and `ai_admit_request` (lines 1427-2058); the public wording is in `lib/ai/entitlement/types.ts:215-302`. The US$1 per user per day control in migration 0284 belongs to the document reading feature (AIE), **not** to Module 11. The branch's addendum records that Module 11 has no explicit per-user daily limit; the derived worst case is about US$0.66 per user per day, and the monthly US$5 ceiling is the real cap (`MODULE11_ADDENDUM_16-10-2026_PROMPT_V3_AMPLIFY_CAP_PLAN.md` section 3, the other agent's calculation).

**How to verify a refusal without spending.** Every Coach and pack request is checked by `ai_admit_request` before any OpenAI call, so a refused request costs nothing. Lower one control to a tiny value, ask one question as P1, read the refusal, restore the control. Use `M11_91_TEMP_LOWER_LIMITS_TEST_WRITE.sql`, after the backup (`M11_90` B1 to B5):

1. **Do it on DEV first** (`vqycarelcoijzwlpkpcz`). Every control is platform wide, so while one is lowered every Premium user is refused the same way. On production only in a short quiet window (M11_05 blocks 3 and 6 show activity).
2. Run one LOWER block, do the browser step, run the matching RESTORE block, then M11_02 block 1 to confirm the value is back. Never leave two lowered at once.
3. Order matters for the two monthly ceilings: the soft threshold must be removed before the hard ceiling is lowered, and the hard ceiling restored before the soft threshold (the database refuses a soft threshold above its hard ceiling). The file does this in two steps each.
4. The hourly rate test needs one real earlier request in the same hour (about US$0.001 and one allowance unit). All the others cost nothing.

| Test (block in M11_91) | Ask | Expected in the app | Evidence |
|---|---|---|---|
| T1 allowance to 0 | a new Coach question | allowance used up; Standard questions, Explain and Next Best Action still work | M11_08 block 3: newest row `decision` denied, `deny_reason` quota_exhausted. Block 2: no new run. `quota_used` unchanged |
| T2 per request cost | a new Coach question | too large to process | `request_cost_limit` |
| T3 per user monthly | a new Coach question | AI usage limit reached | `user_cost_ceiling`; M11_05 block 7 shows `user_cost_ceiling_reached` |
| T4 platform monthly | a new Coach question | AI temporarily unavailable | `platform_cost_ceiling`; event `global_cost_ceiling_reached` |
| T5 daily live | a new Coach question | AI temporarily unavailable | `daily_cost_limit` |
| T6 hourly rate to 1 | a second, different question inside the hour | slow down | `rate_limited` |

After each restore: the control is back (M11_02 block 1), M11_08 block 1 shows no change in `openai_runs` and `quota_used` for the refused tests, and the change is listed in M11_02 block 8 (the audit trigger records every change).

## 5. Where each journey gets its evidence

| Journey | Main SQL | Browser or API evidence |
|---|---|---|
| a Coach | M11_08 blocks 1, 2, 6; M11_05 blocks 1, 3 | Network response fields, health call |
| b Pack | M11_08 blocks 1, 3, 4; M11_04 blocks 1, 2, 4, 10; M11_06 | admin route JSON |
| c Stored content | M11_08 blocks 5, 8; M11_04 blocks 4 to 9 | Network response of the resolve call |
| d Next Best Action | M11_08 block 7 | Network response |
| e Scheduler reach | M11_03 block 3; M11_07; M11_04 blocks 10, 11; M11_08 block 9 | dry run and run JSON counts |
| f Duplicates | M11_06; M11_01 block B; M11_05 block 4 | second call result |
| g Free | M11_08 blocks 1, 3, 8; M11_01 blocks C, D | console statuses |
| h Lapsed | M11_08 block 1; M11_03 block 1; M11_07 block 1 | screens, console statuses |
| i Limits | M11_91, M11_08 blocks 2, 3; M11_05 block 7; M11_02 blocks 1, 8 | refusal text |

## 6. Module 11's own rollback controls

`AIE_AI_FALLBACK_ENABLED` and `II_AI_FALLBACK_ENABLED` control the **document reading** feature. They **do not control Module 11** and must not be used as a Module 11 switch. Module 11's own stop controls are the rows below. They take effect on the next request; none needs a deploy. The SQL is in `sql/M11_90_ROLLBACK_SWITCHES_WRITE.sql` (a WRITE file; run `B1` to `B5` first, because production has no managed backups; run one block at a time; afterwards run M11_02 block 1 and keep the result with the date and reason).

| Switch | Block | Stops | Keeps working |
|---|---|---|---|
| `ai_globally_enabled` = false | STOP 1 | everything governed: Coach, packs, Standard questions, Explain, Next Best Action | nothing AI |
| `live_provider_enabled` = false | STOP 2 | every request that would reach OpenAI (Coach questions and pack generation). **The narrowest way to stop spending** | Next Best Action, rule based Standard questions, stored answers already written |
| `custom_ai_enabled` = false | STOP 3 | typed Coach questions **and, as read from code, every feature that asks the entitlement function** (finding 3) | |
| `batch_generation_enabled` = false | STOP 4 | every pack generation, scheduled or admin | the Coach |
| `scheduler_enabled` = false | STOP 5 | the unattended monthly run (packs already submitted are still collected) | admin runs |
| `next_best_action_enabled` = false | STOP 6 | Next Best Action and SQ-AI-003 and SQ-AI-025 | |
| `contextual_explanations_enabled` = false | STOP 7 | Explain and Why buttons | Standard questions |
| OpenAI provider row (`ai_provider_controls`) | STOP 8 | every OpenAI bound request | rule based features |
| OpenAI model row `active` = false | STOP 9 | Coach and packs fail closed before any provider call | |
| Prompt rows (PR-AI-010, PR-AI-013) | use the branch pack files 80, 81, 82 (`docs/ai/po_apply_module11_production/sql/` on the branch) | withdraw or go back to v2. v2 had the higher refusal rate, so a switch is the better first move | |
| Restore | RESTORE 1, 2, 3 | puts switches, model and provider rows back to the saved copy | |

Environment and scheduler switches (these need a rebuild or a cron change):

| Control | Effect | Caution |
|---|---|---|
| Remove or change `MODULE11_AI_PROVIDER` | provider becomes the mock | **Not a safe stop.** While a prompt is ACTIVE the Coach would answer with mock text that looks real. Use the database switches |
| Remove `OPENAI_API_KEY` | OpenAI calls fail closed (health shows `credential_configured: false`) | needs a rebuild to take effect |
| `MODULE11_SCHEDULER_MAX_HOUSEHOLDS_PER_RUN` | people per tick | needs a rebuild |
| Rotate `CRON_SECRET` | cron calls get 401 | also affects the other scheduled jobs that use it |
| Remove the schedule: `select cron.unschedule('module11-insight-pack-monthly');` | no more ticks | the statement is from the branch document, not tested |

**Must be preserved in any rollback.** The per-user monthly cap (US$5), the platform ceilings, the daily live limit, the per request cap, the hourly rate limit, the monthly allowance, the concurrency limit and every kill switch. Never drop, empty or recreate `ai_platform_controls`, `ai_task_cost_limits`, `ai_admission_events`, `ai_usage_ledger`, `ai_config_audit` or the function `ai_admit_request`, never set a ceiling to null or to a larger value to make a problem go away, and do not roll the schema back: the branch's additions are additive and harmless to the previous build, so a bad build is handled by redeploying the previous Amplify build. The two WRITE files never touch a ceiling (M11_91 lowers one temporarily and restores the saved value).

## 7. Remaining gates for Module 11, as recorded on the branch

All statuses are what the branch documents say, as of the last gate document commit `a73aa90` (16/10/2026 20:16). They are the other agent's claims, not re-verified by me.

| Gate | Status | Source |
|---|---|---|
| 0. DEV has main's migration 0285 | **DONE** (PO applied it to DEV on 16/10/2026; read-only check `tax_amount_present true`) | `docs/ai/po_browser_leg/M11_7_PO_BROWSER_CHECKLIST_AND_DELTA_QUERIES.md` row 000 |
| 1. Prompt v3 pack on DEV (steps 01 seed, 03 verify, 02 activate) | **Not recorded as applied.** The addendum says DEV still runs prompt version 2 ("the PO has not applied the v3 pack on DEV yet") and the D1 test must be re-run after v3 is activated. The checklist section 00 has no results | `docs/ai/MODULE11_ADDENDUM_16-10-2026_PROMPT_V3_AMPLIFY_CAP_PLAN.md` section 8 and the checklist section 00 |
| 2. Premium browser checklist (page, input, allowance, Standard questions, Next Best Action, history, states, network, console, responsive 375 to 1440, accessibility) | **NOT RUN** (waiting on the PO; "No waiver is inferred") | checklist header; closure report lines 121 to 126 |
| 3. Free browser checklist | **NOT RUN in a browser.** At service and API level it is DEV-verified (Free user, another user's household id and question id all denied, provider 0) | closure report line 122 |
| 4. Answer tone review (at least 3 answers across 3 domains) | **NOT RUN by the PO.** The preliminary read of 5 answers by an agent "is not a sign-off" | closure report lines 127 and 131 |
| 5. Admin AI Operations browser proof (R4) | **NOT RUN, PO-waived since 01/10/2026**, the waiver is "not read as closure" | closure report line 234 |
| 6. Final decision | **Module 11.7 CONDITIONAL PASS. NOT READY FOR MERGE. Production activation NOT AUTHORIZED** (the report's wording, written 15/10/2026). Your 16/10/2026 decision is recorded as authority for a bounded production activation, but the pack states "I have not run it and I infer no waiver" for gate 2 | closure report lines 24 to 29; `po_apply_module11_production/00_README_PO_ORDERED_STEPS.md` |
| 7. Production precheck A and B (which Module 11 base migrations exist in production) | **NOT RUN** | pack README, "Three gates" |
| 8. Latest DEV re-run on the merged tip | 11.7 coach suite 22 passed, 1 skipped, **1 failed (D1: 1 of 4 golden questions answered, 2 needed)**; R6 18 of 18; closure journey 9 of 9 with the real provider; prompt v3 A/B refusal v2 48.7 percent versus v3 35 percent (an earlier measurement said 60 versus 15). Two live suites NOT RUN | addendum section 8 |

## 8. Findings: anything that makes "live for ordinary Premium users" false or unsafe

Severity is my judgement. File and line numbers are on branch tip `4e0f034`. Findings 2 and 3 are the ones most likely to surprise you.

1. **HIGH. 19 of 25 Standard questions and the pack-backed Explain buttons show a placeholder until packs exist, and the go-live leaves the scheduler OFF.** `lib/ai/standardQuestions/service.ts:269-272` (a question with an explanation part is "pack not ready" when no pack exists), `:91` and `:400` (all parts must resolve), `components/aiInsights/StandardQuestionLibrary.tsx:60`, `lib/ai/contextualExplanations/service.ts:287` and `types.ts:48`; decision in `docs/ai/po_apply_module11_production/03_SCHEDULER_LATER_STEP.md`. Fix needed before the claim: a pack for every entitled user, which needs the scheduler (or repeated admin runs) and passes through findings 3 and 4.
2. **HIGH, unverified. A real pack's stored answers may never be shown for some intents.** The stored answer is served only if its `current_value` matches a live figure (`lib/ai/resolution/storedPersonalisedResolver.ts:46-49`, `:154`). Only 9 intents have a live comparison; the rest fall to `default: null` (`:93`). A pack stores the first metric claim's number as `current_value` (`lib/ai/insightPack/packComposition.ts:116`). So a stored row that carries a number for an intent with no live comparison "never matches" and the question keeps saying it is being prepared (the file's own comment says it fails closed to "not yet available"). **The DEV proof does not cover this**: the live test seeded synthetic rows with `current_value` null (`tests/live-dev/module11_7AiCoachLiveDev.test.ts:187-188`) rather than using a real pack's rows. The branch records no DEV check that a real pack's stored answer was displayed as AVAILABLE. Use M11_04 block 5 (rows that cannot be served) and M11_08 block 5, and journey c, on DEV before production.
3. **HIGH. `custom_ai_enabled = false` is not "only the typed questions".** `ai_entitlement_state` reports not eligible while it is false (`supabase/migrations/0115_module11_1_ai_entitlements_quotas_cost_controls.sql:2270`), and Standard questions, Explain, Next Best Action, the stored resolver and the scheduler all ask that function (`standardQuestions/service.ts:218-224,309`, `contextualExplanations/service.ts:453`, `nba/service.ts:93`, `schedulerService.ts:115`). The branch's own live test says so (`tests/live-dev/module11_7AiCoachLiveDev.test.ts:570-573`: "every personalised AI surface ... treats the subject as not eligible"), but the pack file `sql/switches/off_coach.sql:1`, `01_AMPLIFY_ENV_AND_SWITCHES.md:43` and the Admin screen text (`components/admin/AiOperationsClient.tsx:55`) say the other features keep working. Premium people would see the "Premium feature" gate. If the scheduler runs while it is false, every person is skipped as `not_premium` and parked for the month (finding 4). The narrow way to stop paid calls is `live_provider_enabled`.
4. **MEDIUM. A skipped person is parked for the whole UTC month.** `schedulerService.ts:143` writes a job row even for a skipped person, and discovery excludes everyone with a job row this month (`schedulerDbClient.ts:55`, `schedulerService.ts:90,196-201`). Reasons that are temporary (`context_build_failed` `:120`, `no_certified_snapshot`, `not_premium` caused by a switch or an outage `:115`) are never retried until the next month. An ordinary Premium user whose data was not certified on the day of the run gets no pack all month.
5. **MEDIUM. Mid-month data changes make stored answers go stale with no regeneration.** Stored rows are compared with live figures on every read (`storedPersonalisedResolver.ts:154`); the scheduler does not rediscover a person already ledgered this month. Expect the placeholder to return for changed intents until next month or an admin regeneration (24 hour cooldown, forced with a reason). Read from code, not tested.
6. **MEDIUM, unverified platform limits.** The default mode makes one OpenAI call per person inside one HTTP request, 5 per tick (`lib/ai/config.ts:79-83`; the code constant `DEFAULT_MAX_HOUSEHOLDS_PER_RUN` is 50, `schedulerService.ts:42`, but the cron route passes the config value). The branch could not check Amplify's function time limit; I found nothing that checks the pg_net timeout either. A cut-off tick leaves its run `RUNNING` until the 15 minute lease expires and then `LEASE_EXPIRED`.
7. **MEDIUM. Internal certification routes are open to every signed-in user, Free included, and not rate limited:** `app/api/internal/ai/provider/health/route.ts:16-17` (makes an outbound OpenAI model lookup and returns the provider, model, batch mode and scheduler size), `context/preview/route.ts:16` (returns the caller's own full AI context), `context/validate/route.ts:14`, `resolve/route.ts:16` (runs the zero cost router). They return only the caller's own data and do not call the paid model, but they are DEV tools shipped to production. I did not trace whether the deterministic part of the router answers a Free user. Decision for you: gate them behind the AI Operations capability or remove them.
8. **LOW to MEDIUM. Admin AI routes are mostly gated by `requireAdmin()` only.** Of the 22 routes under `app/api/admin/ai`, only `operations` and `scheduler/run` use the named capability (`lib/services/aiOperationsAdmin.ts`); the kill switch, controls, models, prompts and `insight-packs/generate` (`generate/route.ts:27`) use `requireAdmin()`, and `03_SCHEDULER_LATER_STEP.md` describes `generate` as needing `can_manage_ai_operations`, which the code does not check. I did not assess this against `docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md`, which I was not asked to read here; it should be reviewed before more admins get access.
9. **MEDIUM. The environment forwarding fix exists only on the branch.** `amplify.yml:185` forwards `MODULE11_` and `OPENAI_API_KEY` on the tip; `origin/main` forwards neither. The variables must be set before the build that deploys the branch.
10. **MEDIUM. Unset provider means the mock.** `lib/ai/config.ts:35-37`. The mock model row is active and approved for `general_coach` from migration 0110, and an active prompt would let the Coach answer with mock text (addendum section 7). The pack orders the health check first; do not skip it, and do not use removing the variable as a rollback.
11. **INFO. Not merged, not activated, no production state known.** Gates 2 to 7 in section 7. The production state of the base migrations is unverified (M11_01 block A answers it).
12. **INFO. Refused answers cost money but no allowance.** A refused real call is billed, not shown and not charged to the allowance (addendum section 1). The branch measured 15 to 35 percent refusals on "why" questions. The hourly limit of 12 bounds the worst case per person (addendum section 3, US$0.66 per day, their calculation).
13. **LOW. Admin generated packs and the stored table are not visible to people.** There is no user screen for a pack (section 2). If you want people to see "their monthly pack" as a page, that screen does not exist on this branch.

## 9. Evidence table (copy per run; fill every cell; attach screenshot names)

| Journey | Date and time (dd/mm/yyyy hh:mm) | Account | Expected | Actual | M11_08 block 1 before | M11_08 block 1 after | Ids (8 characters) | Screenshot | Label |
|---|---|---|---|---|---|---|---|---|---|
| 3.1 to 3.3 preconditions | | | all true | | | | | | |
| 3.6 provider health | | P1 | openai, credential true | | | | | | |
| a Coach live | | P1 | run +1, allowance -1 | | | | | | |
| a repeat and reopen | | P1 | all +0 | | | | | | |
| b dry run | | Admin | counts, no spend | | | | | | |
| b one pack | | P1 | READY or PARTIAL, allowance +0 | | | | | | |
| c Standard questions (list each code) | | P1 | AVAILABLE with stored origin | | | | | | |
| c Explain (two targets) | | P1 | AVAILABLE | | | | | | |
| d NBA with data | | P1 | up to 3 grounded actions | | | | | | |
| d NBA no data | | P3 | empty, calm | | | | | | |
| e selection | | Admin, P1 | P1 has a job row | | | | | | |
| f duplicate run | | Admin, P1 | all +0 | | | | | | |
| g Free (each route) | | F1 | 403 or gated | | | | | | |
| g cross account | | P2 | 404 | | | | | | |
| h lapsed | | E1 | refused, no run | | | | | | |
| i T1 to T6 (each) | | P1 | refused with named reason | | | | | | |
| M11_06 blocks 1 to 4 | | | all 0 | | | | | | |

Label each row PRODUCTION-VERIFIED only when you ran it on production and the actual result matches. Anything else stays NOT PERFORMED. A DEV run is DEV-verified, never PRODUCTION-VERIFIED.

## 10. What this protocol does not claim

- No production fact. I did not check the production schema, the Amplify console, the OpenAI key or its project access, pg_cron, Vault, the size of production, or the number of Premium users.
- I ran no SQL and no test. The only command I ran on my own files was the repository's editor-safety lint.
- The branch's own documents (closure report, addendum, production pack) are quoted as the other agent's claims. I read them, I did not re-run their tests.
- The default control values come from migrations. Production may differ; M11_02 block 1 is the truth.
- I did not read `docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md`. Finding 8 is an observation about route guards, not an Admin Standard review.
