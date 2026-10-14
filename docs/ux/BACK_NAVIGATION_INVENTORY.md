# Back navigation inventory (PO review 06-10-2026, finding F6)

PO finding F6: "No return or back button, I see this in many pages, this will be the global correction, please check all pages and make sure that all pages do have the button to return back. Also for all future pages please make sure this is applicable."

The one shared control is `components/navigation/PageBackLink.tsx`:

```tsx
<PageBackLink href="/admin/resources" label="Resources" />   // renders "Back to Resources"
```

It is a real Next link to the page's PARENT (not `router.back()`, so a deep link or bookmark still has a way up), visible, keyboard focusable with a visible focus outline, minimum 44 px touch height, inside a `nav` landmark labelled "Back navigation".

## Rule for every new page

1. Every `page.tsx` under `app/` renders `<PageBackLink href=".." label=".." />` pointing at its parent in the app hierarchy.
2. The only exceptions are the pages listed as Exempt below (top-level landing and dashboard, authentication, mandatory onboarding gates, print/PDF targets). A new exemption needs a reason in `BACK_LINK_EXEMPT` in `tests/unit/pageBackLinkGuard.test.ts` and a row here.
3. Add the page to the table below.
4. `tests/unit/pageBackLinkGuard.test.ts` fails when a page lacks the component, when its target is not a real route, or when the page is missing from this table.
5. Editors with unsaved changes are covered without extra code: `useUnsavedChangesGuard` intercepts every in-page link click (including this one) and asks "Leave without saving?".

Pages are wrapped (`export default function XPage(props) { return <><PageBackLink .../><XPageContent {...props} /></>; }`) so every return path, including error and empty states, shows the control.

## Inventory

123 pages: 113 carry the back link, 10 are exempt.

| Page (URL) | File | Parent target | Status |
|---|---|---|---|
| `/` | `app/(marketing)/page.tsx` | none | Exempt: Public landing page (top level). |
| `/about` | `app/(marketing)/about/page.tsx` | `/`: "Back to home" | Done |
| `/accessibility` | `app/(marketing)/accessibility/page.tsx` | `/`: "Back to home" | Done |
| `/admin/account-deletions` | `app/(app)/admin/account-deletions/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/admin/benchmarks` | `app/(app)/admin/benchmarks/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/admin/benchmarks/upload` | `app/(app)/admin/benchmarks/upload/page.tsx` | `/admin/benchmarks`: "Back to Planning Benchmarks" | Done |
| `/admin/entitlements` | `app/(app)/admin/entitlements/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/admin/entitlements/promo-codes` | `app/(app)/admin/entitlements/promo-codes/page.tsx` | `/admin/entitlements`: "Back to Premium Access" | Done |
| `/admin/investment-intelligence/benchmark-data` | `app/(app)/admin/investment-intelligence/benchmark-data/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/admin/investment-intelligence/lookthrough-data-quality` | `app/(app)/admin/investment-intelligence/lookthrough-data-quality/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/admin/investment-intelligence/market-index-data` | `app/(app)/admin/investment-intelligence/market-index-data/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/admin/investment-intelligence/reference-data-quality` | `app/(app)/admin/investment-intelligence/reference-data-quality/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/admin/recommendations` | `app/(app)/admin/recommendations/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/admin/resources` | `app/(app)/admin/resources/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/admin/resources/analytics` | `app/(app)/admin/resources/analytics/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/admin/resources/content` | `app/(app)/admin/resources/content/page.tsx` | `/admin/resources`: "Back to Resources" | Done |
| `/admin/resources/content/[id]` | `app/(app)/admin/resources/content/[id]/page.tsx` | `/admin/resources/content`: "Back to All Content" | Done |
| `/admin/resources/content/[id]/edit` | `app/(app)/admin/resources/content/[id]/edit/page.tsx` | `/admin/resources/content`: "Back to All Content" | Done |
| `/admin/resources/content/[id]/preview` | `app/(app)/admin/resources/content/[id]/preview/page.tsx` | `/admin/resources/content/${id}/edit`: "Back to Editor" | Done |
| `/admin/resources/content/archived` | `app/(app)/admin/resources/content/archived/page.tsx` | `/admin/resources/content`: "Back to All Content" | Done |
| `/admin/resources/content/drafts` | `app/(app)/admin/resources/content/drafts/page.tsx` | `/admin/resources/content`: "Back to All Content" | Done |
| `/admin/resources/content/new` | `app/(app)/admin/resources/content/new/page.tsx` | `/admin/resources/content`: "Back to All Content" | Done |
| `/admin/resources/content/published` | `app/(app)/admin/resources/content/published/page.tsx` | `/admin/resources/content`: "Back to All Content" | Done |
| `/admin/resources/content/review` | `app/(app)/admin/resources/content/review/page.tsx` | `/admin/resources/content`: "Back to All Content" | Done |
| `/admin/resources/content/review-due` | `app/(app)/admin/resources/content/review-due/page.tsx` | `/admin/resources/content`: "Back to All Content" | Done |
| `/admin/resources/content/scheduled` | `app/(app)/admin/resources/content/scheduled/page.tsx` | `/admin/resources/content`: "Back to All Content" | Done |
| `/admin/resources/context` | `app/(app)/admin/resources/context/page.tsx` | `/admin/resources`: "Back to Resources" | Done |
| `/admin/resources/ctas` | `app/(app)/admin/resources/ctas/page.tsx` | `/admin/resources`: "Back to Resources" | Done |
| `/admin/resources/ctas/[id]/edit` | `app/(app)/admin/resources/ctas/[id]/edit/page.tsx` | `/admin/resources/ctas`: "Back to CTAs" | Done |
| `/admin/resources/ctas/new` | `app/(app)/admin/resources/ctas/new/page.tsx` | `/admin/resources/ctas`: "Back to CTAs" | Done |
| `/admin/resources/faqs` | `app/(app)/admin/resources/faqs/page.tsx` | `/admin/resources`: "Back to Resources" | Done |
| `/admin/resources/faqs/[id]/edit` | `app/(app)/admin/resources/faqs/[id]/edit/page.tsx` | `/admin/resources/faqs`: "Back to FAQs" | Done |
| `/admin/resources/faqs/new` | `app/(app)/admin/resources/faqs/new/page.tsx` | `/admin/resources/faqs`: "Back to FAQs" | Done |
| `/admin/resources/glossary` | `app/(app)/admin/resources/glossary/page.tsx` | `/admin/resources`: "Back to Resources" | Done |
| `/admin/resources/glossary/[id]/edit` | `app/(app)/admin/resources/glossary/[id]/edit/page.tsx` | `/admin/resources/glossary`: "Back to Glossary" | Done |
| `/admin/resources/glossary/[id]/preview` | `app/(app)/admin/resources/glossary/[id]/preview/page.tsx` | `/admin/resources/glossary/${id}/edit`: "Back to Editor" | Done |
| `/admin/resources/glossary/new` | `app/(app)/admin/resources/glossary/new/page.tsx` | `/admin/resources/glossary`: "Back to Glossary" | Done |
| `/admin/resources/money-updates` | `app/(app)/admin/resources/money-updates/page.tsx` | `/admin/resources`: "Back to Resources" | Done |
| `/admin/resources/money-updates/[id]/edit` | `app/(app)/admin/resources/money-updates/[id]/edit/page.tsx` | `/admin/resources/money-updates`: "Back to Money Updates" | Done |
| `/admin/resources/money-updates/[id]/preview` | `app/(app)/admin/resources/money-updates/[id]/preview/page.tsx` | `/admin/resources/money-updates/${id}/edit`: "Back to Editor" | Done |
| `/admin/resources/money-updates/new` | `app/(app)/admin/resources/money-updates/new/page.tsx` | `/admin/resources/money-updates`: "Back to Money Updates" | Done |
| `/admin/resources/related` | `app/(app)/admin/resources/related/page.tsx` | `/admin/resources`: "Back to Resources" | Done |
| `/admin/resources/users` | `app/(app)/admin/resources/users/page.tsx` | `/admin/resources`: "Back to Resources" | Done |
| `/admin/resources/videos` | `app/(app)/admin/resources/videos/page.tsx` | `/admin/resources`: "Back to Resources" | Done |
| `/admin/resources/videos/[id]/edit` | `app/(app)/admin/resources/videos/[id]/edit/page.tsx` | `/admin/resources/videos`: "Back to Videos" | Done |
| `/admin/resources/videos/[id]/preview` | `app/(app)/admin/resources/videos/[id]/preview/page.tsx` | `/admin/resources/videos/${id}/edit`: "Back to Editor" | Done |
| `/admin/resources/videos/new` | `app/(app)/admin/resources/videos/new/page.tsx` | `/admin/resources/videos`: "Back to Videos" | Done |
| `/ai-insights` | `app/(app)/ai-insights/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/aie-review` | `app/(app)/aie-review/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/aie-review/[runId]` | `app/(app)/aie-review/[runId]/page.tsx` | `/aie-review`: "Back to Document review" | Done |
| `/assets` | `app/(app)/assets/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/companies` | `app/(app)/companies/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/confirm-country` | `app/(onboarding)/confirm-country/page.tsx` | none | Exempt: Mandatory onboarding gate: the user must complete it, there is no page to return to. |
| `/contact` | `app/(marketing)/contact/page.tsx` | `/`: "Back to home" | Done |
| `/dashboard` | `app/(app)/dashboard/page.tsx` | none | Exempt: The signed-in home (top level): there is nothing above it. |
| `/disclaimer` | `app/(marketing)/disclaimer/page.tsx` | `/`: "Back to home" | Done |
| `/dna` | `app/(app)/dna/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/expenses` | `app/(app)/expenses/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/financial-data-hub` | `app/(app)/financial-data-hub/page.tsx` | `/expenses`: "Back to Expenses" | Done |
| `/financial-data-hub/activity` | `app/(app)/financial-data-hub/activity/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/financial-data-hub/activity/accounts` | `app/(app)/financial-data-hub/activity/accounts/page.tsx` | `/financial-data-hub/activity`: "Back to Financial Activity" | Done |
| `/financial-data-hub/activity/income` | `app/(app)/financial-data-hub/activity/income/page.tsx` | `/financial-data-hub/activity`: "Back to Financial Activity" | Done |
| `/financial-data-hub/activity/recurring` | `app/(app)/financial-data-hub/activity/recurring/page.tsx` | `/financial-data-hub/activity`: "Back to Financial Activity" | Done |
| `/financial-data-hub/activity/spending` | `app/(app)/financial-data-hub/activity/spending/page.tsx` | `/financial-data-hub/activity`: "Back to Financial Activity" | Done |
| `/financial-data-hub/activity/transactions` | `app/(app)/financial-data-hub/activity/transactions/page.tsx` | `/financial-data-hub/activity`: "Back to Financial Activity" | Done |
| `/financial-data-hub/review` | `app/(app)/financial-data-hub/review/page.tsx` | `/expenses` (default), `/financial-data-hub/activity` or `/financial-data-hub`, chosen by `?from=` | Done |
| `/financial-twin` | `app/(app)/financial-twin/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/financial-twin/[id]` | `app/(app)/financial-twin/[id]/page.tsx` | `/financial-twin/history`: "Back to Twin History" | Done |
| `/financial-twin/history` | `app/(app)/financial-twin/history/page.tsx` | `/financial-twin`: "Back to Twin / Benchmark" | Done |
| `/forecast` | `app/(app)/forecast/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/forecast/assumptions` | `app/(app)/forecast/assumptions/page.tsx` | `/forecast`: "Back to Forecasting" | Done |
| `/forecast/cross-border` | `app/(app)/forecast/cross-border/page.tsx` | `/forecast`: "Back to Forecasting" | Done |
| `/forecast/debt` | `app/(app)/forecast/debt/page.tsx` | `/forecast`: "Back to Forecasting" | Done |
| `/forecast/goals` | `app/(app)/forecast/goals/page.tsx` | `/forecast`: "Back to Forecasting" | Done |
| `/forecast/history` | `app/(app)/forecast/history/page.tsx` | `/forecast`: "Back to Forecasting" | Done |
| `/forecast/investments` | `app/(app)/forecast/investments/page.tsx` | `/forecast`: "Back to Forecasting" | Done |
| `/forecast/net-worth` | `app/(app)/forecast/net-worth/page.tsx` | `/forecast`: "Back to Forecasting" | Done |
| `/forecast/report` | `app/(app)/forecast/report/page.tsx` | `/forecast`: "Back to Forecasting" | Done |
| `/forecast/report/print` | `app/(print)/forecast/report/print/page.tsx` | none | Exempt: Print / PDF render target, never navigated to by a person. |
| `/forecast/resilience` | `app/(app)/forecast/resilience/page.tsx` | `/forecast`: "Back to Forecasting" | Done |
| `/forecast/retirement` | `app/(app)/forecast/retirement/page.tsx` | `/forecast`: "Back to Forecasting" | Done |
| `/forecast/scenarios` | `app/(app)/forecast/scenarios/page.tsx` | `/forecast`: "Back to Forecasting" | Done |
| `/forecast/variance` | `app/(app)/forecast/variance/page.tsx` | `/forecast`: "Back to Forecasting" | Done |
| `/forgot-password` | `app/(auth)/forgot-password/page.tsx` | none | Exempt: Authentication page (has its own "Back to log in"). |
| `/global-setup` | `app/(app)/global-setup/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/goals` | `app/(app)/goals/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/goals/[id]` | `app/(app)/goals/[id]/page.tsx` | `/goals`: "Back to Goals" | Done |
| `/goals/new` | `app/(app)/goals/new/page.tsx` | `/goals`: "Back to Goals" | Done |
| `/income` | `app/(app)/income/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/insurance` | `app/(app)/insurance/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/investment-intelligence` | `app/(app)/investment-intelligence/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/investment-intelligence/data` | `app/(app)/investment-intelligence/data/page.tsx` | `/investment-intelligence`: "Back to Investment Intelligence" | Done |
| `/investment-intelligence/performance` | `app/(app)/investment-intelligence/performance/page.tsx` | `/investment-intelligence`: "Back to Investment Intelligence" | Done |
| `/investment-intelligence/resolutions` | `app/(app)/investment-intelligence/resolutions/page.tsx` | `/investment-intelligence`: "Back to Investment Intelligence" | Done |
| `/investment-intelligence/resolutions/[itemId]` | `app/(app)/investment-intelligence/resolutions/[itemId]/page.tsx` | `/investment-intelligence/resolutions`: "Back to statement questions" | Done |
| `/investment-intelligence/review` | `app/(app)/investment-intelligence/review/page.tsx` | `/investment-intelligence`: "Back to Investment Intelligence" | Done |
| `/investment-intelligence/sip` | `app/(app)/investment-intelligence/sip/page.tsx` | `/investment-intelligence`: "Back to Investment Intelligence" | Done |
| `/investment-intelligence/tax` | `app/(app)/investment-intelligence/tax/page.tsx` | `/investment-intelligence`: "Back to Investment Intelligence" | Done |
| `/investment-intelligence/xray` | `app/(app)/investment-intelligence/xray/page.tsx` | `/investment-intelligence`: "Back to Investment Intelligence" | Done |
| `/investments` | `app/(app)/investments/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/liabilities` | `app/(app)/liabilities/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/login` | `app/(auth)/login/page.tsx` | none | Exempt: Authentication page. |
| `/onboarding` | `app/(onboarding)/onboarding/page.tsx` | none | Exempt: Mandatory onboarding gate / redirect. |
| `/privacy` | `app/(marketing)/privacy/page.tsx` | `/`: "Back to home" | Done |
| `/profile` | `app/(app)/profile/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/recommendations` | `app/(app)/recommendations/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/reports` | `app/(app)/reports/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/reports/[id]` | `app/(app)/reports/[id]/page.tsx` | `/reports`: "Back to Reports" | Done |
| `/reports/[id]/print` | `app/(print)/reports/[id]/print/page.tsx` | none | Exempt: Print / PDF render target, never navigated to by a person. |
| `/reset-password` | `app/(auth)/reset-password/page.tsx` | none | Exempt: Authentication page. |
| `/resilience` | `app/(app)/resilience/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/resources` | `app/(marketing)/resources/(browse)/page.tsx` | `/`: "Back to home" | Done |
| `/resources/[slug]` | `app/(marketing)/resources/[slug]/page.tsx` | `/resources`: "Back to Resources" | Done |
| `/resources/glossary` | `app/(marketing)/resources/(browse)/glossary/page.tsx` | `/resources`: "Back to Resources" | Done |
| `/resources/money-updates` | `app/(marketing)/resources/(browse)/money-updates/page.tsx` | `/resources`: "Back to Resources" | Done |
| `/resources/search` | `app/(marketing)/resources/(browse)/search/page.tsx` | `/resources`: "Back to Resources" | Done |
| `/resources/topic/[slug]` | `app/(marketing)/resources/topic/[slug]/page.tsx` | `/resources`: "Back to Resources" | Done |
| `/resources/videos` | `app/(marketing)/resources/(browse)/videos/page.tsx` | `/resources`: "Back to Resources" | Done |
| `/retirement` | `app/(app)/retirement/page.tsx` | `/investments`: "Back to Investments" | Done |
| `/score` | `app/(app)/score/page.tsx` | `/dashboard`: "Back to Dashboard" | Done |
| `/security` | `app/(marketing)/security/page.tsx` | `/`: "Back to home" | Done |
| `/signup` | `app/(auth)/signup/page.tsx` | none | Exempt: Authentication page. |
| `/terms` | `app/(marketing)/terms/page.tsx` | `/`: "Back to home" | Done |

## Notes

- There is no Admin home page: the Admin sidebar group opens straight onto a tool, so first-level Admin tools return to the Dashboard.
- The Resources editors (articles, Money Updates, videos, glossary, FAQs, CTAs) return to their list; after Save, Approve or View the control is still on screen (F2). Preview pages return to the editor of the same record.
- Public Resources pages return to the Resources hub, and the hub and the legal pages return to the home page.
