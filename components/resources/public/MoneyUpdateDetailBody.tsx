// Spec §44-47: Money Update detail. Structured sections (What Happened? /
// Why Does It Matter? / etc.) are already real H2 content_blocks — see
// lib/resources/money-update/blocks.ts's starterTemplateForMoneyUpdate —
// so BlockRenderer alone reproduces spec §46's suggested order without this
// component inventing a second, parallel section model (spec §46: "Use
// actual structured blocks. Do not fabricate missing sections").

import { BlockRenderer } from '@/components/resources/blocks/BlockRenderer';
import { formatPublicDate } from '@/lib/resources/public/metadata';
import { isExpired } from '@/lib/resources/public/visibility';
import { FreshnessWarning, LastReviewedNote } from './FreshnessWarning';
import type { AnyBlock } from '@/lib/resources/editor/blocks';

export function MoneyUpdateDetailBody({
  eventDate,
  affectedAudience,
  contentBlocks,
  expiresAt,
  lastReviewedAt,
}: {
  eventDate: string | null;
  affectedAudience: string | null;
  contentBlocks: unknown[];
  expiresAt: string | null;
  lastReviewedAt: string | null;
}) {
  const eventLabel = formatPublicDate(eventDate);
  const expired = isExpired(expiresAt);

  return (
    <div className="space-y-6">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
        {eventLabel && (
          <div>
            <dt className="inline font-medium text-ink">Event date:</dt> <dd className="inline">{eventLabel}</dd>
          </div>
        )}
        {affectedAudience && (
          <div>
            <dt className="inline font-medium text-ink">Who may be affected:</dt> <dd className="inline">{affectedAudience}</dd>
          </div>
        )}
      </dl>

      {expired ? <FreshnessWarning expiresAt={expiresAt} lastReviewedAt={lastReviewedAt} /> : <LastReviewedNote lastReviewedAt={lastReviewedAt} />}

      <BlockRenderer blocks={contentBlocks as AnyBlock[]} />
    </div>
  );
}
