# Money Update upload template specification (v1.0)

Generated from the canonical schema (`lib/resources/import/money-update/schema.ts`) by `scripts/generate_resources_upload_template_docs.ts`. Do not edit by hand: change the schema and regenerate. A unit test fails if a column in the schema is missing from this document.

- Template version: **1.0** (any other value is rejected with `TEMPLATE_VERSION_UNSUPPORTED`).
- Files: `FHIP_Money_Update_Upload_Template_v1.xlsx` and `FHIP_Money_Update_Upload_Template_v1.csv`. Only `.xlsx` and `.csv` are accepted.
- XLSX sheets: `Instructions`, `Money_Update_Upload` (the **only** sheet that is imported), `Lookup_Values`, `Example_Money_Update` (an example, never processed).
- Dates inside the upload file are written year-month-day with hyphens (this is the file format only; the app shows dates day first).
- Every row becomes a **private draft**. The file cannot set status, visibility, approvals, scheduling, publication, the content type or whether the item is indexable. A column with such a name rejects the whole file.

## Columns

| Column | Required | Kind | Allowed values | Max length | Notes |
|---|---|---|---|---|---|
| `template_version` | Required | meta |  | 10 | Leave as 1.0. Files made from a different template version are rejected. |
| `external_id` | Optional | text |  | 100 | Your own stable identifier for this row (for example from a content plan). Stored as the Resource content ID. Uploading an ID that already exists is rejected, so the same item can never be created twice. |
| `title` | Required | text |  | 180 | The headline. Up to 180 characters. |
| `slug` | Optional | text |  | 200 | The web address ending: lowercase letters, numbers and single hyphens. Leave blank to generate one from the title. A slug that already exists is rejected; nothing is ever overwritten. |
| `jurisdiction` | Required | enum | global, australia, india, australia_india_cross_border |  | Which country the content applies to. Pick one of the allowed values (see Lookup_Values). |
| `difficulty` | Optional | enum | beginner, beginner_intermediate, intermediate, intermediate_advanced, advanced |  | How advanced the reader needs to be. Optional. |
| `compliance_classification` | Required | enum | green, amber, red |  | green, amber or red. AMBER content needs compliance review before publication; RED content cannot be published under the current workflow. This sets the classification only; nothing is approved by uploading. |
| `event_date` | Required | date |  |  | The real-world date the development happened. Required, and not in the future. File format: year-month-day with hyphens, for example 2026-09-30. |
| `next_review_at` | Optional | date |  |  | When this content should next be reviewed. File format: year-month-day with hyphens, for example 2027-03-31. A Money Update needs a next review date or an expiry date (at least one of the two). |
| `expires_at` | Optional | date |  |  | When this content stops being valid. File format: year-month-day with hyphens. A Money Update needs a next review date or an expiry date (at least one of the two). |
| `affected_audience` | Optional | text |  | 300 | A short phrase naming who is affected, for example first-home buyers. Up to 300 characters. |
| `excerpt` | Required | long_text |  | 300 | A short summary shown in listings. Required, up to 300 characters. |
| `what_happened` | Required | long_text |  | 10000 | The development in one or two plain-English paragraphs. Plain paragraphs, bullet lists (lines starting with - ) and numbered lists are allowed; raw HTML is rejected. |
| `why_it_matters` | Required | long_text |  | 10000 | Why a reader should care. Plain paragraphs, bullet lists (lines starting with - ) and numbered lists are allowed; raw HTML is rejected. |
| `who_may_be_affected` | Required | long_text |  | 10000 | The groups affected. Plain paragraphs, bullet lists (lines starting with - ) and numbered lists are allowed; raw HTML is rejected. |
| `financial_health_impact` | Required | long_text |  | 10000 | How the development connects to the reader’s financial health. Plain paragraphs, bullet lists (lines starting with - ) and numbered lists are allowed; raw HTML is rejected. |
| `how_fhip_can_help` | Required | long_text |  | 10000 | How FHIP can help the reader monitor this. Plain paragraphs, bullet lists (lines starting with - ) and numbered lists are allowed; raw HTML is rejected. |
| `primary_category` | Optional | reference |  |  | The exact name or slug of an existing category (see Lookup_Values). Categories are never created by an upload. Needed before the item can go to review. |
| `tags` | Optional | pipe_list |  |  | Existing tag names or slugs separated by a pipe character (/). Tags are never created by an upload. |
| `primary_cta` | Optional | reference |  |  | The exact name of an existing, active call to action. CTAs are never created by an upload. |
| `secondary_cta` | Optional | reference |  |  | The exact name of an existing, active call to action. Must differ from the primary CTA. |
| `seo_title` | Optional | text |  | 300 | Optional. Left blank, the normal Resources fallback (the title) applies. |
| `seo_description` | Optional | text |  | 400 | Optional. Left blank, the normal Resources fallback (the excerpt) applies. |
| `is_indexable` | Optional | boolean |  |  | Ignored. Imported drafts are never indexable; the value here cannot override that. Leave as FALSE. |
| `source_1_name` | Optional | text |  | 200 | The authority or publisher of source 1. Fill in at least the name for every source you cite. If any other source 1 column is filled in, the name is required. |
| `source_1_document_title` | Optional | text |  | 300 | The title of the specific document or page. Optional. |
| `source_1_url` | Optional | url |  |  | A secure link starting with https://. Links that start with http://, javascript:, data:, file: or ftp: are rejected. |
| `source_1_type` | Optional | text |  | 100 | A short label for the kind of source (see Lookup_Values for the usual ones). Free text, up to 100 characters. |
| `source_1_publication_date` | Optional | date |  |  | When the source was published. Optional. File format: year-month-day with hyphens. |
| `source_1_is_public` | Optional | boolean |  |  | TRUE or FALSE. Blank means TRUE. |
| `source_2_name` | Optional | text |  | 200 | The authority or publisher of source 2. If any other source 2 column is filled in, the name is required. |
| `source_2_document_title` | Optional | text |  | 300 | The title of the specific document or page. Optional. |
| `source_2_url` | Optional | url |  |  | A secure link starting with https://. Links that start with http://, javascript:, data:, file: or ftp: are rejected. |
| `source_2_type` | Optional | text |  | 100 | A short label for the kind of source (see Lookup_Values for the usual ones). Free text, up to 100 characters. |
| `source_2_publication_date` | Optional | date |  |  | When the source was published. Optional. File format: year-month-day with hyphens. |
| `source_2_is_public` | Optional | boolean |  |  | TRUE or FALSE. Blank means TRUE. |

## Rules

- Event date is required and cannot be in the future. At least one of next review date or expiry date is required.
- At least one source is required. Links must start with https://.
- Category, tags and CTAs must already exist. They are matched by exact name or slug and are never created by an upload.
- Each section may use paragraphs, bullet lists (- item), numbered lists (1. item) and ### sub-headings. Raw HTML is rejected.

## How the five finished sections become the real Money Update

Each non-blank section becomes the same H2 heading the manual Money Update starter uses, followed by the section content (paragraphs, lists, H3):

| Column | Heading |
|---|---|
| `what_happened` | What Happened? |
| `why_it_matters` | Why Does It Matter? |
| `who_may_be_affected` | Who May Be Affected? |
| `financial_health_impact` | What Does This Mean for Your Financial Health? |
| `how_fhip_can_help` | How FHIP Can Help You Monitor It |

Forced on apply regardless of the file: `content_type=money_update`, `status=draft`, `visibility=private`, `freshness_type=time_sensitive`, `is_indexable=false`.

