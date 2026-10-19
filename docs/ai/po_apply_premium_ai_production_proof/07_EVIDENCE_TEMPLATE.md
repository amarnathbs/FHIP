# 7. Evidence sheet: sanitized, one block per journey

Rules. Paste only what these blocks ask for. **Never paste** a password, a key, a token, an e-mail address, a file's text, a full document id (8 characters
is enough in a report), an object key, or any environment value other than the plain switches the checker prints. Dates are day-first (dd/mm/yyyy, 24-hour Melbourne
time). A cell you could not fill says **NOT PERFORMED** with the exact step where it stopped. A result is never rounded up.

## 7.1 Run header (once)

```
Run date and operator:           __/__/____   ______
Deployed commit (Amplify console, Deployed): ________   fast-forward from origin/main verified: yes / no
Project ref seen in the SQL editor address bar: twwpnltizhtjxhamyoxt  (production)
sql/A01 rows false:              ____ (names)         0284 present: yes / no       0160 present: yes / no
Amplify check table pasted:      yes / no           any CHECK or MISSING rows: ____
sql/A02 before:                  stored allowance ____  settled ____  remaining ____  per-user cap ____  attempts ____  premium_active_today ____
Accounts:  P1 ____ (user prefix, premium_today true, not a pilot address)   P2 ____   F1 ____   X1 ____ / skipped (why)   A1 ____
Files checked against MANIFEST.sha256:  yes / no
```

## 7.2 One block per journey (copy as many as you run)

```
Journey:                   1 (bank PDF)  /  4.1 payslip  /  4.2 liability  /  4.3 retirement  /  4.4 AU investment  /  4.5 Investment Intelligence  /  R__ refusal
Document id and file:      DOC-__  (8 characters of the id)       Format: PDF (document scan)  /  CSV (structured file)
Account / plan:            P1 / Premium, outside the former pilot
Start time:                __/__/____ __:__

STEP EVIDENCE                      expected                           actual                      equal? 
Upload accepted                    yes, no Premium message            ______                      
Scan (E01)                         clean, version/ETag/key match      ______                      
Scan copy purge (E01)              absent                             ______                      
Parser shortfall + AI draft (E02)  native started, draft_ready        ______                      
Draft vs sheet (every row)         see EXPECTED_VALUES.md             rows ok __/__               
Model (E02/E04)                    gpt-4o-mini, request ids >= 1      model ____ ids __ tokens __/__
Cost (E04, A02)                    settled < 0.01                     settled ______  ledger delta ______
Durable draft (E03)                pending_review:..:rows=N           ______
Original deleted (E01)             purged, object not stored          purged at __:__    
Accepted at                        later than the deletion time       __:__               
Canonical result (E03/E07/E08)     figures from the sheet             ______
Downstream screen                  matches the sheet                  ______
Replay (upload again / reload)     no new attempt, no new rows        attempts ____ -> ____   rows ____ -> ____
Cross-tenant (P2 opens P1 doc)     not found                          ______
Cleanup done                       C00-C05 / app delete               yes / no

Result:   PASS / FAIL / NOT PERFORMED     Defect(s) found: ______
```

## 7.3 Refusal block (R1 to R9)

```
Refusal step: R__    Account: F1 / X1 / A1 / E1      plan from E10: ______  premium_today: true / false
Action and time:           ______                      Screen text shown: ______
E06 before:  uploads __ drafts __ cost_attempts __ ai_events __     after:  uploads __ drafts __ cost_attempts __ ai_events __
A02 before/after (attempts, settled): ____/____   ____/____          Reason in E02 (if a document exists): ______
Result: PASS (refused, nothing stored/charged) / FAIL / NOT PERFORMED
```

## 7.4 Close-out (once)

```
sql/A02 after:   settled ____  remaining ____   open reservations over 1 h ____ (expect 0)
sql/E09:         scan_pending_over_30_min ____  originals_kept_over_2_hours_after_durable_result ____  scan_copy_purge_unverified ____
Cleanup:         C02 all ok: yes/no   C03 deleted ____ accounts   C04 residue 0: yes/no   C05 copies dropped: yes/no
Premium grants on the proof accounts ended / end on: __/__/____
What I could not do and why: ______
```
