'use client';

// R1.3 metadata sidebar — spec §14-15/§48-61. Collapsible native
// <details>/<summary> sections (spec §15: "Use sections/tabs/accordions...
// Avoid a giant unstructured form"; keyboard-operable by default, no extra
// JS needed for §120's accessibility pass). Stacks under the main editor
// below the lg breakpoint via the parent grid (spec §90-92) rather than any
// section-specific responsive code.

import { SelectField, CheckboxField, TextField } from './FormField';
import { JURISDICTION_LABELS, JURISDICTION_VALUES } from '@/lib/resources/admin/labels';
import type { RelatedOption } from '@/lib/resources/editor/types';
import type { ResourceDifficulty, ResourceFreshness, ResourceVisibility, ComplianceClassification } from '@/lib/resources/types';

const DIFFICULTY_OPTIONS: { value: ResourceDifficulty; label: string }[] = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'beginner_intermediate', label: 'Beginner–Intermediate' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'intermediate_advanced', label: 'Intermediate–Advanced' },
  { value: 'advanced', label: 'Advanced' },
];

const VISIBILITY_OPTIONS: { value: ResourceVisibility; label: string }[] = [
  { value: 'private', label: 'Private (staff only)' },
  { value: 'unlisted', label: 'Unlisted (accessible by direct link once published)' },
  { value: 'public', label: 'Public' },
];

function Section({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details open={defaultOpen} className="group rounded-card border border-line bg-white">
      <summary className="cursor-pointer select-none list-none px-4 py-3 text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
        <span className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>
        {title}
      </summary>
      <div className="space-y-3 border-t border-line px-4 py-3">{children}</div>
    </details>
  );
}

function MultiSelect({ label, options, selected, onChange }: { label: string; options: RelatedOption[]; selected: string[]; onChange: (ids: string[]) => void }) {
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  }
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-ink">{label}</legend>
      {options.length === 0 ? (
        <p className="text-xs text-muted">None available yet.</p>
      ) : (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-compact border border-line p-2">
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} className="h-4 w-4 rounded border-line text-trust focus:ring-trust" />
              {o.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export interface MetadataFormState {
  primaryCategoryId: string;
  categoryIds: string[];
  tagIds: string[];
  jurisdiction: string;
  difficulty: string;
  freshnessType: string;
  visibility: string;
  isFeatured: boolean;
  complianceClassification: string;
  authorId: string;
  reviewerId: string;
  complianceReviewerId: string;
  seoTitle: string;
  seoDescription: string;
  canonicalUrl: string;
  isIndexable: boolean;
  primaryCtaId: string;
  secondaryCtaId: string;
  expiresAt: string;
  nextReviewAt: string;
}

export function MetadataSidebar({
  form,
  onChange,
  categories,
  tags,
  authors,
  ctas,
  errors,
  slugStatus,
}: {
  form: MetadataFormState;
  onChange: (patch: Partial<MetadataFormState>) => void;
  categories: RelatedOption[];
  tags: RelatedOption[];
  authors: RelatedOption[];
  ctas: RelatedOption[];
  errors: Record<string, string>;
  slugStatus?: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <Section title="Taxonomy">
        <SelectField
          label="Primary Category"
          value={form.primaryCategoryId}
          onChange={(v) => onChange({ primaryCategoryId: v })}
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
          allowBlank
          blankLabel="Select a category…"
          required
          error={errors.primary_category_id}
          hint="Required before this content can be submitted for editorial review."
        />
        <MultiSelect label="Additional Categories" options={categories.filter((c) => c.id !== form.primaryCategoryId)} selected={form.categoryIds} onChange={(ids) => onChange({ categoryIds: ids })} />
        <MultiSelect label="Tags" options={tags} selected={form.tagIds} onChange={(ids) => onChange({ tagIds: ids })} />
      </Section>

      <Section title="Classification">
        <SelectField
          label="Jurisdiction"
          value={form.jurisdiction}
          onChange={(v) => onChange({ jurisdiction: v })}
          options={JURISDICTION_VALUES.map((j) => ({ value: j, label: JURISDICTION_LABELS[j] }))}
          error={errors.jurisdiction}
          required
        />
        <SelectField label="Difficulty" value={form.difficulty} onChange={(v) => onChange({ difficulty: v })} options={DIFFICULTY_OPTIONS} allowBlank blankLabel="Not set" />
        <div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-ink">Freshness</legend>
            <div className="flex gap-4">
              {(['evergreen', 'time_sensitive'] as ResourceFreshness[]).map((f) => (
                <label key={f} className="flex items-center gap-2 text-sm text-ink">
                  <input type="radio" name="freshness" checked={form.freshnessType === f} onChange={() => onChange({ freshnessType: f })} className="h-4 w-4 text-trust focus:ring-trust" />
                  {f === 'evergreen' ? 'Evergreen' : 'Time-sensitive'}
                </label>
              ))}
            </div>
          </fieldset>
          {form.freshnessType === 'time_sensitive' && (
            <div className="mt-2 grid grid-cols-1 gap-3">
              <TextField label="Next Review Date" value={form.nextReviewAt} onChange={(v) => onChange({ nextReviewAt: v })} placeholder="YYYY-MM-DD" hint="When this content should next be checked for accuracy." />
              <TextField label="Expires At (optional)" value={form.expiresAt} onChange={(v) => onChange({ expiresAt: v })} placeholder="YYYY-MM-DD" />
            </div>
          )}
        </div>
        <SelectField label="Visibility" value={form.visibility} onChange={(v) => onChange({ visibility: v })} options={VISIBILITY_OPTIONS} />
        <CheckboxField label="Featured" checked={form.isFeatured} onChange={(v) => onChange({ isFeatured: v })} hint="Highlight this content on curated landing surfaces once published." />

        <div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-ink">Compliance Classification</legend>
            <div className="space-y-2">
              {(
                [
                  { value: 'green', label: 'GREEN — General Education', hint: 'Normal editorial review. No mandatory compliance review.' },
                  { value: 'amber', label: 'AMBER — Additional Review Required', hint: 'AMBER content requires compliance approval before it can be published.' },
                  { value: 'red', label: 'RED — Restricted', hint: 'RED content cannot be scheduled or published under the current Resources workflow.' },
                ] as { value: ComplianceClassification; label: string; hint: string }[]
              ).map((opt) => (
                <label key={opt.value} className="flex items-start gap-2 rounded-compact border border-line p-2 text-sm text-ink has-[:checked]:border-trust has-[:checked]:bg-trust/5">
                  <input
                    type="radio"
                    name="compliance"
                    className="mt-0.5 h-4 w-4 text-trust focus:ring-trust"
                    checked={form.complianceClassification === opt.value}
                    onChange={() => onChange({ complianceClassification: opt.value })}
                  />
                  <span>
                    <span className="block font-medium">{opt.label}</span>
                    <span className="block text-xs text-muted">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {errors.compliance_classification && (
              <p role="alert" className="mt-1 text-xs font-medium text-risk">
                {errors.compliance_classification}
              </p>
            )}
          </fieldset>
        </div>
      </Section>

      <Section title="Publishing / Review">
        <SelectField label="Author" value={form.authorId} onChange={(v) => onChange({ authorId: v })} options={authors.map((a) => ({ value: a.id, label: a.name }))} allowBlank blankLabel="Select an author…" required error={errors.author_id} />
        <SelectField label="Reviewer" value={form.reviewerId} onChange={(v) => onChange({ reviewerId: v })} options={authors.map((a) => ({ value: a.id, label: a.name }))} allowBlank blankLabel="None" />
        <SelectField
          label="Compliance Reviewer"
          value={form.complianceReviewerId}
          onChange={(v) => onChange({ complianceReviewerId: v })}
          options={authors.map((a) => ({ value: a.id, label: a.name }))}
          allowBlank
          blankLabel="None"
        />
        <SelectField label="Primary CTA" value={form.primaryCtaId} onChange={(v) => onChange({ primaryCtaId: v })} options={ctas.map((c) => ({ value: c.id, label: c.name }))} allowBlank blankLabel="None" />
        <SelectField label="Secondary CTA" value={form.secondaryCtaId} onChange={(v) => onChange({ secondaryCtaId: v })} options={ctas.map((c) => ({ value: c.id, label: c.name }))} allowBlank blankLabel="None" />
        <p className="text-xs text-muted">Disclaimer is centrally managed and will be applied by the public Resources renderer.</p>
      </Section>

      <Section title="SEO" defaultOpen={false}>
        <TextField label="SEO Title" value={form.seoTitle} onChange={(v) => onChange({ seoTitle: v })} maxLength={60} hint="Approximately 50–60 characters. Falls back to the content title if left blank." error={errors.seo_title} />
        <TextField
          label="Meta Description"
          value={form.seoDescription}
          onChange={(v) => onChange({ seoDescription: v })}
          maxLength={160}
          hint="Approximately 140–160 characters. Falls back to the excerpt if left blank."
          error={errors.seo_description}
        />
        <TextField label="Canonical URL (optional)" value={form.canonicalUrl} onChange={(v) => onChange({ canonicalUrl: v })} placeholder="https://…" />
        <CheckboxField label="Indexable" checked={form.isIndexable} onChange={(v) => onChange({ isIndexable: v })} hint="Off by default until this content is ready to be found by search engines." />
        {slugStatus}
      </Section>
    </div>
  );
}
