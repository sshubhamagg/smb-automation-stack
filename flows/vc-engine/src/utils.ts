// ============================================================
// VC Engine — Pure Utility Functions
// All functions are pure, non-throwing, deterministic.
// ============================================================

/** Parse any value to a finite number. Returns 0 for NaN/Infinity. */
export function safeNum(x: unknown): number {
  const n = Number(x);
  return isFinite(n) ? n : 0;
}

/** Safe division — returns 0 instead of Infinity or NaN when divisor is 0. */
export function safeDivide(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

/** Round to 2 decimal places. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Format a number as currency string. */
export function fmtCurrency(n: number): string {
  return n.toFixed(2);
}

/** Format today's date as YYYY-MM-DD. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
