import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';
import {
  runPostBankApprovalMatchers,
  type PostBankApprovalMatcherResult,
  type PostBankApprovalTrigger,
} from '@/lib/import-bridge/postBankApprovalMatchers';

/**
 * Called by the three bank approval routes (statement approve, category-review
 * approve-all, approve-group) AFTER their approval has succeeded. Runs every
 * registered post-bank-approval matcher (WP-01 seam). A matcher failure is
 * audited as `post_approval_matcher_failed` (matcher id + error name only) and
 * never changes the route's response. Not a route file: Next.js ignores it for
 * routing.
 */
export async function runPostBankApprovalHook(
  userId: string,
  statementUploadId: string,
  trigger: PostBankApprovalTrigger,
): Promise<PostBankApprovalMatcherResult[]> {
  try {
    return await runPostBankApprovalMatchers(
      { userId, statementUploadId, trigger },
      {
        onMatcherError: async (matcherId, error) => {
          await recordDocumentAuditEvent({
            userId,
            documentId: statementUploadId,
            eventType: 'post_approval_matcher_failed',
            actorType: 'system',
            metadata: {
              matcher_id: matcherId,
              trigger,
              error_name: error instanceof Error ? error.name : 'Error',
            },
          });
        },
      },
    );
  } catch {
    // runPostBankApprovalMatchers never throws; this is belt and braces so the
    // approval response can never be affected by the seam.
    return [];
  }
}
