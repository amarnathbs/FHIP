import { formatMoneyWhole } from './money';

export type MovementFormat = 'currency' | 'percentage_point' | 'ratio' | 'count' | 'months';
export type MovementDirection = 'positive' | 'negative' | 'neutral' | 'contextual';
export type MovementGoodDirection = 'up' | 'down' | 'contextual';

export interface MetricMovement {
  label: string;
  current: number | null;
  previous: number | null;
  format: MovementFormat;
  comparable: boolean;
  notComparableReason: string | null;
  changeAbsolute: number | null;
  changePercent: number | null; // only populated for currency/count/months formats
  direction: MovementDirection;
  displayText: string;
  currentText: string;
  previousText: string;
}

function formatValue(value: number, format: MovementFormat, currency: 'AUD' | 'INR'): string {
  switch (format) {
    case 'currency':
      return formatMoneyWhole(value, currency);
    case 'percentage_point':
      return `${value.toFixed(1)}%`;
    case 'ratio':
      return `${value.toFixed(1)}×`;
    case 'months':
      return `${value.toFixed(1)} months`;
    case 'count':
      return value.toFixed(0);
  }
}

// Distinguishes absolute currency movement, percentage-point movement, ratio
// movement and plain count movement (spec section 8, "Section 2"), and
// handles the "not comparable" cases from section 10.3 rather than ever
// silently dividing by zero or a missing prior value.
export function computeMetricMovement(params: {
  label: string;
  current: number | null;
  previous: number | null;
  format: MovementFormat;
  goodDirection: MovementGoodDirection;
  currency?: 'AUD' | 'INR';
}): MetricMovement {
  const { label, current, previous, format, goodDirection } = params;
  const currency = params.currency ?? 'AUD';

  if (current === null) {
    return {
      label,
      current,
      previous,
      format,
      comparable: false,
      notComparableReason: 'Current value unavailable',
      changeAbsolute: null,
      changePercent: null,
      direction: 'neutral',
      displayText: 'Not available',
      currentText: 'Not available',
      previousText: previous !== null ? formatValue(previous, format, currency) : 'Not available',
    };
  }
  const currentText = formatValue(current, format, currency);

  if (previous === null) {
    return {
      label,
      current,
      previous,
      format,
      comparable: false,
      notComparableReason: 'Previous value unavailable',
      changeAbsolute: null,
      changePercent: null,
      direction: 'neutral',
      displayText: 'New',
      currentText,
      previousText: 'Not available',
    };
  }

  const changeAbsolute = current - previous;
  const changePercent =
    (format === 'currency' || format === 'count' || format === 'months') && previous !== 0
      ? (changeAbsolute / Math.abs(previous)) * 100
      : null;

  let direction: MovementDirection;
  if (goodDirection === 'contextual') direction = 'contextual';
  else if (changeAbsolute === 0) direction = 'neutral';
  else if ((goodDirection === 'up' && changeAbsolute > 0) || (goodDirection === 'down' && changeAbsolute < 0)) direction = 'positive';
  else direction = 'negative';

  const sign = changeAbsolute >= 0 ? '+' : '−';
  let displayText: string;
  switch (format) {
    case 'currency':
      displayText = `${sign}${formatMoneyWhole(Math.abs(changeAbsolute), currency)}`;
      break;
    case 'percentage_point':
      displayText = `${sign}${Math.abs(changeAbsolute).toFixed(1)} percentage points`;
      break;
    case 'ratio':
      displayText = `${sign}${Math.abs(changeAbsolute).toFixed(1)}×`;
      break;
    case 'months':
      displayText = `${sign}${Math.abs(changeAbsolute).toFixed(1)} months`;
      break;
    case 'count':
      displayText = `${sign}${Math.abs(changeAbsolute).toFixed(0)}`;
      break;
  }

  return {
    label,
    current,
    previous,
    format,
    comparable: true,
    notComparableReason: null,
    changeAbsolute,
    changePercent,
    direction,
    displayText,
    currentText,
    previousText: formatValue(previous, format, currency),
  };
}

export function firstReportMessage(): string {
  return 'This is your first monthly financial-health report. Future reports will show changes against this starting position.';
}

// Section 14 deterministic templates. Every sentence references a verified
// metric passed in — no invented causes, no guarantee language.
// Compares rounded (displayed) scores rather than raw floats, so a
// sub-rounding drift (e.g. 74.086 vs 74.090) is never narrated as an
// increase/decrease when both display as the same whole number.
export function scoreMovementNarrative(current: number, previous: number | null, topDrivers: string[]): string {
  const currentRounded = Math.round(current);
  if (previous === null) return `Your Financial Health Score is currently ${currentRounded}.`;
  const previousRounded = Math.round(previous);
  if (currentRounded > previousRounded) {
    const driverText = topDrivers.length > 0 ? `, mainly reflecting ${topDrivers.join(' and ')}` : '';
    return `Your Financial Health Score increased from ${previousRounded} to ${currentRounded}${driverText}.`;
  }
  if (currentRounded < previousRounded) {
    const driverText = topDrivers.length > 0 ? `, mainly reflecting ${topDrivers.join(' and ')}` : '';
    return `Your Financial Health Score decreased from ${previousRounded} to ${currentRounded}${driverText}.`;
  }
  return `Your Financial Health Score remained stable at ${currentRounded}.`;
}

export function emergencyFundNarrative(months: number | null, targetMin: number, targetMax: number): string {
  if (months === null) return 'Emergency-fund coverage could not be calculated for this period.';
  if (months < targetMin) {
    return `Accessible reserves currently cover approximately ${months.toFixed(1)} months of essential expenses, which is below the indicative planning range of ${targetMin}–${targetMax} months.`;
  }
  if (months > targetMax) {
    return `Accessible reserves currently cover approximately ${months.toFixed(1)} months of essential expenses, above the indicative planning range of ${targetMin}–${targetMax} months.`;
  }
  return `Accessible reserves currently cover approximately ${months.toFixed(1)} months of essential expenses, within the indicative planning range of ${targetMin}–${targetMax} months.`;
}

export function overallocationNarrative(usagePct: number): string {
  return `Your planned goal contributions use ${usagePct.toFixed(0)}% of your estimated monthly surplus, leaving limited flexibility.`;
}

export function staleDataNarrative(monthsSinceUpdate: number): string {
  return `Some figures in this report are based on information last updated more than ${monthsSinceUpdate} month${monthsSinceUpdate === 1 ? '' : 's'} before the report date.`;
}
