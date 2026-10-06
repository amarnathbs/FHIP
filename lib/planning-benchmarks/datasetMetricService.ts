// Planning Benchmarks - maintaining the dataset to metric mapping (migration 0277) without SQL.
//
// Everything runs under the CALLER'S OWN session client. The two database functions authorise with auth.uid() and
// the existing activate capability themselves (no new capability), write one audit row per change, and never delete
// a live figure. The service-role client is not imported here (a static test enforces it).
import type { SupabaseClient } from '@supabase/supabase-js';
import { MappingRpcFailure, UploadDependencyError } from './uploadService';
import { isMissingRelation } from './allowedValues';

export interface SetMappingInput {
  datasetId: string;
  metricCode: string;
  appliesToValues: boolean;
  appliesToTargetRanges: boolean;
  reason: string;
  confirmLiveFigures: boolean;
}

export interface RemoveMappingInput {
  datasetId: string;
  metricCode: string;
  reason: string;
  confirmLiveFigures: boolean;
}

export async function setDatasetMetric(supabase: Pick<SupabaseClient, 'rpc'>, input: SetMappingInput): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('set_planning_benchmark_dataset_metric', {
    p_dataset: input.datasetId,
    p_metric: input.metricCode,
    p_values: input.appliesToValues,
    p_ranges: input.appliesToTargetRanges,
    p_reason: input.reason,
    p_confirm_live: input.confirmLiveFigures,
  });
  if (error) throw new MappingRpcFailure(error);
  const out = data as { status?: string } | null;
  if (!out || (out.status !== 'added' && out.status !== 'changed' && out.status !== 'unchanged')) throw new UploadDependencyError('unexpected mapping reply');
  return out as Record<string, unknown>;
}

export async function removeDatasetMetric(supabase: Pick<SupabaseClient, 'rpc'>, input: RemoveMappingInput): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('remove_planning_benchmark_dataset_metric', {
    p_dataset: input.datasetId,
    p_metric: input.metricCode,
    p_reason: input.reason,
    p_confirm_live: input.confirmLiveFigures,
  });
  if (error) throw new MappingRpcFailure(error);
  const out = data as { status?: string } | null;
  if (!out || out.status !== 'removed') throw new UploadDependencyError('unexpected mapping reply');
  return out as Record<string, unknown>;
}

export interface MappingEvent {
  at: string;
  action: 'added' | 'changed' | 'removed';
  datasetName: string;
  datasetVersion: string;
  metricCode: string;
  valuesBefore: boolean | null;
  rangesBefore: boolean | null;
  valuesAfter: boolean | null;
  rangesAfter: boolean | null;
  liveFigures: number;
  liveConfirmed: boolean;
  reason: string;
}

export type MappingEventsResult = { state: 'ok'; events: MappingEvent[] } | { state: 'not_installed' } | { state: 'unavailable' };

/** The latest changes to the mapping (newest first). The actor is never returned (Admin Standard section 9). */
export async function loadMappingEvents(supabase: Pick<SupabaseClient, 'from'>, limit = 25): Promise<MappingEventsResult> {
  try {
    const { data, error } = await supabase
      .from('benchmark_dataset_metric_events')
      .select('created_at, action, dataset_name, dataset_version, metric_code, values_before, ranges_before, values_after, ranges_after, live_figures, live_confirmed, reason')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return isMissingRelation(error) ? { state: 'not_installed' } : { state: 'unavailable' };
    if (!Array.isArray(data)) return { state: 'unavailable' };
    return {
      state: 'ok',
      events: (data as Array<Record<string, unknown>>).map((e) => ({
        at: String(e.created_at ?? ''),
        action: e.action as MappingEvent['action'],
        datasetName: String(e.dataset_name ?? ''),
        datasetVersion: String(e.dataset_version ?? ''),
        metricCode: String(e.metric_code ?? ''),
        valuesBefore: typeof e.values_before === 'boolean' ? e.values_before : null,
        rangesBefore: typeof e.ranges_before === 'boolean' ? e.ranges_before : null,
        valuesAfter: typeof e.values_after === 'boolean' ? e.values_after : null,
        rangesAfter: typeof e.ranges_after === 'boolean' ? e.ranges_after : null,
        liveFigures: Number(e.live_figures ?? 0),
        liveConfirmed: e.live_confirmed === true,
        reason: String(e.reason ?? ''),
      })),
    };
  } catch {
    return { state: 'unavailable' };
  }
}
