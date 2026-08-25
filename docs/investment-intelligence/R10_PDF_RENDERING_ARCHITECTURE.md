# II-R10 — PDF Rendering Architecture

Status: REUSED, unmodified rendering stack; verified live this session with
the 5 new II chapters present.

## Stack (pre-existing, migrations 0022/0024)

- Renderer: Playwright headless Chromium (`lib/services/reportPdfRenderer.ts`), driving the report's own print route (`app/(app)/reports/[id]/print` under `app/(print)/reports/[id]/print`) — the exact same React tree the in-app preview renders, so preview and PDF are structurally guaranteed to match (spec section 43/80).
- Authorization for the headless render: a single-use `render_token`/`render_token_expires_at` pair on `report_exports`, minted server-side just before navigation and cleared immediately after (5-minute TTL) — no user session is impersonated.
- Storage: private `report-exports` Supabase Storage bucket, uploads via the service-role client only, owner-only `storage.objects` SELECT policy.
- Download: `app/api/report-exports/[exportId]/download/route.ts` issues a 60-second signed URL and 302-redirects; as of this session's security fix, `download_count` increment and the `report_access_events` insert both go through the admin client (previously the RLS-scoped client — see `R10_REPORT_SECURITY_MODEL.md`).
- Page format: A4, 18mm/20mm/14mm/14mm margins, real running page numbers via Playwright's own header/footer template mechanism (plain CSS `@page` margin-box content is not supported by Chromium's print-to-PDF pipeline, so this is the only mechanism that works).
- Chart-timing fix already in place: a `waitForFunction` polls every `.recharts-wrapper svg`'s `getBBox()` for non-zero width AND height before calling `page.pdf()`, specifically to avoid the "blank chart" defect this project hit and fixed previously (commit `124be2c`).

## This session's live verification

`scripts/r10_live_dev_certification.mjs` LIVE-R10-F1/F2 (real DEV, real running `next dev`, `APP_BASE_URL` pointed at it): generated a real premium report for a real test user (with the 5 new II chapters present, all correctly in the `unavailable` state since the user had no II analytics data), requested a real PDF export, and downloaded it via a real signed URL. See `R10_ACCEPTANCE_REPORT.md` for the pass/fail result and exact file size observed.

## Not verified this session

- PDF rendering with the 5 new II chapters in their `included` state (populated with real R4/R5/R6/R9 data) — this session's live test user had no II analytics data, so the new chapters were only exercised in their `unavailable` path in the PDF. A user with real II data producing tables/charts in these 5 new chapters has not been visually inspected in PDF form.
- Long-content/clipping stress test (spec section 44) specifically targeting the 5 new chapters (long fund names, many holdings, many review items) was not run.
- Print-stylesheet visual inspection (headers/footers/page breaks around the new chapters specifically) was not manually reviewed — only generation success and file size were checked programmatically.
