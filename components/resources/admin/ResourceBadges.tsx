// Reusable Resources Admin badges — spec §37-39. Every badge pairs a
// semantic colour with explicit text so status is never colour-only (spec
// §7 mirrors the app-wide UXD-007 finding: colour-only signalling is a
// known accessibility gap elsewhere in FHIP, deliberately not repeated here).

import { STATUS_LABELS, COMPLIANCE_LABELS, JURISDICTION_LABELS, CONTENT_TYPE_LABELS } from '@/lib/resources/admin/labels';
import type { ResourceStatus, ComplianceClassification, ResourceJurisdiction, ResourceContentType } from '@/lib/resources/types';

const STATUS_STYLES: Record<ResourceStatus, string> = {
  idea: 'bg-gray-100 text-gray-600',
  draft: 'bg-gray-100 text-gray-700',
  editorial_review: 'bg-attention/10 text-attention',
  compliance_review: 'bg-attention/10 text-attention',
  approved: 'bg-trust/10 text-trust',
  scheduled: 'bg-ai/10 text-ai',
  published: 'bg-positive/10 text-positive',
  review_due: 'bg-risk/10 text-risk',
  archived: 'bg-gray-100 text-gray-500',
};

export function ResourceStatusBadge({ status }: { status: ResourceStatus | string }) {
  const s = status as ResourceStatus;
  const style = STATUS_STYLES[s] ?? 'bg-gray-100 text-gray-600';
  const label = STATUS_LABELS[s] ?? status;
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}>{label}</span>;
}

const COMPLIANCE_STYLES: Record<ComplianceClassification, string> = {
  green: 'bg-positive/10 text-positive',
  amber: 'bg-attention/10 text-attention',
  red: 'bg-risk/10 text-risk',
};

export function ResourceComplianceBadge({ compliance }: { compliance: ComplianceClassification | string }) {
  const c = compliance as ComplianceClassification;
  const style = COMPLIANCE_STYLES[c] ?? 'bg-gray-100 text-gray-600';
  const label = COMPLIANCE_LABELS[c] ?? compliance;
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${style}`} title={`Compliance classification: ${label}`}>
      {label}
    </span>
  );
}

export function ResourceJurisdictionBadge({ jurisdiction }: { jurisdiction: ResourceJurisdiction | string }) {
  const j = jurisdiction as ResourceJurisdiction;
  const label = JURISDICTION_LABELS[j] ?? jurisdiction;
  return <span className="inline-block whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">{label}</span>;
}

export function ResourceTypeBadge({ contentType }: { contentType: ResourceContentType | string }) {
  const t = contentType as ResourceContentType;
  const label = CONTENT_TYPE_LABELS[t] ?? contentType;
  return <span className="inline-block whitespace-nowrap rounded-full bg-nav/5 px-2 py-0.5 text-xs font-medium text-nav">{label}</span>;
}
