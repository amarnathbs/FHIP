'use client';

/**
 * AIE15-MASK-01..12 masked display value, REWRITTEN FOR THE PRODUCT OWNER'S
 * 2026-09-15 TOKENISATION DECISION.
 *
 * WHAT THIS COMPONENT USED TO DO. It rendered a "Reveal" button next to any
 * mask token, called `POST /api/aie/review/runs/{runId}/reveal`, showed the
 * user their own original value, and automatically re-masked after 20
 * seconds (MASK-07).
 *
 * WHY IT NO LONGER DOES. Identifier masking is now a keyed ONE-WAY HMAC
 * pseudonym (`lib/aie/masking/identifierToken.ts`). There is no escrow map,
 * no decrypt path, and no server-side ability to return the original value —
 * not "disabled", genuinely absent. The Product Owner chose this over
 * keeping the reversible map, accepting that a user will never see their own
 * original folio / account / PAN / holder-name / nominee value again once it
 * has been tokenised, including during their own review of their own
 * document.
 *
 * COPY DISCIPLINE. Nothing in this component says "original value", "hidden
 * value", or anything else implying the real value exists somewhere and is
 * merely being withheld. A "Reveal" affordance that can only ever fail is
 * worse than none — it invites a user to believe recovery is possible and
 * then tells them no. So the control is removed rather than shown-and-
 * disabled, and the label states the actual situation.
 *
 * WHY THE TOKEN ITSELF IS STILL SHOWN. It is not noise. A one-way pseudonym
 * is STABLE per (user, identifier), so a reviewer can still tell that two
 * rows refer to the same folio, and can still match a row against another
 * row — which is what the review task actually needs. Replacing it with a
 * generic bullet string would destroy that without protecting anything
 * further.
 */

/** Matches a token produced by `deriveIdentifierToken` — scheme segment
 * `hmac`, MAC rendered in the letters `a`-`p`. Kept in sync with
 * `isOneWayIdentifierToken` on the server; this client copy exists so the
 * component can label a token without a round trip. */
const ONE_WAY_TOKEN_SHAPE = /^\[MASKED:([a-z_]+):hmac:[a-p]+\]$/i;

/** Any `[MASKED:...]`-shaped token, including shapes this build no longer
 * produces. Kept so a historical candidate row rendered by an older run is
 * still labelled as masked rather than shown as raw-looking text. */
const ANY_MASK_TOKEN_SHAPE = /^\[MASKED:[a-z_]+:[a-z]+:[0-9a-z]+\]$/i;

const TYPE_LABELS: Record<string, string> = {
  folio_number: 'folio number',
  person_name_label: 'name',
  tax_id: 'tax identifier',
  bank_account: 'bank account',
  card_number: 'card number',
  aadhaar: 'Aadhaar',
  ifsc: 'IFSC',
  email: 'email address',
  phone: 'phone number',
  address_label: 'address',
  long_digit_run: 'identifier',
};

export function EvidenceValue({ runId, value }: { runId: string; value: string | null }) {
  // `runId` is retained in the props contract on purpose: every caller
  // already passes it, and removing it would churn call sites for no gain
  // while making a future per-run evidence affordance a breaking change
  // again. It is deliberately unused by this implementation.
  void runId;

  if (value === null) return <span className="text-muted">Not found</span>;

  const oneWay = ONE_WAY_TOKEN_SHAPE.exec(value);
  if (oneWay) {
    const label = TYPE_LABELS[oneWay[1].toLowerCase()] ?? 'identifier';
    return (
      <span className="inline-flex items-center gap-2">
        <span className="font-mono text-xs">{value}</span>
        <span className="text-xs text-muted" title={`This ${label} is replaced by a one-way code. The underlying value cannot be recovered by anyone, including support.`}>
          masked {label} — not recoverable
        </span>
      </span>
    );
  }

  if (ANY_MASK_TOKEN_SHAPE.test(value)) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="font-mono text-xs">{value}</span>
        <span className="text-xs text-muted">masked — not recoverable</span>
      </span>
    );
  }

  return <span>{value}</span>;
}
