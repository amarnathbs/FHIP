// R1.6 CTA Library types — spec Part C. resource_ctas already exists
// (migration 0033) with exactly this shape; nothing added by migration 0040.

export type CtaDestinationType = 'internal_resource' | 'fhip_module' | 'registration' | 'external' | 'youtube';

export const CTA_DESTINATION_TYPES: CtaDestinationType[] = ['internal_resource', 'fhip_module', 'registration', 'external', 'youtube'];

export const CTA_DESTINATION_TYPE_LABELS: Record<CtaDestinationType, string> = {
  internal_resource: 'Another Resource',
  fhip_module: 'FHIP Module',
  registration: 'Sign up / Log in',
  external: 'External Link',
  youtube: 'YouTube',
};

export interface CtaRow {
  id: string;
  name: string;
  label: string;
  description: string | null;
  destination_type: CtaDestinationType;
  destination_url: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CtaSavePatch {
  name: string;
  label: string;
  description: string;
  destination_type: CtaDestinationType;
  destination_url: string;
  is_active: boolean;
}
