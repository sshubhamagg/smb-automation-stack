import { parseReport, type ParsedReportData } from './parser';
import { validateReport } from './validator';
import type { Rep } from './types';

type FlowEvent = {
  message: string;
  user: string;
};

type FlowConfig = {
  reps: Rep[];
};

type FlowState = {
  config: FlowConfig;
  parsed_input: ParsedReportData;
  rep: Rep;
  timestamp: number;
  submitted_at: number;
};

type FlowContext = {
  event: FlowEvent;
  state: FlowState;
};

type BuildContextResult =
  | { ok: true; context: FlowContext }
  | { ok: false; error: string };

function findRep(reps: Rep[], user: string): Rep | undefined {
  const normalized = user.trim().toLowerCase();
  return reps.find(
    (r) => r.active && (r.phone.trim().toLowerCase() === normalized ||
                        r.rep_id.trim().toLowerCase() === normalized)
  );
}

export function buildInitialContext(input: {
  event: FlowEvent;
  config: FlowConfig;
}): BuildContextResult {
  const { event, config } = input;

  const parseResult = parseReport({ text: event.message });
  if (!parseResult.ok) {
    return { ok: false, error: `Parse failed: ${parseResult.error}` };
  }

  const rep = findRep(config.reps, event.user);
  if (rep === undefined) {
    return { ok: false, error: `Unknown or inactive rep: "${event.user}"` };
  }

  const validationResult = validateReport({ parsed: parseResult.data, rep });
  if (!validationResult.ok) {
    return { ok: false, error: `Validation failed: ${validationResult.errors.join('; ')}` };
  }

  const now = Date.now();
  return {
    ok: true,
    context: {
      event,
      state: {
        config,
        parsed_input: parseResult.data,
        rep,
        timestamp: now,
        submitted_at: now,
      },
    },
  };
}
