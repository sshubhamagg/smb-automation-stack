import type { Rep } from './types';
import type { NormalizedReport } from './types';

type ComputeMissingInput = {
  reps: Rep[];
  reports: NormalizedReport[];
  date: string;
};

type ComputeMissingOutput = {
  missing_rep_ids: string[];
};

export function computeMissing(input: ComputeMissingInput): ComputeMissingOutput {
  const submitted = new Set(
    input.reports
      .filter((r) => r.date === input.date && r.status !== 'invalid')
      .map((r) => r.rep_id),
  );

  const missing_rep_ids = input.reps
    .filter((r) => r.active && !submitted.has(r.rep_id))
    .map((r) => r.rep_id);

  return { missing_rep_ids };
}
