import { formatMoney } from '@/lib/engines/money';

export function formatMetricValue(value: number | null, unit: string, currency: 'AUD' | 'INR'): string {
  if (value === null) return 'Not available';
  switch (unit) {
    case 'currency':
      return formatMoney(value, currency);
    case 'percentage':
      return `${value.toFixed(1)}%`;
    case 'months':
      return `${value.toFixed(1)} months`;
    case 'days':
      return `${value.toFixed(0)} days`;
    case 'ratio':
      return `${value.toFixed(2)}×`;
    case 'count':
      return value.toFixed(0);
    default:
      return String(value);
  }
}
