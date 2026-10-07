// NC-M3 (Stage 3, after 0271): a figure the database marks approximate must be shown as approximate on the admin page, never as an exact number.
import { describe, expect, it } from 'vitest';
import { show } from '@/components/admin/Nav2MonitoringClient';

describe('monitoring cells as shown', () => {
  it('an approximate figure says so; an exact one does not; suppressed and unavailable keep their labels and are never a number', () => {
    expect(show({ state: 'ok', value: 3067498, approximate: true })).toBe('30,67,498 (approximate)');
    expect(show({ state: 'ok', value: 26806 })).toBe('26,806');
    expect(show({ state: 'suppressed', value: null, label: 'Insufficient data to display safely.' })).toBe('Insufficient data to display safely.');
    expect(show({ state: 'unavailable', value: null })).toBe('Not available.');
    expect(show(undefined)).toBe('Not available.');
  });
});
