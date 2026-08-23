// R1.7 — pure per-row planning: validates one Content_Master row and
// produces the mapped resource_posts field values plus the planning
// material to preserve non-invasively (spec §10-14, §59-64). Contains NO
// database or filesystem access — fully unit-testable in isolation.

import type { ContentMasterRow } from './workbook';
import {
  CONTENT_TYPE_MAP,
  JURISDICTION_MAP,
  DIFFICULTY_MAP,
  FRESHNESS_MAP,
  RISK_CLASS_MAP,
  mapOrNull,
  validateContentId,
  validateContentType,
  validateJurisdiction,
  validatePriority,
  validateDifficulty,
  validateRiskClass,
  validateFreshness,
  validateUrl,
  type ValidationIssue,
} from './mapping';

export interface PlannedRow {
  contentId: string;
  row: number;
  title: string;
  contentType: string | null; // mapped DB value
  jurisdiction: string | null;
  difficulty: string | null;
  freshnessType: string | null;
  complianceClassification: string | null;
  primaryCategoryLabel: string;
  subcategoryLabel: string;
  primaryCtaLabel: string;
  launchPriority: string;
  reviewCycleMonths: number | null;
  proposedUrl: string;
  urlValid: boolean;
  planningMaterial: Record<string, unknown>;
  issues: ValidationIssue[];
}

export function planRow(r: ContentMasterRow, seenIds: Set<string>): PlannedRow {
  const issues: ValidationIssue[] = [];
  issues.push(...validateContentId(r.Content_ID, r.__row, seenIds));
  issues.push(...validateContentType(r.Content_Type, r.Content_ID, r.__row));
  issues.push(...validateJurisdiction(r.Jurisdiction, r.Content_ID, r.__row));
  issues.push(...validatePriority(r.Launch_Priority, r.Content_ID, r.__row));
  issues.push(...validateDifficulty(r.Audience_Level, r.Content_ID, r.__row));
  issues.push(...validateRiskClass(r.Risk_Class, r.Content_ID, r.__row));
  issues.push(...validateFreshness(r.Freshness_Type, r.Content_ID, r.__row));

  const urlCheck = validateUrl(r.Proposed_URL, r.Content_ID, r.__row);
  issues.push(...urlCheck.issues);

  if (!r.Title || r.Title.trim() === '') {
    issues.push({ contentId: r.Content_ID, row: r.__row, field: 'Title', message: 'Title is blank', severity: 'error' });
  } else if (r.Title.length > 180) {
    issues.push({ contentId: r.Content_ID, row: r.__row, field: 'Title', message: `Title exceeds 180 characters (${r.Title.length})`, severity: 'error' });
  }

  return {
    contentId: r.Content_ID,
    row: r.__row,
    title: r.Title,
    contentType: mapOrNull(CONTENT_TYPE_MAP, r.Content_Type),
    jurisdiction: mapOrNull(JURISDICTION_MAP, r.Jurisdiction),
    difficulty: mapOrNull(DIFFICULTY_MAP, r.Audience_Level),
    freshnessType: mapOrNull(FRESHNESS_MAP, r.Freshness_Type),
    complianceClassification: mapOrNull(RISK_CLASS_MAP, r.Risk_Class),
    primaryCategoryLabel: r.Primary_Category,
    subcategoryLabel: r.Subcategory,
    primaryCtaLabel: r.Primary_CTA,
    launchPriority: r.Launch_Priority,
    reviewCycleMonths: r.Review_Cycle_Months,
    proposedUrl: r.Proposed_URL,
    urlValid: urlCheck.valid,
    planningMaterial: {
      user_question_search_intent: r.User_Question_Search_Intent || null,
      primary_keyword_theme: r.Primary_Keyword_Theme || null,
      editorial_brief: r.Editorial_Brief || null,
      key_points_to_cover: r.Key_Points_to_Cover || null,
      primary_fhip_module: r.Primary_FHIP_Module || null,
      secondary_fhip_module: r.Secondary_FHIP_Module || null,
      primary_cta_text: r.Primary_CTA || null,
      gktc_video_linkage: r.GKTC_Video_Linkage || null,
      youtube_channel: r.YouTube_Channel || null,
      review_cycle_months: r.Review_Cycle_Months,
      launch_priority: r.Launch_Priority,
      launch_wave: r.Launch_Wave || null,
      recommended_length: r.Recommended_Length || null,
      recommended_visual: r.Recommended_Visual || null,
      primary_source_hierarchy: r.Primary_Source_Hierarchy || null,
      seo_pillar: r.SEO_Pillar || null,
      related_content_cluster: r.Related_Content_Cluster || null,
      conversion_goal: r.Conversion_Goal || null,
      source_status: r.Status || null,
      owner: r.Owner || null,
      notes: r.Notes || null,
      subcategory: r.Subcategory || null,
    },
    issues,
  };
}
