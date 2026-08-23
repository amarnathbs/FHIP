# Resources (+ Phase 0C section status) — Expected Schema Manifest

> Generated from the certified clean rebuild of the active migration chain
> (`supabase/migrations/0001`-`0049`) into an empty PostgreSQL 18 database.
> This is the **intended** schema, reconstructed from migration definitions —
> not a dump of DEV, which is only ever used as the comparator.

Resources CMS (categories, posts, taxonomy, media, CTAs, FAQs, sources, versions, workflow, audit, settings, discovery/context) plus the Phase 0C per-user section-status table. Re-emitted by forward reconciliation migration 0049.

## Summary

| Object type | Count |
|---|---|
| Tables | 21 |
| Columns | 205 |
| Constraints | 234 |
| Indexes | 71 |
| RLS policies | 48 |
| Tables with RLS enabled | 21 / 21 |

## Tables

| Table | Columns | RLS | Policies | Indexes | Constraints |
|---|---|---|---|---|---|
| `resource_audit_log` | 9 | ENABLED | 1 | 3 | 7 |
| `resource_authors` | 11 | ENABLED | 2 | 4 | 10 |
| `resource_categories` | 9 | ENABLED | 2 | 5 | 11 |
| `resource_context_links` | 10 | ENABLED | 3 | 4 | 12 |
| `resource_ctas` | 9 | ENABLED | 2 | 2 | 10 |
| `resource_faqs` | 12 | ENABLED | 2 | 3 | 15 |
| `resource_media` | 14 | ENABLED | 4 | 3 | 13 |
| `resource_post_categories` | 4 | ENABLED | 2 | 2 | 8 |
| `resource_post_faqs` | 3 | ENABLED | 2 | 2 | 7 |
| `resource_post_sources` | 4 | ENABLED | 2 | 2 | 7 |
| `resource_post_tags` | 2 | ENABLED | 2 | 2 | 5 |
| `resource_post_versions` | 7 | ENABLED | 2 | 3 | 10 |
| `resource_posts` | 44 | ENABLED | 5 | 17 | 42 |
| `resource_related_content` | 6 | ENABLED | 2 | 3 | 13 |
| `resource_settings` | 5 | ENABLED | 3 | 1 | 5 |
| `resource_sources` | 12 | ENABLED | 5 | 1 | 8 |
| `resource_tags` | 7 | ENABLED | 2 | 4 | 8 |
| `resource_user_roles` | 8 | ENABLED | 1 | 4 | 11 |
| `resource_videos` | 14 | ENABLED | 2 | 3 | 15 |
| `resource_workflow_history` | 11 | ENABLED | 1 | 2 | 9 |
| `user_financial_section_status` | 4 | ENABLED | 1 | 1 | 8 |

## Columns, constraints, indexes and policies (per table)

### `resource_audit_log`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `entity_type` | text | NO | — |
| `entity_id` | uuid | YES | — |
| `action` | text | NO | — |
| `actor_user_id` | uuid | YES | — |
| `before_state` | jsonb | YES | — |
| `after_state` | jsonb | YES | — |
| `metadata` | jsonb | NO | `'{}'::jsonb` |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_audit_log_action_not_null` | n | `NOT NULL action` |
| `resource_audit_log_actor_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL` |
| `resource_audit_log_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_audit_log_entity_type_not_null` | n | `NOT NULL entity_type` |
| `resource_audit_log_id_not_null` | n | `NOT NULL id` |
| `resource_audit_log_metadata_not_null` | n | `NOT NULL metadata` |
| `resource_audit_log_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_audit_log_actor` | `CREATE INDEX idx_resource_audit_log_actor ON public.resource_audit_log USING btree (actor_user_id, created_at)` |
| `idx_resource_audit_log_entity` | `CREATE INDEX idx_resource_audit_log_entity ON public.resource_audit_log USING btree (entity_type, entity_id)` |
| `resource_audit_log_pkey` | `CREATE UNIQUE INDEX resource_audit_log_pkey ON public.resource_audit_log USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `managers read audit log` | SELECT | {public} | `private.can_manage_resources(auth.uid())` | `-` |

### `resource_authors`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | YES | — |
| `display_name` | text | NO | — |
| `slug` | text | NO | — |
| `role_title` | text | YES | — |
| `bio` | text | YES | — |
| `expertise` | ARRAY | YES | — |
| `profile_image_id` | uuid | YES | — |
| `is_active` | boolean | NO | `true` |
| `created_at` | timestamp with time zone | NO | `now()` |
| `updated_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `fk_resource_authors_profile_image` | FOREIGN KEY | `FOREIGN KEY (profile_image_id) REFERENCES resource_media(id) ON DELETE SET NULL` |
| `resource_authors_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_authors_display_name_not_null` | n | `NOT NULL display_name` |
| `resource_authors_id_not_null` | n | `NOT NULL id` |
| `resource_authors_is_active_not_null` | n | `NOT NULL is_active` |
| `resource_authors_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_authors_slug_key` | UNIQUE | `UNIQUE (slug)` |
| `resource_authors_slug_not_null` | n | `NOT NULL slug` |
| `resource_authors_updated_at_not_null` | n | `NOT NULL updated_at` |
| `resource_authors_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_authors_slug` | `CREATE INDEX idx_resource_authors_slug ON public.resource_authors USING btree (slug)` |
| `idx_resource_authors_user` | `CREATE INDEX idx_resource_authors_user ON public.resource_authors USING btree (user_id)` |
| `resource_authors_pkey` | `CREATE UNIQUE INDEX resource_authors_pkey ON public.resource_authors USING btree (id)` |
| `resource_authors_slug_key` | `CREATE UNIQUE INDEX resource_authors_slug_key ON public.resource_authors USING btree (slug)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `public read active authors` | SELECT | {public} | `is_active` | `-` |
| `staff manage authors` | ALL | {public} | `private.can_manage_resources(auth.uid())` | `private.can_manage_resources(auth.uid())` |

### `resource_categories`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `name` | text | NO | — |
| `slug` | text | NO | — |
| `description` | text | YES | — |
| `parent_id` | uuid | YES | — |
| `sort_order` | integer | NO | `0` |
| `is_active` | boolean | NO | `true` |
| `created_at` | timestamp with time zone | NO | `now()` |
| `updated_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_categories_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_categories_id_not_null` | n | `NOT NULL id` |
| `resource_categories_is_active_not_null` | n | `NOT NULL is_active` |
| `resource_categories_name_not_null` | n | `NOT NULL name` |
| `resource_categories_parent_id_fkey` | FOREIGN KEY | `FOREIGN KEY (parent_id) REFERENCES resource_categories(id) ON DELETE SET NULL` |
| `resource_categories_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_categories_slug_key` | UNIQUE | `UNIQUE (slug)` |
| `resource_categories_slug_not_null` | n | `NOT NULL slug` |
| `resource_categories_sort_order_check` | CHECK | `CHECK ((sort_order >= 0))` |
| `resource_categories_sort_order_not_null` | n | `NOT NULL sort_order` |
| `resource_categories_updated_at_not_null` | n | `NOT NULL updated_at` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_categories_active` | `CREATE INDEX idx_resource_categories_active ON public.resource_categories USING btree (is_active)` |
| `idx_resource_categories_parent` | `CREATE INDEX idx_resource_categories_parent ON public.resource_categories USING btree (parent_id)` |
| `idx_resource_categories_slug` | `CREATE INDEX idx_resource_categories_slug ON public.resource_categories USING btree (slug)` |
| `resource_categories_pkey` | `CREATE UNIQUE INDEX resource_categories_pkey ON public.resource_categories USING btree (id)` |
| `resource_categories_slug_key` | `CREATE UNIQUE INDEX resource_categories_slug_key ON public.resource_categories USING btree (slug)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `public read active categories` | SELECT | {public} | `is_active` | `-` |
| `staff manage categories` | ALL | {public} | `private.can_manage_resources(auth.uid())` | `private.can_manage_resources(auth.uid())` |

### `resource_context_links`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `context_key` | text | NO | — |
| `module` | text | NO | — |
| `metric_or_feature` | text | YES | — |
| `label` | text | NO | — |
| `resource_post_id` | uuid | NO | — |
| `sort_order` | integer | NO | `0` |
| `is_active` | boolean | NO | `true` |
| `created_at` | timestamp with time zone | NO | `now()` |
| `updated_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_context_links_context_key_not_null` | n | `NOT NULL context_key` |
| `resource_context_links_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_context_links_id_not_null` | n | `NOT NULL id` |
| `resource_context_links_is_active_not_null` | n | `NOT NULL is_active` |
| `resource_context_links_label_not_null` | n | `NOT NULL label` |
| `resource_context_links_module_not_null` | n | `NOT NULL module` |
| `resource_context_links_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_context_links_resource_post_id_fkey` | FOREIGN KEY | `FOREIGN KEY (resource_post_id) REFERENCES resource_posts(id) ON DELETE CASCADE` |
| `resource_context_links_resource_post_id_not_null` | n | `NOT NULL resource_post_id` |
| `resource_context_links_sort_order_check` | CHECK | `CHECK ((sort_order >= 0))` |
| `resource_context_links_sort_order_not_null` | n | `NOT NULL sort_order` |
| `resource_context_links_updated_at_not_null` | n | `NOT NULL updated_at` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_context_links_context_key` | `CREATE INDEX idx_resource_context_links_context_key ON public.resource_context_links USING btree (context_key)` |
| `idx_resource_context_links_module` | `CREATE INDEX idx_resource_context_links_module ON public.resource_context_links USING btree (module)` |
| `idx_resource_context_links_post` | `CREATE INDEX idx_resource_context_links_post ON public.resource_context_links USING btree (resource_post_id)` |
| `resource_context_links_pkey` | `CREATE UNIQUE INDEX resource_context_links_pkey ON public.resource_context_links USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `public read active context links to public posts` | SELECT | {public} | `(is_active AND (EXISTS ( SELECT 1
   FROM resource_posts p
  WHERE ((p.id = resource_context_links.resource_post_id) AND (p.status = ANY (ARRAY['published'::text, 'review_due'::text])) AND (p.visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND (p.published_at IS NOT NULL) AND (p.published_at <= now()) AND (p.content_type <> 'money_update_template'::text)))))` | `-` |
| `staff manage context links` | ALL | {public} | `private.can_manage_resources(auth.uid())` | `private.can_manage_resources(auth.uid())` |
| `staff read context links` | SELECT | {public} | `private.is_resource_staff(auth.uid())` | `-` |

### `resource_ctas`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `name` | text | NO | — |
| `label` | text | NO | — |
| `description` | text | YES | — |
| `destination_type` | text | NO | — |
| `destination_url` | text | NO | — |
| `is_active` | boolean | NO | `true` |
| `created_at` | timestamp with time zone | NO | `now()` |
| `updated_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_ctas_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_ctas_destination_type_check` | CHECK | `CHECK ((destination_type = ANY (ARRAY['internal_resource'::text, 'fhip_module'::text, 'registration'::text, 'external'::text, 'youtube'::text])))` |
| `resource_ctas_destination_type_not_null` | n | `NOT NULL destination_type` |
| `resource_ctas_destination_url_not_null` | n | `NOT NULL destination_url` |
| `resource_ctas_id_not_null` | n | `NOT NULL id` |
| `resource_ctas_is_active_not_null` | n | `NOT NULL is_active` |
| `resource_ctas_label_not_null` | n | `NOT NULL label` |
| `resource_ctas_name_not_null` | n | `NOT NULL name` |
| `resource_ctas_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_ctas_updated_at_not_null` | n | `NOT NULL updated_at` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_ctas_active` | `CREATE INDEX idx_resource_ctas_active ON public.resource_ctas USING btree (is_active)` |
| `resource_ctas_pkey` | `CREATE UNIQUE INDEX resource_ctas_pkey ON public.resource_ctas USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `public read active ctas` | SELECT | {public} | `is_active` | `-` |
| `staff manage ctas` | ALL | {public} | `private.can_manage_resources(auth.uid())` | `private.can_manage_resources(auth.uid())` |

### `resource_faqs`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `question` | text | NO | — |
| `answer_blocks` | jsonb | NO | `'[]'::jsonb` |
| `jurisdiction` | text | NO | `'global'::text` |
| `is_active` | boolean | NO | `true` |
| `created_by` | uuid | YES | — |
| `created_at` | timestamp with time zone | NO | `now()` |
| `updated_at` | timestamp with time zone | NO | `now()` |
| `short_answer` | text | YES | — |
| `category_id` | uuid | YES | — |
| `compliance_classification` | text | NO | `'green'::text` |
| `updated_by` | uuid | YES | — |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `chk_resource_faqs_answer_blocks_is_array` | CHECK | `CHECK ((jsonb_typeof(answer_blocks) = 'array'::text))` |
| `resource_faqs_answer_blocks_not_null` | n | `NOT NULL answer_blocks` |
| `resource_faqs_category_id_fkey` | FOREIGN KEY | `FOREIGN KEY (category_id) REFERENCES resource_categories(id) ON DELETE SET NULL` |
| `resource_faqs_compliance_classification_check` | CHECK | `CHECK ((compliance_classification = ANY (ARRAY['green'::text, 'amber'::text, 'red'::text])))` |
| `resource_faqs_compliance_classification_not_null` | n | `NOT NULL compliance_classification` |
| `resource_faqs_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_faqs_created_by_fkey` | FOREIGN KEY | `FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL` |
| `resource_faqs_id_not_null` | n | `NOT NULL id` |
| `resource_faqs_is_active_not_null` | n | `NOT NULL is_active` |
| `resource_faqs_jurisdiction_check` | CHECK | `CHECK ((jurisdiction = ANY (ARRAY['global'::text, 'australia'::text, 'india'::text, 'australia_india_cross_border'::text])))` |
| `resource_faqs_jurisdiction_not_null` | n | `NOT NULL jurisdiction` |
| `resource_faqs_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_faqs_question_not_null` | n | `NOT NULL question` |
| `resource_faqs_updated_at_not_null` | n | `NOT NULL updated_at` |
| `resource_faqs_updated_by_fkey` | FOREIGN KEY | `FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_faqs_category` | `CREATE INDEX idx_resource_faqs_category ON public.resource_faqs USING btree (category_id)` |
| `idx_resource_faqs_compliance` | `CREATE INDEX idx_resource_faqs_compliance ON public.resource_faqs USING btree (compliance_classification)` |
| `resource_faqs_pkey` | `CREATE UNIQUE INDEX resource_faqs_pkey ON public.resource_faqs USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `public read active faqs` | SELECT | {public} | `is_active` | `-` |
| `staff manage faqs` | ALL | {public} | `private.is_resource_staff(auth.uid())` | `private.is_resource_staff(auth.uid())` |

### `resource_media`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `storage_bucket` | text | NO | — |
| `storage_path` | text | NO | — |
| `public_url` | text | YES | — |
| `file_name` | text | NO | — |
| `mime_type` | text | NO | — |
| `file_size_bytes` | bigint | YES | — |
| `width` | integer | YES | — |
| `height` | integer | YES | — |
| `alt_text` | text | YES | — |
| `caption` | text | YES | — |
| `uploaded_by` | uuid | YES | — |
| `created_at` | timestamp with time zone | NO | `now()` |
| `updated_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_media_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_media_file_name_not_null` | n | `NOT NULL file_name` |
| `resource_media_file_size_bytes_check` | CHECK | `CHECK (((file_size_bytes IS NULL) OR (file_size_bytes >= 0)))` |
| `resource_media_height_check` | CHECK | `CHECK (((height IS NULL) OR (height >= 0)))` |
| `resource_media_id_not_null` | n | `NOT NULL id` |
| `resource_media_mime_type_not_null` | n | `NOT NULL mime_type` |
| `resource_media_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_media_storage_bucket_not_null` | n | `NOT NULL storage_bucket` |
| `resource_media_storage_bucket_storage_path_key` | UNIQUE | `UNIQUE (storage_bucket, storage_path)` |
| `resource_media_storage_path_not_null` | n | `NOT NULL storage_path` |
| `resource_media_updated_at_not_null` | n | `NOT NULL updated_at` |
| `resource_media_uploaded_by_fkey` | FOREIGN KEY | `FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL` |
| `resource_media_width_check` | CHECK | `CHECK (((width IS NULL) OR (width >= 0)))` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_media_uploaded_by` | `CREATE INDEX idx_resource_media_uploaded_by ON public.resource_media USING btree (uploaded_by)` |
| `resource_media_pkey` | `CREATE UNIQUE INDEX resource_media_pkey ON public.resource_media USING btree (id)` |
| `resource_media_storage_bucket_storage_path_key` | `CREATE UNIQUE INDEX resource_media_storage_bucket_storage_path_key ON public.resource_media USING btree (storage_bucket, storage_path)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `managers delete media` | DELETE | {public} | `private.can_manage_resources(auth.uid())` | `-` |
| `managers update media` | UPDATE | {public} | `(private.can_manage_resources(auth.uid()) OR (uploaded_by = auth.uid()))` | `(private.can_manage_resources(auth.uid()) OR (uploaded_by = auth.uid()))` |
| `staff insert media` | INSERT | {public} | `-` | `private.is_resource_staff(auth.uid())` |
| `staff read media` | SELECT | {public} | `private.is_resource_staff(auth.uid())` | `-` |

### `resource_post_categories`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `post_id` | uuid | NO | — |
| `category_id` | uuid | NO | — |
| `is_primary` | boolean | NO | `false` |
| `sort_order` | integer | NO | `0` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_post_categories_category_id_fkey` | FOREIGN KEY | `FOREIGN KEY (category_id) REFERENCES resource_categories(id) ON DELETE CASCADE` |
| `resource_post_categories_category_id_not_null` | n | `NOT NULL category_id` |
| `resource_post_categories_is_primary_not_null` | n | `NOT NULL is_primary` |
| `resource_post_categories_pkey` | PRIMARY KEY | `PRIMARY KEY (post_id, category_id)` |
| `resource_post_categories_post_id_fkey` | FOREIGN KEY | `FOREIGN KEY (post_id) REFERENCES resource_posts(id) ON DELETE CASCADE` |
| `resource_post_categories_post_id_not_null` | n | `NOT NULL post_id` |
| `resource_post_categories_sort_order_check` | CHECK | `CHECK ((sort_order >= 0))` |
| `resource_post_categories_sort_order_not_null` | n | `NOT NULL sort_order` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_post_categories_category` | `CREATE INDEX idx_resource_post_categories_category ON public.resource_post_categories USING btree (category_id)` |
| `resource_post_categories_pkey` | `CREATE UNIQUE INDEX resource_post_categories_pkey ON public.resource_post_categories USING btree (post_id, category_id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `public read post-category links for readable posts` | SELECT | {public} | `(EXISTS ( SELECT 1
   FROM resource_posts p
  WHERE ((p.id = resource_post_categories.post_id) AND (((p.status = ANY (ARRAY['published'::text, 'review_due'::text, 'archived'::text])) AND (p.visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND (p.published_at IS NOT NULL) AND (p.published_at <= now())) OR private.is_resource_staff(auth.uid())))))` | `-` |
| `staff manage post-category links` | ALL | {public} | `private.is_resource_staff(auth.uid())` | `private.is_resource_staff(auth.uid())` |

### `resource_post_faqs`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `post_id` | uuid | NO | — |
| `faq_id` | uuid | NO | — |
| `sort_order` | integer | NO | `0` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_post_faqs_faq_id_fkey` | FOREIGN KEY | `FOREIGN KEY (faq_id) REFERENCES resource_faqs(id) ON DELETE CASCADE` |
| `resource_post_faqs_faq_id_not_null` | n | `NOT NULL faq_id` |
| `resource_post_faqs_pkey` | PRIMARY KEY | `PRIMARY KEY (post_id, faq_id)` |
| `resource_post_faqs_post_id_fkey` | FOREIGN KEY | `FOREIGN KEY (post_id) REFERENCES resource_posts(id) ON DELETE CASCADE` |
| `resource_post_faqs_post_id_not_null` | n | `NOT NULL post_id` |
| `resource_post_faqs_sort_order_check` | CHECK | `CHECK ((sort_order >= 0))` |
| `resource_post_faqs_sort_order_not_null` | n | `NOT NULL sort_order` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_post_faqs_faq` | `CREATE INDEX idx_resource_post_faqs_faq ON public.resource_post_faqs USING btree (faq_id)` |
| `resource_post_faqs_pkey` | `CREATE UNIQUE INDEX resource_post_faqs_pkey ON public.resource_post_faqs USING btree (post_id, faq_id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `public read post-faq links for readable posts` | SELECT | {public} | `(EXISTS ( SELECT 1
   FROM resource_posts p
  WHERE ((p.id = resource_post_faqs.post_id) AND (((p.status = ANY (ARRAY['published'::text, 'review_due'::text, 'archived'::text])) AND (p.visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND (p.published_at IS NOT NULL) AND (p.published_at <= now())) OR private.is_resource_staff(auth.uid())))))` | `-` |
| `staff manage post-faq links` | ALL | {public} | `private.is_resource_staff(auth.uid())` | `private.is_resource_staff(auth.uid())` |

### `resource_post_sources`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `post_id` | uuid | NO | — |
| `source_id` | uuid | NO | — |
| `sort_order` | integer | NO | `0` |
| `notes` | text | YES | — |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_post_sources_pkey` | PRIMARY KEY | `PRIMARY KEY (post_id, source_id)` |
| `resource_post_sources_post_id_fkey` | FOREIGN KEY | `FOREIGN KEY (post_id) REFERENCES resource_posts(id) ON DELETE CASCADE` |
| `resource_post_sources_post_id_not_null` | n | `NOT NULL post_id` |
| `resource_post_sources_sort_order_check` | CHECK | `CHECK ((sort_order >= 0))` |
| `resource_post_sources_sort_order_not_null` | n | `NOT NULL sort_order` |
| `resource_post_sources_source_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_id) REFERENCES resource_sources(id) ON DELETE CASCADE` |
| `resource_post_sources_source_id_not_null` | n | `NOT NULL source_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_post_sources_source` | `CREATE INDEX idx_resource_post_sources_source ON public.resource_post_sources USING btree (source_id)` |
| `resource_post_sources_pkey` | `CREATE UNIQUE INDEX resource_post_sources_pkey ON public.resource_post_sources USING btree (post_id, source_id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `public read post-source links for readable posts` | SELECT | {public} | `(EXISTS ( SELECT 1
   FROM (resource_posts p
     JOIN resource_sources s ON ((s.id = resource_post_sources.source_id)))
  WHERE ((p.id = resource_post_sources.post_id) AND s.is_public AND (((p.status = ANY (ARRAY['published'::text, 'review_due'::text, 'archived'::text])) AND (p.visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND (p.published_at IS NOT NULL) AND (p.published_at <= now())) OR private.is_resource_staff(auth.uid())))))` | `-` |
| `staff manage post-source links` | ALL | {public} | `private.is_resource_staff(auth.uid())` | `private.is_resource_staff(auth.uid())` |

### `resource_post_tags`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `post_id` | uuid | NO | — |
| `tag_id` | uuid | NO | — |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_post_tags_pkey` | PRIMARY KEY | `PRIMARY KEY (post_id, tag_id)` |
| `resource_post_tags_post_id_fkey` | FOREIGN KEY | `FOREIGN KEY (post_id) REFERENCES resource_posts(id) ON DELETE CASCADE` |
| `resource_post_tags_post_id_not_null` | n | `NOT NULL post_id` |
| `resource_post_tags_tag_id_fkey` | FOREIGN KEY | `FOREIGN KEY (tag_id) REFERENCES resource_tags(id) ON DELETE CASCADE` |
| `resource_post_tags_tag_id_not_null` | n | `NOT NULL tag_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_post_tags_tag` | `CREATE INDEX idx_resource_post_tags_tag ON public.resource_post_tags USING btree (tag_id)` |
| `resource_post_tags_pkey` | `CREATE UNIQUE INDEX resource_post_tags_pkey ON public.resource_post_tags USING btree (post_id, tag_id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `public read post-tag links for readable posts` | SELECT | {public} | `(EXISTS ( SELECT 1
   FROM resource_posts p
  WHERE ((p.id = resource_post_tags.post_id) AND (((p.status = ANY (ARRAY['published'::text, 'review_due'::text, 'archived'::text])) AND (p.visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND (p.published_at IS NOT NULL) AND (p.published_at <= now())) OR private.is_resource_staff(auth.uid())))))` | `-` |
| `staff manage post-tag links` | ALL | {public} | `private.is_resource_staff(auth.uid())` | `private.is_resource_staff(auth.uid())` |

### `resource_post_versions`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `post_id` | uuid | NO | — |
| `version_number` | integer | NO | — |
| `snapshot` | jsonb | NO | — |
| `change_summary` | text | YES | — |
| `created_by` | uuid | YES | — |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_post_versions_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_post_versions_created_by_fkey` | FOREIGN KEY | `FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL` |
| `resource_post_versions_id_not_null` | n | `NOT NULL id` |
| `resource_post_versions_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_post_versions_post_id_fkey` | FOREIGN KEY | `FOREIGN KEY (post_id) REFERENCES resource_posts(id) ON DELETE CASCADE` |
| `resource_post_versions_post_id_not_null` | n | `NOT NULL post_id` |
| `resource_post_versions_snapshot_not_null` | n | `NOT NULL snapshot` |
| `resource_post_versions_version_number_check` | CHECK | `CHECK ((version_number > 0))` |
| `resource_post_versions_version_number_not_null` | n | `NOT NULL version_number` |
| `uq_resource_post_versions` | UNIQUE | `UNIQUE (post_id, version_number)` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_post_versions_post` | `CREATE INDEX idx_resource_post_versions_post ON public.resource_post_versions USING btree (post_id, created_at)` |
| `resource_post_versions_pkey` | `CREATE UNIQUE INDEX resource_post_versions_pkey ON public.resource_post_versions USING btree (id)` |
| `uq_resource_post_versions` | `CREATE UNIQUE INDEX uq_resource_post_versions ON public.resource_post_versions USING btree (post_id, version_number)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `staff insert post versions` | INSERT | {public} | `-` | `private.is_resource_staff(auth.uid())` |
| `staff read post versions` | SELECT | {public} | `private.is_resource_staff(auth.uid())` | `-` |

### `resource_posts`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `content_id` | text | YES | — |
| `title` | text | NO | — |
| `slug` | text | YES | — |
| `excerpt` | text | YES | — |
| `content_blocks` | jsonb | NO | `'[]'::jsonb` |
| `content_type` | text | NO | — |
| `jurisdiction` | text | NO | `'global'::text` |
| `difficulty` | text | YES | — |
| `freshness_type` | text | NO | `'evergreen'::text` |
| `visibility` | text | NO | `'private'::text` |
| `primary_category_id` | uuid | YES | — |
| `featured_image_id` | uuid | YES | — |
| `author_id` | uuid | YES | — |
| `reviewer_id` | uuid | YES | — |
| `compliance_reviewer_id` | uuid | YES | — |
| `status` | text | NO | `'idea'::text` |
| `compliance_classification` | text | NO | `'green'::text` |
| `scheduled_at` | timestamp with time zone | YES | — |
| `published_at` | timestamp with time zone | YES | — |
| `expires_at` | timestamp with time zone | YES | — |
| `last_reviewed_at` | timestamp with time zone | YES | — |
| `next_review_at` | timestamp with time zone | YES | — |
| `seo_title` | text | YES | — |
| `seo_description` | text | YES | — |
| `canonical_url` | text | YES | — |
| `social_image_id` | uuid | YES | — |
| `is_indexable` | boolean | NO | `true` |
| `primary_cta_id` | uuid | YES | — |
| `secondary_cta_id` | uuid | YES | — |
| `is_featured` | boolean | NO | `false` |
| `featured_priority` | integer | YES | — |
| `editorial_approved_by` | uuid | YES | — |
| `editorial_approved_at` | timestamp with time zone | YES | — |
| `compliance_approved_by` | uuid | YES | — |
| `compliance_approved_at` | timestamp with time zone | YES | — |
| `created_by` | uuid | YES | — |
| `created_at` | timestamp with time zone | NO | `now()` |
| `updated_by` | uuid | YES | — |
| `updated_at` | timestamp with time zone | NO | `now()` |
| `event_date` | date | YES | — |
| `affected_audience` | text | YES | — |
| `aliases` | ARRAY | YES | — |
| `search_vector` | tsvector | YES | — |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `chk_resource_posts_amber_requires_compliance` | CHECK | `CHECK (((compliance_classification <> 'amber'::text) OR (status <> ALL (ARRAY['scheduled'::text, 'published'::text])) OR ((compliance_approved_by IS NOT NULL) AND (compliance_approved_at IS NOT NULL))))` |
| `chk_resource_posts_content_blocks_is_array` | CHECK | `CHECK ((jsonb_typeof(content_blocks) = 'array'::text))` |
| `chk_resource_posts_published_at` | CHECK | `CHECK (((status <> 'published'::text) OR (published_at IS NOT NULL)))` |
| `chk_resource_posts_red_never_publishes` | CHECK | `CHECK (((compliance_classification <> 'red'::text) OR (status <> ALL (ARRAY['scheduled'::text, 'published'::text]))))` |
| `chk_resource_posts_scheduled_at` | CHECK | `CHECK (((status <> 'scheduled'::text) OR (scheduled_at IS NOT NULL)))` |
| `chk_resource_posts_slug_before_publish` | CHECK | `CHECK (((status = 'idea'::text) OR (status = 'draft'::text) OR (slug IS NOT NULL)))` |
| `resource_posts_author_id_fkey` | FOREIGN KEY | `FOREIGN KEY (author_id) REFERENCES resource_authors(id) ON DELETE SET NULL` |
| `resource_posts_compliance_approved_by_fkey` | FOREIGN KEY | `FOREIGN KEY (compliance_approved_by) REFERENCES auth.users(id) ON DELETE SET NULL` |
| `resource_posts_compliance_classification_check` | CHECK | `CHECK ((compliance_classification = ANY (ARRAY['green'::text, 'amber'::text, 'red'::text])))` |
| `resource_posts_compliance_classification_not_null` | n | `NOT NULL compliance_classification` |
| `resource_posts_compliance_reviewer_id_fkey` | FOREIGN KEY | `FOREIGN KEY (compliance_reviewer_id) REFERENCES resource_authors(id) ON DELETE SET NULL` |
| `resource_posts_content_blocks_not_null` | n | `NOT NULL content_blocks` |
| `resource_posts_content_id_key` | UNIQUE | `UNIQUE (content_id)` |
| `resource_posts_content_type_check` | CHECK | `CHECK ((content_type = ANY (ARRAY['article'::text, 'guide'::text, 'fhip_explainer'::text, 'video'::text, 'glossary'::text, 'money_update'::text, 'money_update_template'::text])))` |
| `resource_posts_content_type_not_null` | n | `NOT NULL content_type` |
| `resource_posts_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_posts_created_by_fkey` | FOREIGN KEY | `FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL` |
| `resource_posts_difficulty_check` | CHECK | `CHECK ((difficulty = ANY (ARRAY['beginner'::text, 'beginner_intermediate'::text, 'intermediate'::text, 'intermediate_advanced'::text, 'advanced'::text])))` |
| `resource_posts_editorial_approved_by_fkey` | FOREIGN KEY | `FOREIGN KEY (editorial_approved_by) REFERENCES auth.users(id) ON DELETE SET NULL` |
| `resource_posts_featured_image_id_fkey` | FOREIGN KEY | `FOREIGN KEY (featured_image_id) REFERENCES resource_media(id) ON DELETE SET NULL` |
| `resource_posts_featured_priority_check` | CHECK | `CHECK (((featured_priority IS NULL) OR (featured_priority >= 0)))` |
| `resource_posts_freshness_type_check` | CHECK | `CHECK ((freshness_type = ANY (ARRAY['evergreen'::text, 'time_sensitive'::text])))` |
| `resource_posts_freshness_type_not_null` | n | `NOT NULL freshness_type` |
| `resource_posts_id_not_null` | n | `NOT NULL id` |
| `resource_posts_is_featured_not_null` | n | `NOT NULL is_featured` |
| `resource_posts_is_indexable_not_null` | n | `NOT NULL is_indexable` |
| `resource_posts_jurisdiction_check` | CHECK | `CHECK ((jurisdiction = ANY (ARRAY['global'::text, 'australia'::text, 'india'::text, 'australia_india_cross_border'::text])))` |
| `resource_posts_jurisdiction_not_null` | n | `NOT NULL jurisdiction` |
| `resource_posts_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_posts_primary_category_id_fkey` | FOREIGN KEY | `FOREIGN KEY (primary_category_id) REFERENCES resource_categories(id) ON DELETE SET NULL` |
| `resource_posts_primary_cta_id_fkey` | FOREIGN KEY | `FOREIGN KEY (primary_cta_id) REFERENCES resource_ctas(id) ON DELETE SET NULL` |
| `resource_posts_reviewer_id_fkey` | FOREIGN KEY | `FOREIGN KEY (reviewer_id) REFERENCES resource_authors(id) ON DELETE SET NULL` |
| `resource_posts_secondary_cta_id_fkey` | FOREIGN KEY | `FOREIGN KEY (secondary_cta_id) REFERENCES resource_ctas(id) ON DELETE SET NULL` |
| `resource_posts_slug_key` | UNIQUE | `UNIQUE (slug)` |
| `resource_posts_social_image_id_fkey` | FOREIGN KEY | `FOREIGN KEY (social_image_id) REFERENCES resource_media(id) ON DELETE SET NULL` |
| `resource_posts_status_check` | CHECK | `CHECK ((status = ANY (ARRAY['idea'::text, 'draft'::text, 'editorial_review'::text, 'compliance_review'::text, 'approved'::text, 'scheduled'::text, 'published'::text, 'review_due'::text, 'archived'::text])))` |
| `resource_posts_status_not_null` | n | `NOT NULL status` |
| `resource_posts_title_not_null` | n | `NOT NULL title` |
| `resource_posts_updated_at_not_null` | n | `NOT NULL updated_at` |
| `resource_posts_updated_by_fkey` | FOREIGN KEY | `FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL` |
| `resource_posts_visibility_check` | CHECK | `CHECK ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text, 'private'::text])))` |
| `resource_posts_visibility_not_null` | n | `NOT NULL visibility` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_posts_author` | `CREATE INDEX idx_resource_posts_author ON public.resource_posts USING btree (author_id)` |
| `idx_resource_posts_compliance_classification` | `CREATE INDEX idx_resource_posts_compliance_classification ON public.resource_posts USING btree (compliance_classification)` |
| `idx_resource_posts_content_id` | `CREATE INDEX idx_resource_posts_content_id ON public.resource_posts USING btree (content_id)` |
| `idx_resource_posts_content_type` | `CREATE INDEX idx_resource_posts_content_type ON public.resource_posts USING btree (content_type)` |
| `idx_resource_posts_event_date` | `CREATE INDEX idx_resource_posts_event_date ON public.resource_posts USING btree (event_date)` |
| `idx_resource_posts_jurisdiction` | `CREATE INDEX idx_resource_posts_jurisdiction ON public.resource_posts USING btree (jurisdiction)` |
| `idx_resource_posts_next_review_at` | `CREATE INDEX idx_resource_posts_next_review_at ON public.resource_posts USING btree (next_review_at)` |
| `idx_resource_posts_primary_category` | `CREATE INDEX idx_resource_posts_primary_category ON public.resource_posts USING btree (primary_category_id)` |
| `idx_resource_posts_public_read` | `CREATE INDEX idx_resource_posts_public_read ON public.resource_posts USING btree (status, visibility, published_at)` |
| `idx_resource_posts_published_at` | `CREATE INDEX idx_resource_posts_published_at ON public.resource_posts USING btree (published_at)` |
| `idx_resource_posts_scheduled_at` | `CREATE INDEX idx_resource_posts_scheduled_at ON public.resource_posts USING btree (scheduled_at)` |
| `idx_resource_posts_search_vector` | `CREATE INDEX idx_resource_posts_search_vector ON public.resource_posts USING gin (search_vector)` |
| `idx_resource_posts_slug` | `CREATE INDEX idx_resource_posts_slug ON public.resource_posts USING btree (slug)` |
| `idx_resource_posts_status` | `CREATE INDEX idx_resource_posts_status ON public.resource_posts USING btree (status)` |
| `resource_posts_content_id_key` | `CREATE UNIQUE INDEX resource_posts_content_id_key ON public.resource_posts USING btree (content_id)` |
| `resource_posts_pkey` | `CREATE UNIQUE INDEX resource_posts_pkey ON public.resource_posts USING btree (id)` |
| `resource_posts_slug_key` | `CREATE UNIQUE INDEX resource_posts_slug_key ON public.resource_posts USING btree (slug)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `authors insert own drafts` | INSERT | {public} | `-` | `(private.is_resource_staff(auth.uid()) AND (created_by = auth.uid()))` |
| `managers delete posts` | DELETE | {public} | `private.can_manage_resources(auth.uid())` | `-` |
| `public read published posts` | SELECT | {public} | `((status = ANY (ARRAY['published'::text, 'review_due'::text, 'archived'::text])) AND (visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND (published_at IS NOT NULL) AND (published_at <= now()))` | `-` |
| `staff read all posts` | SELECT | {public} | `private.is_resource_staff(auth.uid())` | `-` |
| `staff update posts` | UPDATE | {public} | `private.is_resource_staff(auth.uid())` | `private.is_resource_staff(auth.uid())` |

### `resource_related_content`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `source_post_id` | uuid | NO | — |
| `related_post_id` | uuid | NO | — |
| `relationship_type` | text | NO | `'related'::text` |
| `sort_order` | integer | NO | `0` |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `chk_resource_related_content_no_self_reference` | CHECK | `CHECK ((source_post_id <> related_post_id))` |
| `resource_related_content_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_related_content_id_not_null` | n | `NOT NULL id` |
| `resource_related_content_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_related_content_related_post_id_fkey` | FOREIGN KEY | `FOREIGN KEY (related_post_id) REFERENCES resource_posts(id) ON DELETE CASCADE` |
| `resource_related_content_related_post_id_not_null` | n | `NOT NULL related_post_id` |
| `resource_related_content_relationship_type_check` | CHECK | `CHECK ((relationship_type = ANY (ARRAY['related'::text, 'prerequisite'::text, 'next_step'::text, 'see_also'::text])))` |
| `resource_related_content_relationship_type_not_null` | n | `NOT NULL relationship_type` |
| `resource_related_content_sort_order_check` | CHECK | `CHECK ((sort_order >= 0))` |
| `resource_related_content_sort_order_not_null` | n | `NOT NULL sort_order` |
| `resource_related_content_source_post_id_fkey` | FOREIGN KEY | `FOREIGN KEY (source_post_id) REFERENCES resource_posts(id) ON DELETE CASCADE` |
| `resource_related_content_source_post_id_not_null` | n | `NOT NULL source_post_id` |
| `uq_resource_related_content` | UNIQUE | `UNIQUE (source_post_id, related_post_id, relationship_type)` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_related_content_related` | `CREATE INDEX idx_resource_related_content_related ON public.resource_related_content USING btree (related_post_id)` |
| `resource_related_content_pkey` | `CREATE UNIQUE INDEX resource_related_content_pkey ON public.resource_related_content USING btree (id)` |
| `uq_resource_related_content` | `CREATE UNIQUE INDEX uq_resource_related_content ON public.resource_related_content USING btree (source_post_id, related_post_id, relationship_type)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `public read related links between readable posts` | SELECT | {public} | `(EXISTS ( SELECT 1
   FROM resource_posts p
  WHERE ((p.id = resource_related_content.source_post_id) AND (((p.status = ANY (ARRAY['published'::text, 'review_due'::text, 'archived'::text])) AND (p.visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND (p.published_at IS NOT NULL) AND (p.published_at <= now())) OR private.is_resource_staff(auth.uid())))))` | `-` |
| `staff manage related content` | ALL | {public} | `private.is_resource_staff(auth.uid())` | `private.is_resource_staff(auth.uid())` |

### `resource_settings`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `key` | text | NO | — |
| `value` | jsonb | NO | — |
| `description` | text | YES | — |
| `updated_by` | uuid | YES | — |
| `updated_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_settings_key_not_null` | n | `NOT NULL key` |
| `resource_settings_pkey` | PRIMARY KEY | `PRIMARY KEY (key)` |
| `resource_settings_updated_at_not_null` | n | `NOT NULL updated_at` |
| `resource_settings_updated_by_fkey` | FOREIGN KEY | `FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL` |
| `resource_settings_value_not_null` | n | `NOT NULL value` |

**Indexes**

| Name | Definition |
|---|---|
| `resource_settings_pkey` | `CREATE UNIQUE INDEX resource_settings_pkey ON public.resource_settings USING btree (key)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `managers write settings` | ALL | {public} | `private.can_manage_resources(auth.uid())` | `private.can_manage_resources(auth.uid())` |
| `public read safe settings` | SELECT | {public} | `(key = ANY (ARRAY['default_disclaimer'::text, 'youtube_channel_handle'::text, 'youtube_channel_url'::text]))` | `-` |
| `staff read settings` | SELECT | {public} | `private.is_resource_staff(auth.uid())` | `-` |

### `resource_sources`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `source_name` | text | NO | — |
| `document_title` | text | YES | — |
| `url` | text | YES | — |
| `source_type` | text | YES | — |
| `jurisdiction` | text | YES | — |
| `publication_date` | date | YES | — |
| `checked_at` | timestamp with time zone | YES | — |
| `is_public` | boolean | NO | `true` |
| `created_by` | uuid | YES | — |
| `created_at` | timestamp with time zone | NO | `now()` |
| `updated_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_sources_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_sources_created_by_fkey` | FOREIGN KEY | `FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL` |
| `resource_sources_id_not_null` | n | `NOT NULL id` |
| `resource_sources_is_public_not_null` | n | `NOT NULL is_public` |
| `resource_sources_jurisdiction_check` | CHECK | `CHECK (((jurisdiction IS NULL) OR (jurisdiction = ANY (ARRAY['global'::text, 'australia'::text, 'india'::text, 'australia_india_cross_border'::text]))))` |
| `resource_sources_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_sources_source_name_not_null` | n | `NOT NULL source_name` |
| `resource_sources_updated_at_not_null` | n | `NOT NULL updated_at` |

**Indexes**

| Name | Definition |
|---|---|
| `resource_sources_pkey` | `CREATE UNIQUE INDEX resource_sources_pkey ON public.resource_sources USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `managers delete sources` | DELETE | {public} | `private.can_manage_resources(auth.uid())` | `-` |
| `public read public sources` | SELECT | {public} | `is_public` | `-` |
| `staff manage sources` | INSERT | {public} | `-` | `private.is_resource_staff(auth.uid())` |
| `staff read all sources` | SELECT | {public} | `private.is_resource_staff(auth.uid())` | `-` |
| `staff update sources` | UPDATE | {public} | `private.is_resource_staff(auth.uid())` | `private.is_resource_staff(auth.uid())` |

### `resource_tags`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `name` | text | NO | — |
| `slug` | text | NO | — |
| `description` | text | YES | — |
| `is_active` | boolean | NO | `true` |
| `created_at` | timestamp with time zone | NO | `now()` |
| `updated_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_tags_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_tags_id_not_null` | n | `NOT NULL id` |
| `resource_tags_is_active_not_null` | n | `NOT NULL is_active` |
| `resource_tags_name_not_null` | n | `NOT NULL name` |
| `resource_tags_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_tags_slug_key` | UNIQUE | `UNIQUE (slug)` |
| `resource_tags_slug_not_null` | n | `NOT NULL slug` |
| `resource_tags_updated_at_not_null` | n | `NOT NULL updated_at` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_tags_active` | `CREATE INDEX idx_resource_tags_active ON public.resource_tags USING btree (is_active)` |
| `idx_resource_tags_slug` | `CREATE INDEX idx_resource_tags_slug ON public.resource_tags USING btree (slug)` |
| `resource_tags_pkey` | `CREATE UNIQUE INDEX resource_tags_pkey ON public.resource_tags USING btree (id)` |
| `resource_tags_slug_key` | `CREATE UNIQUE INDEX resource_tags_slug_key ON public.resource_tags USING btree (slug)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `public read active tags` | SELECT | {public} | `is_active` | `-` |
| `staff manage tags` | ALL | {public} | `private.can_manage_resources(auth.uid())` | `private.can_manage_resources(auth.uid())` |

### `resource_user_roles`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `user_id` | uuid | NO | — |
| `role` | text | NO | — |
| `is_active` | boolean | NO | `true` |
| `assigned_by` | uuid | YES | — |
| `assigned_at` | timestamp with time zone | NO | `now()` |
| `created_at` | timestamp with time zone | NO | `now()` |
| `updated_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_user_roles_assigned_at_not_null` | n | `NOT NULL assigned_at` |
| `resource_user_roles_assigned_by_fkey` | FOREIGN KEY | `FOREIGN KEY (assigned_by) REFERENCES auth.users(id)` |
| `resource_user_roles_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_user_roles_id_not_null` | n | `NOT NULL id` |
| `resource_user_roles_is_active_not_null` | n | `NOT NULL is_active` |
| `resource_user_roles_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_user_roles_role_check` | CHECK | `CHECK ((role = ANY (ARRAY['resource_admin'::text, 'author'::text, 'editor'::text, 'compliance_reviewer'::text, 'publisher'::text, 'analyst'::text])))` |
| `resource_user_roles_role_not_null` | n | `NOT NULL role` |
| `resource_user_roles_updated_at_not_null` | n | `NOT NULL updated_at` |
| `resource_user_roles_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `resource_user_roles_user_id_not_null` | n | `NOT NULL user_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_user_roles_role` | `CREATE INDEX idx_resource_user_roles_role ON public.resource_user_roles USING btree (role) WHERE is_active` |
| `idx_resource_user_roles_user` | `CREATE INDEX idx_resource_user_roles_user ON public.resource_user_roles USING btree (user_id) WHERE is_active` |
| `resource_user_roles_pkey` | `CREATE UNIQUE INDEX resource_user_roles_pkey ON public.resource_user_roles USING btree (id)` |
| `uq_resource_user_roles_active` | `CREATE UNIQUE INDEX uq_resource_user_roles_active ON public.resource_user_roles USING btree (user_id, role) WHERE is_active` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `self read own resource roles` | SELECT | {public} | `(auth.uid() = user_id)` | `-` |

### `resource_videos`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `resource_post_id` | uuid | NO | — |
| `youtube_video_id` | text | NO | — |
| `youtube_url` | text | NO | — |
| `youtube_channel_handle` | text | NO | `'@GKTC'::text` |
| `youtube_channel_url` | text | YES | — |
| `duration_seconds` | integer | YES | — |
| `thumbnail_url` | text | YES | — |
| `youtube_published_at` | timestamp with time zone | YES | — |
| `transcript` | text | YES | — |
| `chapters` | jsonb | NO | `'[]'::jsonb` |
| `embed_enabled` | boolean | NO | `true` |
| `created_at` | timestamp with time zone | NO | `now()` |
| `updated_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `chk_resource_videos_chapters_is_array` | CHECK | `CHECK ((jsonb_typeof(chapters) = 'array'::text))` |
| `chk_resource_videos_youtube_id_not_blank` | CHECK | `CHECK ((btrim(youtube_video_id) <> ''::text))` |
| `resource_videos_chapters_not_null` | n | `NOT NULL chapters` |
| `resource_videos_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_videos_duration_seconds_check` | CHECK | `CHECK (((duration_seconds IS NULL) OR (duration_seconds >= 0)))` |
| `resource_videos_embed_enabled_not_null` | n | `NOT NULL embed_enabled` |
| `resource_videos_id_not_null` | n | `NOT NULL id` |
| `resource_videos_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_videos_resource_post_id_fkey` | FOREIGN KEY | `FOREIGN KEY (resource_post_id) REFERENCES resource_posts(id) ON DELETE CASCADE` |
| `resource_videos_resource_post_id_key` | UNIQUE | `UNIQUE (resource_post_id)` |
| `resource_videos_resource_post_id_not_null` | n | `NOT NULL resource_post_id` |
| `resource_videos_updated_at_not_null` | n | `NOT NULL updated_at` |
| `resource_videos_youtube_channel_handle_not_null` | n | `NOT NULL youtube_channel_handle` |
| `resource_videos_youtube_url_not_null` | n | `NOT NULL youtube_url` |
| `resource_videos_youtube_video_id_not_null` | n | `NOT NULL youtube_video_id` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_videos_youtube_id` | `CREATE INDEX idx_resource_videos_youtube_id ON public.resource_videos USING btree (youtube_video_id)` |
| `resource_videos_pkey` | `CREATE UNIQUE INDEX resource_videos_pkey ON public.resource_videos USING btree (id)` |
| `resource_videos_resource_post_id_key` | `CREATE UNIQUE INDEX resource_videos_resource_post_id_key ON public.resource_videos USING btree (resource_post_id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `public read videos for readable posts` | SELECT | {public} | `(EXISTS ( SELECT 1
   FROM resource_posts p
  WHERE ((p.id = resource_videos.resource_post_id) AND (((p.status = ANY (ARRAY['published'::text, 'review_due'::text, 'archived'::text])) AND (p.visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND (p.published_at IS NOT NULL) AND (p.published_at <= now())) OR private.is_resource_staff(auth.uid())))))` | `-` |
| `staff manage videos` | ALL | {public} | `private.is_resource_staff(auth.uid())` | `private.is_resource_staff(auth.uid())` |

### `resource_workflow_history`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `id` | uuid | NO | `gen_random_uuid()` |
| `post_id` | uuid | NO | — |
| `from_status` | text | YES | — |
| `to_status` | text | NO | — |
| `actor_user_id` | uuid | YES | — |
| `actor_role` | text | YES | — |
| `action` | text | NO | — |
| `reason` | text | YES | — |
| `notes` | text | YES | — |
| `metadata` | jsonb | NO | `'{}'::jsonb` |
| `created_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `resource_workflow_history_action_not_null` | n | `NOT NULL action` |
| `resource_workflow_history_actor_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL` |
| `resource_workflow_history_created_at_not_null` | n | `NOT NULL created_at` |
| `resource_workflow_history_id_not_null` | n | `NOT NULL id` |
| `resource_workflow_history_metadata_not_null` | n | `NOT NULL metadata` |
| `resource_workflow_history_pkey` | PRIMARY KEY | `PRIMARY KEY (id)` |
| `resource_workflow_history_post_id_fkey` | FOREIGN KEY | `FOREIGN KEY (post_id) REFERENCES resource_posts(id) ON DELETE CASCADE` |
| `resource_workflow_history_post_id_not_null` | n | `NOT NULL post_id` |
| `resource_workflow_history_to_status_not_null` | n | `NOT NULL to_status` |

**Indexes**

| Name | Definition |
|---|---|
| `idx_resource_workflow_history_post` | `CREATE INDEX idx_resource_workflow_history_post ON public.resource_workflow_history USING btree (post_id, created_at)` |
| `resource_workflow_history_pkey` | `CREATE UNIQUE INDEX resource_workflow_history_pkey ON public.resource_workflow_history USING btree (id)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `authors read own post workflow history` | SELECT | {public} | `(private.is_resource_staff(auth.uid()) OR (EXISTS ( SELECT 1
   FROM resource_posts p
  WHERE ((p.id = resource_workflow_history.post_id) AND (p.created_by = auth.uid())))))` | `-` |

### `user_financial_section_status`

**Columns**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `user_id` | uuid | NO | — |
| `section` | text | NO | — |
| `status` | text | NO | — |
| `updated_at` | timestamp with time zone | NO | `now()` |

**Constraints**

| Name | Type | Definition |
|---|---|---|
| `user_financial_section_status_pkey` | PRIMARY KEY | `PRIMARY KEY (user_id, section)` |
| `user_financial_section_status_section_check` | CHECK | `CHECK ((section = ANY (ARRAY['household'::text, 'income'::text, 'expenses'::text, 'assets'::text, 'liabilities'::text, 'investments'::text, 'retirement'::text, 'insurance'::text])))` |
| `user_financial_section_status_section_not_null` | n | `NOT NULL section` |
| `user_financial_section_status_status_check` | CHECK | `CHECK ((status = ANY (ARRAY['reviewed_zero'::text, 'not_applicable'::text, 'reviewed_with_data'::text])))` |
| `user_financial_section_status_status_not_null` | n | `NOT NULL status` |
| `user_financial_section_status_updated_at_not_null` | n | `NOT NULL updated_at` |
| `user_financial_section_status_user_id_fkey` | FOREIGN KEY | `FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE` |
| `user_financial_section_status_user_id_not_null` | n | `NOT NULL user_id` |

**Indexes**

| Name | Definition |
|---|---|
| `user_financial_section_status_pkey` | `CREATE UNIQUE INDEX user_financial_section_status_pkey ON public.user_financial_section_status USING btree (user_id, section)` |

**RLS:** ENABLED

**Policies**

| Name | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|
| `own financial section status` | ALL | {public} | `(auth.uid() = user_id)` | `(auth.uid() = user_id)` |

## Functions

| Schema | Function | Arguments |
|---|---|---|
| `private` | `can_manage_resources` | `p_user_id uuid` |
| `private` | `can_publish_resource` | `p_user_id uuid` |
| `private` | `has_resource_role` | `p_user_id uuid, p_role text` |
| `private` | `is_resource_analyst` | `p_user_id uuid` |
| `private` | `is_resource_staff` | `p_user_id uuid` |
| `public` | `resource_posts_search_vector` | `title text, aliases text[], excerpt text` |
| `public` | `search_resource_posts` | `p_query text, p_content_type text, p_jurisdiction text, p_category_id uuid, p_limit integer, p_offset integer` |
| `public` | `transition_resource_post_status` | `p_post_id uuid, p_to_status text, p_reason text, p_notes text` |
