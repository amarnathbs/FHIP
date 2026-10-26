WP-G bank import job: DEV-verified on tip 0eeb5c3 (DEV project vqycarelcoijzwlpkpcz only), 26-10-2026.
Script: scripts/doc2_4_wp_g_dev_run.ts against a local dev server (node scripts/pdf_routes_dev_server.mjs 3947).
Results: scale 22/22, robust 11/11, kill 5/5, ai 17/17 (run "final2").
The first AI run (transcript_ai_final_FAILED_server_flag_missing.txt) failed 3 of 8 checks (layout_unsupported) because the dev server
process did not have AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED=true (audit reason adapter_disabled). The AI mode REQUIRES that variable set
on the dev server process; it was set per process only (AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED=true node scripts/pdf_routes_dev_server.mjs 3947).
scripts/pdf_routes_dev_server.mjs was not changed. What production does with that switch is the Product Owner's decision and is unchanged here.
Residue: read-only check afterwards found 0 leftover wpg- synthetic users on DEV. Server stopped (nothing listening on 3947).
Label: DEV-verified. Never PRODUCTION-VERIFIED.
