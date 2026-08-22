// Human-readable label maps for Resources enum columns — spec §40: "Do not
// expose raw enum naming." Every raw DB value shown anywhere in the Admin
// shell should be looked up here rather than title-cased ad hoc, so a value
// like 'fhip_explainer' always reads as "FHIP Explainer", not "Fhip
// Explainer".

import type { ResourceContentType, ResourceStatus, ComplianceClassification, ResourceJurisdiction } from '@/lib/resources/types';

export const CONTENT_TYPE_LABELS: Record<ResourceContentType, string> = {
  article: 'Article',
  guide: 'Guide',
  fhip_explainer: 'FHIP Explainer',
  video: 'Video',
  glossary: 'Glossary',
  money_update: 'Money Update',
  money_update_template: 'Money Update Template',
};

export const STATUS_LABELS: Record<ResourceStatus, string> = {
  idea: 'Idea',
  draft: 'Draft',
  editorial_review: 'Editorial Review',
  compliance_review: 'Compliance Review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  published: 'Published',
  review_due: 'Review Due',
  archived: 'Archived',
};

// Compact table wording per spec §38 — the "Green — Education" / "Amber —
// Review Required" / "Red — Restricted" longer form is reserved for
// contexts with more room (e.g. the detail page), not table cells.
export const COMPLIANCE_LABELS: Record<ComplianceClassification, string> = {
  green: 'GREEN',
  amber: 'AMBER',
  red: 'RED',
};

export const COMPLIANCE_LABELS_LONG: Record<ComplianceClassification, string> = {
  green: 'Green — Education',
  amber: 'Amber — Review Required',
  red: 'Red — Restricted',
};

export const JURISDICTION_LABELS: Record<ResourceJurisdiction, string> = {
  global: 'Global',
  australia: 'Australia',
  india: 'India',
  australia_india_cross_border: 'Australia–India',
};

export const CONTENT_TYPE_VALUES: ResourceContentType[] = ['article', 'guide', 'fhip_explainer', 'video', 'glossary', 'money_update', 'money_update_template'];
export const STATUS_VALUES: ResourceStatus[] = ['idea', 'draft', 'editorial_review', 'compliance_review', 'approved', 'scheduled', 'published', 'review_due', 'archived'];
export const COMPLIANCE_VALUES: ComplianceClassification[] = ['green', 'amber', 'red'];
export const JURISDICTION_VALUES: ResourceJurisdiction[] = ['global', 'australia', 'india', 'australia_india_cross_border'];

export function formatAdminDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatAdminDateTime(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}`;
}
