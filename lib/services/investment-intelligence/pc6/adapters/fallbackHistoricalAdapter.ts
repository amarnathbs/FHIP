// NAV 1 Stage D (D.3) — primary source with a fallback. PO decision
// 2026-09-24: AMFI primary, TIGZIG fallback.
//
// The fallback is consulted only when the primary FAILS (ok: false) -- never to
// second-guess a successful primary answer. The case it exists for is a scheme
// AMFI no longer publishes (matured, merged, suspended), whose fund house the
// AMFI adapter therefore cannot resolve; transient AMFI outages are covered
// too.
//
// PROVENANCE. The result is returned exactly as the serving adapter produced
// it, so `provider.key` names the source that actually supplied the data
// ('amfi' or 'tigzig'). The hydration job stamps each row's data_version
// from that, never from this composite -- TIGZIG-sourced history must stay
// identifiable, because the registry records it as never to be promoted to
// canonical without AMFI cross-validation.

import type {
  HistoricalNavAdapter,
  HistoricalNavAdapterResult,
  HistoricalNavRequest,
} from './historicalNavAdapter';

export class FallbackHistoricalAdapter implements HistoricalNavAdapter {
  readonly providerKey: string;
  readonly adapterVersion: string;

  constructor(
    private readonly primary: HistoricalNavAdapter,
    private readonly fallback: HistoricalNavAdapter,
  ) {
    this.providerKey = `${primary.providerKey}+${fallback.providerKey}`;
    this.adapterVersion = `${primary.adapterVersion}|${fallback.adapterVersion}`;
  }

  async fetchHistory(request: HistoricalNavRequest): Promise<HistoricalNavAdapterResult> {
    const first = await this.primary.fetchHistory(request);
    if (first.ok) return first;

    const second = await this.fallback.fetchHistory(request);
    if (second.ok) return second;

    // Both failed. Report "not found" only when BOTH sources say so, since that
    // is the one outcome the job may treat as "no history exists here".
    // Anything else is a real failure and keeps the primary's kind.
    const kind = first.kind === 'not_found' && second.kind === 'not_found' ? 'not_found' : first.kind;
    return {
      ok: false,
      schemeIdentifier: request.schemeIdentifier,
      kind,
      detail: `${this.primary.providerKey}: ${first.detail} | fallback ${this.fallback.providerKey}: ${second.detail}`,
      provider: first.provider,
    };
  }
}
