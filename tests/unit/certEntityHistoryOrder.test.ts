import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mergeEntityHistory } from '@/components/entities/entityHistory';

// DEV browser certification 26-10-2026: after "Switched to itemised" then "Undo", the Show history panel listed the line archive rows
// (written by the Undo) BELOW the older switch, because modes and line changes were printed as two blocks.
const modes = [
  { id: 'm-undo', action: 'undo', net_before: 280000, net_after: 250000, created_at: '2026-10-22T04:17:40.565627+00:00' },
  { id: 'm-sw', action: 'to_itemised', net_before: 250000, net_after: 280000, created_at: '2026-10-22T04:16:19.16965+00:00' },
];
const changes = [
  { id: 'c-ret-a', table_name: 'business_entity_assets', action: 'retire', created_at: '2026-10-22T04:17:40.565627+00:00' },
  { id: 'c-ret-l', table_name: 'business_entity_liabilities', action: 'retire', created_at: '2026-10-22T04:17:40.565627+00:00' },
  { id: 'c-ins-a', table_name: 'business_entity_assets', action: 'insert', created_at: '2026-10-22T04:16:19.16965+00:00' },
  { id: 'c-ins-l', table_name: 'business_entity_liabilities', action: 'insert', created_at: '2026-10-22T04:16:19.16965+00:00' },
];

describe('entity history is one newest-first list', () => {
  it('interleaves mode rows and line changes by time, mode row first at the same instant', () => {
    const ids = mergeEntityHistory(modes, changes).map((e) => e.row.id);
    expect(ids).toEqual(['m-undo', 'c-ret-a', 'c-ret-l', 'm-sw', 'c-ins-a', 'c-ins-l']);
  });
  it('a later change is never listed after an older switch (the defect: two blocks)', () => {
    const list = mergeEntityHistory(modes, changes);
    expect(list.findIndex((e) => e.row.id === 'c-ret-a')).toBeLessThan(list.findIndex((e) => e.row.id === 'm-sw'));
  });
  it('keeps only the newest 30 line changes', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, table_name: 'entity_income_items', action: 'insert', created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() }));
    const out = mergeEntityHistory([], many.slice().reverse());
    expect(out.length).toBe(30);
  });
  it('EntityCard renders the merged list, not two separate blocks', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'components/entities/EntityCard.tsx'), 'utf8');
    expect(src).toContain('mergeEntityHistory(history.modes, history.changes)');
    expect(src).not.toContain('history.modes.map(');
    expect(src).not.toContain('history.changes.slice(0, 30).map(');
  });
});
