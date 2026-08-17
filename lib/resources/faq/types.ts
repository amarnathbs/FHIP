// R1.4 FAQ types — spec §32-39, §54. FAQs are NOT resource_posts (spec §32:
// "Do not automatically make every FAQ a resource_post") — they are their
// own reusable table (resource_faqs, R1.1 foundation + migration 0038
// governance/categorisation columns), linked to posts via resource_post_faqs.

export interface FaqRow {
  id: string;
  question: string;
  short_answer: string | null;
  answer_blocks: unknown[]; // "Expanded Answer" — structured blocks, R1.3 block model reused
  jurisdiction: string;
  is_active: boolean;
  category_id: string | null;
  compliance_classification: string;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface FaqListItem {
  id: string;
  question: string;
  jurisdiction: string;
  is_active: boolean;
  category: { id: string; name: string } | null;
  updated_at: string;
  linkedCount: number;
}

export interface FaqLinkedPost {
  post_id: string;
  title: string;
  content_type: string;
  status: string;
  sort_order: number;
}

export interface FaqSavePatch {
  question: string;
  short_answer: string;
  answer_blocks: unknown[];
  jurisdiction: string;
  is_active: boolean;
  category_id: string | null;
  compliance_classification: string;
}
