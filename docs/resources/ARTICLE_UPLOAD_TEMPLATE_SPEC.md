# Article upload template specification (v1.0)

Generated from the canonical schema (`lib/resources/import/article/schema.ts`) by `scripts/generate_resources_upload_template_docs.ts`. Do not edit by hand: change the schema and regenerate. A unit test fails if a column in the schema is missing from this document.

- Template version: **1.0** (any other value is rejected with `TEMPLATE_VERSION_UNSUPPORTED`).
- Files: `FHIP_Article_Upload_Template_v1.xlsx` and `FHIP_Article_Upload_Template_v1.csv`. Only `.xlsx` and `.csv` are accepted.
- XLSX template sheets: `Instructions`, `Article_Upload` (where your rows go), `Lookup_Values`, `Example_Article` (an example). **You choose the sheet to import when you upload** (the shared ingest convention: the system never picks a sheet silently), and the upload screen preselects `Article_Upload`. Only the chosen sheet is read; the preview lists the sheets that were not imported and any hidden rows that were skipped. The preselected name is one constant per type (`uploadSheetName` in the adapter schema); a workbook with any other sheet names works because you choose the sheet.
- Header row is row 1. CSV files: the delimiter is detected the same way as the other uploads (comma, semicolon, tab or pipe, never guessed when ambiguous); the CSV template is the header row only.
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
| `freshness_type` | Optional | enum | evergreen, time_sensitive |  | evergreen (default when blank) or time_sensitive. A time_sensitive article needs a next review date or an expiry date. |
| `next_review_at` | Optional | date |  |  | When this content should next be reviewed. File format: year-month-day with hyphens, for example 2027-03-31. |
| `expires_at` | Optional | date |  |  | When this content stops being valid. File format: year-month-day with hyphens. |
| `excerpt` | Required | long_text |  | 300 | A short summary shown in listings. Required, up to 300 characters. |
| `quick_answer` | Optional | long_text |  | 2000 | The 30-second answer shown in a highlighted box at the top. Optional; when blank no box is created. |
| `key_takeaways` | Optional | line_list |  | 20000 | One takeaway per line (a new line inside the cell). Becomes the Key Takeaways list. Optional. |
| `main_content` | Required | long_text |  | 20000 | The article body in restricted Markdown: ## for a main heading, ### for a sub-heading, plain paragraphs separated by a blank line, bullet lists (lines starting with - ) and numbered lists (1. 2. 3.). Bold (**text**), italic (_text_) and secure links ([text](https://...)) are allowed. Raw HTML, tables, images, code and nested lists are rejected. |
| `example` | Optional | long_text |  | 4000 | A worked example, shown in the Example block. Optional. |
| `financial_health_meaning` | Optional | long_text |  | 20000 | Becomes the section titled "What this means for your financial health". Plain paragraphs. Optional. |
| `primary_category` | Optional | reference |  |  | The exact name or slug of an existing category (see Lookup_Values). Categories are never created by an upload. Needed before the item can go to review. |
| `tags` | Optional | pipe_list |  |  | Existing tag names or slugs separated by a pipe character (/). Tags are never created by an upload. |
| `author` | Optional | reference |  |  | The author slug or the exact display name of an existing author. Authors are never created by an upload. An item without an author can be saved as a draft but cannot go to review until an author is set. |
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

- Main content uses restricted Markdown: ## for a main heading, ### for a sub-heading, paragraphs separated by a blank line, bullet lists (- item) and numbered lists (1. item). Raw HTML, tables, images, code blocks and nested lists are rejected with the row and column named.
- Key takeaways: put one takeaway on each line inside the cell.
- Category, tags, author and CTAs must already exist. They are matched by exact name or slug and are never created by an upload.
- Leave author blank if you do not know it: the draft can be saved, but an author is needed before it can be sent for review.
- Sources: fill in the source 1 columns (and source 2 if needed). Links must start with https://.

## How the finished body becomes the real article

| Column | Becomes |
|---|---|
| `quick_answer` | one `callout` block (the 30-second answer), omitted when blank |
| `key_takeaways` | one `key_takeaways` block, one item per line, omitted when blank |
| `main_content` | `heading` (H2 / H3), `paragraph`, `bulleted_list`, `numbered_list` blocks from restricted Markdown |
| `example` | one `example` block, omitted when blank |
| `financial_health_meaning` | an H2 "What this means for your financial health" followed by its paragraphs, omitted when blank |

Anything outside the restricted Markdown subset (raw HTML, H1, H4 and deeper, tables, block quotes, code, images, horizontal rules, nested lists, links that are not https) is rejected with `UNSUPPORTED_ARTICLE_MARKUP` naming the row and column. Nothing is dropped silently.

## Resolution of references (existing records only, never created)

- `primary_category`: exact category name or slug (`UNKNOWN_PRIMARY_CATEGORY`).
- `tags`: exact tag names or slugs separated by `|` (`UNKNOWN_TAG`).
- `author`: author id, author slug, or an exact **unique** display name (`UNKNOWN_AUTHOR`, `AMBIGUOUS_AUTHOR`). A blank author is accepted as a draft; the existing review gate still demands one before review.
- `primary_cta`, `secondary_cta`: exact name of an existing active CTA (`UNKNOWN_CTA`).
- Sources are reused only on an exact match of name, link and document title; otherwise they are created inside the same transaction.

