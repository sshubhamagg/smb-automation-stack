// ============================================================
// Flow: intent-router
//
// Responsibilities:
//   - Deterministic structured parse of inbound WhatsApp message
//   - Optional AI classify when structured parse fails (AI mode)
//   - Expose resolveRouting() for handler to pick the correct sub-flow
//
// Supported commands:
//   present <phone>
//   absent <phone>
//   paid <phone> <amount>
//   attendance
//   attendance <phone>
//   fees
//   fees <phone>
//
// Steps:
//   1. classify-intent  — intelligence, condition: parse failed + AI mode
//   2. send-invalid     — communication, condition: no valid intent (structured mode)
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { TuitionConfig, ParsedIntent, RoutingDecision } from '../src/types';

// ---------------------------------------------------------------------------
// Structured parser — pure, non-throwing
// ---------------------------------------------------------------------------

function isE164(phone: string): boolean {
  return /^\+\d{7,15}$/.test(phone);
}

function parseIntent(text: string): ParsedIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  const cmd   = (parts[0] ?? '').toLowerCase();

  // ── present <phone> ─────────────────────────────────────────────────────
  if (cmd === 'present' && parts.length === 2 && isE164(parts[1] ?? '')) {
    return { intent: 'present', studentPhone: parts[1] };
  }

  // ── absent <phone> ──────────────────────────────────────────────────────
  if (cmd === 'absent' && parts.length === 2 && isE164(parts[1] ?? '')) {
    return { intent: 'absent', studentPhone: parts[1] };
  }

  // ── paid <phone> <amount> ───────────────────────────────────────────────
  if (cmd === 'paid' && parts.length === 3 && isE164(parts[1] ?? '')) {
    const amount = parseFloat(parts[2] ?? '');
    if (!isNaN(amount) && amount > 0) {
      return { intent: 'paid', studentPhone: parts[1], amount };
    }
  }

  // ── attendance [<phone>] ────────────────────────────────────────────────
  if (cmd === 'attendance') {
    if (parts.length === 1) return { intent: 'attendance' };
    if (parts.length === 2 && isE164(parts[1] ?? '')) {
      return { intent: 'attendance', studentPhone: parts[1] };
    }
  }

  // ── fees [<phone>] ──────────────────────────────────────────────────────
  if (cmd === 'fees') {
    if (parts.length === 1) return { intent: 'fees' };
    if (parts.length === 2 && isE164(parts[1] ?? '')) {
      return { intent: 'fees', studentPhone: parts[1] };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// buildInitialContext — synchronous structured parse
// ---------------------------------------------------------------------------

export type RouterEvent = {
  message: string;
  user: string;   // sender phone E.164
};

export function buildInitialContext(
  event: RouterEvent,
  config: TuitionConfig,
): ExecutionContext {
  const text       = event.message?.trim() ?? '';
  const structured = parseIntent(text);
  const needsAI    = !structured && config.mode === 'ai';
  const validInput = !!structured || needsAI;

  return {
    event,
    state: {
      config,
      structured,
      needsAI,
      validInput,
    },
  };
}

// ---------------------------------------------------------------------------
// resolveRouting — called by handler AFTER runFlow()
// ---------------------------------------------------------------------------

const INTENT_TO_FLOW: Record<string, NonNullable<RoutingDecision>['nextFlow']> = {
  present:    'mark-attendance',
  absent:     'mark-attendance',
  paid:       'record-payment',
  attendance: 'query-attendance',
  fees:       'query-fees',
};

export function resolveRouting(ctx: ExecutionContext): RoutingDecision {
  // Structured path
  const structured = ctx.state?.['structured'] as ParsedIntent | null;
  if (structured) {
    const nextFlow = INTENT_TO_FLOW[structured.intent];
    if (!nextFlow) return null;
    return { nextFlow, parsed: structured };
  }

  // AI path — use classification label
  const classifyOut = ctx.outputs?.['classify-intent'] as { label?: string } | undefined;
  const intentLabel = classifyOut?.label?.toLowerCase() ?? '';
  const nextFlow    = INTENT_TO_FLOW[intentLabel];
  if (!nextFlow) return null;

  return { nextFlow, parsed: { intent: intentLabel as ParsedIntent['intent'] } };
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const intentRouterFlow: Flow = {
  id: 'intent-router',
  steps: [

    // Step 1: AI classify — only when structured parse failed + mode=ai
    {
      id: 'classify-intent',
      type: 'intelligence',
      condition: (ctx: ExecutionContext) => !!ctx.state?.['needsAI'],
      input: (ctx: ExecutionContext) => ({
        provider: (ctx.state?.['config'] as TuitionConfig).aiProvider,
        task: 'classification',
        input: { text: (ctx.event as RouterEvent).message ?? '' },
        options: { categories: ['present', 'absent', 'paid', 'attendance', 'fees', 'unknown'] },
      }),
    },

    // Step 2: Send help message — only when structured parse failed + structured mode
    {
      id: 'send-invalid',
      type: 'communication',
      condition: (ctx: ExecutionContext) => !ctx.state?.['validInput'],
      input: (ctx: ExecutionContext) => ({
        to:      (ctx.event as RouterEvent).user,
        message: [
          'Commands:',
          '  present +<phone>',
          '  absent +<phone>',
          '  paid +<phone> <amount>',
          '  attendance',
          '  attendance +<phone>',
          '  fees',
          '  fees +<phone>',
        ].join('\n'),
        provider: 'meta',
      }),
    },

  ],
};
