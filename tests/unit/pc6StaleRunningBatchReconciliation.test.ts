// PC6/NAV 1 continuation — unit tests for reconcileStaleRunningBatches(),
// built after finding TWO real 'running' ii_reference_import_batches rows
// live in DEV, 35 seconds apart, neither ever reaching a terminal status.

import { describe, it, expect } from 'vitest';
import { reconcileStaleRunningBatches } from '@/lib/services/investment-intelligence/pc6/referenceImportRunner';

const NOW = '2026-09-21T12:00:00.000Z';

describe('reconcileStaleRunningBatches', () => {
  it('reports no running batches when none exist', () => {
    const result = reconcileStaleRunningBatches([], NOW, 15);
    expect(result.reconciledIds).toEqual([]);
    expect(result.stillRunning).toBe(false);
  });

  it('reconciles a batch older than the stale threshold as abandoned', () => {
    const result = reconcileStaleRunningBatches(
      [{ id: 'batch-1', started_at: '2026-09-21T11:30:00.000Z' }], // 30 min ago
      NOW,
      15
    );
    expect(result.reconciledIds).toEqual(['batch-1']);
    expect(result.stillRunning).toBe(false);
  });

  it('refuses a new start when a batch is genuinely still recent (within the threshold)', () => {
    const result = reconcileStaleRunningBatches(
      [{ id: 'batch-2', started_at: '2026-09-21T11:55:00.000Z' }], // 5 min ago
      NOW,
      15
    );
    expect(result.reconciledIds).toEqual([]);
    expect(result.stillRunning).toBe(true);
  });

  it('reproduces the exact real DEV scenario: two overlapping runs, both reconciled once both are stale', () => {
    // The two real rows found live: started_at 08:46:10 and 08:46:45 on
    // 2026-09-20 — both long stale by the time any later run checks.
    const result = reconcileStaleRunningBatches(
      [
        { id: 'real-batch-1', started_at: '2026-09-20T08:46:10.058Z' },
        { id: 'real-batch-2', started_at: '2026-09-20T08:46:45.198Z' },
      ],
      NOW,
      15
    );
    expect(result.reconciledIds.sort()).toEqual(['real-batch-1', 'real-batch-2']);
    expect(result.stillRunning).toBe(false);
  });

  it('a mix of one stale and one genuinely-recent batch reconciles the stale one but still blocks a new start', () => {
    const result = reconcileStaleRunningBatches(
      [
        { id: 'stale', started_at: '2026-09-21T10:00:00.000Z' }, // 2 hours ago
        { id: 'recent', started_at: '2026-09-21T11:58:00.000Z' }, // 2 min ago
      ],
      NOW,
      15
    );
    expect(result.reconciledIds).toEqual(['stale']);
    expect(result.stillRunning).toBe(true);
  });

  it('a batch exactly AT the stale threshold is treated as still running (boundary is exclusive)', () => {
    const result = reconcileStaleRunningBatches(
      [{ id: 'boundary', started_at: '2026-09-21T11:45:00.000Z' }], // exactly 15 min ago
      NOW,
      15
    );
    expect(result.stillRunning).toBe(true);
    expect(result.reconciledIds).toEqual([]);
  });
});
