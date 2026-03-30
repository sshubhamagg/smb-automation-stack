import type { ParsedReportData } from './parser';
import type { Rep } from './types';

type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

// Month abbreviations mapped to 0-indexed month number (JS Date convention).
// Fixed set — no dynamic lookup, no locale dependency.
const MONTH_INDEX: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2,  apr: 3,  may: 4,  jun: 5,
  jul: 6, aug: 7, sep: 8,  oct: 9,  nov: 10, dec: 11,
};

// Use a fixed leap year so "29 Feb" is always valid when the month/day combo is.
const VALIDATION_YEAR = 2000;

/**
 * Returns true if the day+month string represents a real calendar date.
 * Expected format: "DD Mon" (e.g. "25 Mar", "01 Jan", "29 Feb").
 * Case-insensitive on the month name.
 */
function isValidDate(value: string): boolean {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2) return false;

  const [dayStr, monthStr] = parts;
  const day = Number(dayStr);
  const monthIdx = MONTH_INDEX[monthStr.toLowerCase()];

  if (!Number.isInteger(day) || monthIdx === undefined) return false;

  // Construct the date and confirm it did not roll over (e.g. "31 Apr" → May 1).
  const d = new Date(VALIDATION_YEAR, monthIdx, day);
  return d.getMonth() === monthIdx && d.getDate() === day;
}

function isNonNegativeNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function normalizeRegion(region: string): string {
  return region.trim().toLowerCase();
}

export function validateReport(input: {
  parsed: ParsedReportData;
  rep: Rep;
}): ValidationResult {
  const errors: string[] = [];
  const { parsed, rep } = input;

  if (!isNonNegativeNumber(parsed.sales_value)) {
    errors.push(`"sales_value" must be >= 0, got: ${parsed.sales_value}`);
  }

  if (!isNonNegativeNumber(parsed.total_calls)) {
    errors.push(`"total_calls" must be >= 0, got: ${parsed.total_calls}`);
  }

  if (!isNonNegativeNumber(parsed.orders)) {
    errors.push(`"orders" must be >= 0, got: ${parsed.orders}`);
  }

  if (normalizeRegion(parsed.region) !== normalizeRegion(rep.region)) {
    errors.push(
      `"region" mismatch: report has "${parsed.region}", rep is assigned to "${rep.region}"`
    );
  }

  if (!isValidDate(parsed.date)) {
    errors.push(`"date" is not a valid calendar date: "${parsed.date}"`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}
