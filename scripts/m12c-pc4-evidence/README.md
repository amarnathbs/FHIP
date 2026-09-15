# M12C — PC4 production evidence

**Everything in this directory was produced by READ-ONLY `GET` probes against the
PRODUCTION database on 2026-09-16. No write, RPC, DDL or DML of any kind was
issued. Every probe runs a negative control first, so an absence it reports is
distinguishable from a probe that did not run.**

## What is here, and what is deliberately NOT here

| File | Contents |
|---|---|
| `production_finding_taxonomy.txt` | The structural classification of the real CAS parse run's 251 `unparseable_transaction_row` findings, verbatim output of `scripts/m12c_pc4_warning_taxonomy_probe.mjs`. |

`production_finding_taxonomy.txt` is safe to commit **by construction, not by
review**: the probe that produces it never prints a source line. Every line is
reduced in-process to a shape skeleton in which every digit becomes `9` and
every letter run becomes `A`, and only per-class counts are emitted. Nothing
identifying can survive that transform.

**Three other probes were run and their outputs are deliberately NOT committed:**

- `scripts/m12c_pc4_readonly_probe.mjs` — per-position reconciliation arithmetic
- `scripts/m12c_pc4_residual_replay_probe.mjs` — per-position source-order replay
- `scripts/m12c_pc4_residual_attribution_probe.mjs` — per-row attribution

Their outputs carry the Product Owner's **real holdings and real dated
transaction rows**. The mission's own Part A.1 forbids committing the Product
Owner's personal financial history to this repository, and a structural
"it is only units" reading of that rule would be a loophole, not compliance.
The scripts themselves ARE committed and are re-runnable by anyone with the
credentials, so every claim in
`docs/investment-intelligence/M12C_INTEGRITY_HARDENING_CLOSURE_2026-09-15.md`
that rests on them is reproducible — the report cites the conclusions and the
aggregate figures PC4's own published reports already contain, never a row.

## Re-running

```
node scripts/m12c_pc4_readonly_probe.mjs prod
node scripts/m12c_pc4_warning_taxonomy_probe.mjs prod
node scripts/m12c_pc4_residual_replay_probe.mjs prod
node scripts/m12c_pc4_residual_attribution_probe.mjs prod
```

Each reads `D:/FHIP/.env.local` for credentials, refuses to run if the
production URL equals the DEV URL, and issues `GET` only. Pass `dev` instead of
`prod` to point any of them at DEV.
