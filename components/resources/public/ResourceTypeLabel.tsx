// Spec §28: "Use human labels... never raw values such as fhip_explainer,
// money_update." Spec §101-103: never show internal compliance
// classification or workflow-status badges to public readers — this
// component deliberately renders content-type only (a reader-relevant
// fact), reusing the same CONTENT_TYPE_LABELS map the Admin shell already
// uses so the wording never drifts between the two surfaces.

import { CONTENT_TYPE_LABELS, JURISDICTION_LABELS } from '@/lib/resources/admin/labels';
import type { ResourceContentType, ResourceJurisdiction } from '@/lib/resources/types';

export function ResourceTypeLabel({ contentType, className }: { contentType: ResourceContentType; className?: string }) {
  return <span className={className ?? 'rounded-full bg-trust/10 px-2.5 py-0.5 text-xs font-semibold text-trust'}>{CONTENT_TYPE_LABELS[contentType]}</span>;
}

export function JurisdictionLabel({ jurisdiction, className }: { jurisdiction: ResourceJurisdiction; className?: string }) {
  return <span className={className ?? 'text-xs text-muted'}>{JURISDICTION_LABELS[jurisdiction]}</span>;
}
