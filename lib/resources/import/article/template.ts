// Article upload adapter -- template wording. Headers, required flags, enums and
// the example row all come from the canonical schema (schema.ts); only the
// plain-language introduction lives here.

export const ARTICLE_TEMPLATE_INTRO: string[] = [
  'FHIP Resources: Article upload template (version 1.0)',
  'Paste one finished article per row into the Article_Upload sheet, then upload the file under Resources > Bulk Upload > Articles.',
  'Every uploaded article becomes a PRIVATE DRAFT. Nothing is published, scheduled or approved by uploading. The normal Resources review and approval workflow still applies.',
  'Only the Article_Upload sheet is imported. The Instructions, Lookup_Values and Example_Article sheets are never processed.',
  'The finished body fields (quick answer, key takeaways, main content, example, what this means for your financial health) become the real article blocks you can edit in the normal Article editor.',
];

export const ARTICLE_TEMPLATE_NOTES: string[] = [
  'Main content uses restricted Markdown: ## for a main heading, ### for a sub-heading, paragraphs separated by a blank line, bullet lists (- item) and numbered lists (1. item). Raw HTML, tables, images, code blocks and nested lists are rejected with the row and column named.',
  'Key takeaways: put one takeaway on each line inside the cell.',
  'Category, tags, author and CTAs must already exist. They are matched by exact name or slug and are never created by an upload.',
  'Leave author blank if you do not know it: the draft can be saved, but an author is needed before it can be sent for review.',
  'Sources: fill in the source 1 columns (and source 2 if needed). Links must start with https://.',
];
