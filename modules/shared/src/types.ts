/**
 * Canonical result type used across all modules.
 * Every module's execute/run function must return a type compatible with this.
 */
export type ModuleResult<T = unknown> =
  | { ok: true; output: T }
  | { ok: false; error: string; reason?: string };
