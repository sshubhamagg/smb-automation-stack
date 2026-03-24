// ============================================================
// Flow: intent-router
//
// Responsibilities:
//   - Deterministic structured parse of inbound WhatsApp message
//   - Optional AI classify + extract when structured parse fails (AI mode)
//   - Expose resolveRouting() for handler to pick the correct sub-flow
//
// Supported commands:
//   assign <phone> <description> [by YYYY-MM-DD]
//   status [<phone>]
//   done <taskId>
//   cancel <taskId>
//
// Steps:
//   1. classify-intent  — intelligence, condition: parse failed + AI mode
//   2. extract-fields   — intelligence, condition: AI classified as 'assign'
//   3. send-invalid     — communication, condition: no valid intent found
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { PlannerConfig, ParsedIntent, RoutingDecision } from '../src/types';

// ---------------------------------------------------------------------------
// Structured parser — pure, non-throwing
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isE164(phone: string): boolean {
  return /^\+\d{7,15}$/.test(phone);
}

function isDateLike(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseIntent(text: string): ParsedIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  const cmd   = parts[0]?.toLowerCase() ?? '';

  // ── assign <phone> <description...> [by YYYY-MM-DD] ────────────────────
  if (cmd === 'assign') {
    if (parts.length < 3) return null;
    const vendorPhone = parts[1];
    if (!isE164(vendorPhone)) return null;

    // Find "by <YYYY-MM-DD>" at the end
    let deadline: string | undefined;
    let descEnd = parts.length;

    if (
      parts.length >= 4 &&
      parts[parts.length - 2]?.toLowerCase() === 'by' &&
      isDateLike(parts[parts.length - 1] ?? '')
    ) {
      deadline = parts[parts.length - 1];
      descEnd  = parts.length - 2;
    }

    const taskDescription = parts.slice(2, descEnd).join(' ').trim();
    if (!taskDescription) return null;

    return { intent: 'assign', vendorPhone, taskDescription, deadline };
  }

  // ── status [<phone>] ────────────────────────────────────────────────────
  if (cmd === 'status') {
    if (parts.length === 1) return { intent: 'status' };
    if (parts.length === 2 && isE164(parts[1] ?? '')) {
      return { intent: 'status', vendorPhone: parts[1] };
    }
    return null;
  }

  // ── done <taskId> ───────────────────────────────────────────────────────
  if (cmd === 'done' && parts.length === 2 && (parts[1] ?? '').startsWith('EVT-')) {
    return { intent: 'done', taskId: parts[1] };
  }

  // ── cancel <taskId> ─────────────────────────────────────────────────────
  if (cmd === 'cancel' && parts.length === 2 && (parts[1] ?? '').startsWith('EVT-')) {
    return { intent: 'cancel', taskId: parts[1] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Normalize AI extraction output → ParsedIntent for 'assign'
// ---------------------------------------------------------------------------

function normalizeAIAssign(
  fields: Record<string, string | null>,
): ParsedIntent | null {
  const vendorPhone = (fields['vendor_phone'] ?? '').trim();
  if (!isE164(vendorPhone)) return null;

  const taskDescription = (fields['task'] ?? '').trim();
  if (!taskDescription) return null;

  const rawDeadline = (fields['deadline'] ?? '').trim();
  const deadline    = isDateLike(rawDeadline) ? rawDeadline : undefined;

  return { intent: 'assign', vendorPhone, taskDescription, deadline };
}

// ---------------------------------------------------------------------------
// buildInitialContext — synchronous structured parse
// ---------------------------------------------------------------------------

export type RouterEvent = {
  message: string;
  user: string;  // sender phone E.164
};

export function buildInitialContext(
  event: RouterEvent,
  config: PlannerConfig,
): ExecutionContext {
  const text       = event.message?.trim() ?? '';
  const structured = parseIntent(text);
  const needsAI    = !structured && config.mode === 'ai';
  const validInput = !!structured || needsAI;

  return {
    event,
    state: {
      config,
      structured,   // ParsedIntent | null — used by resolveRouting()
      needsAI,      // true → run AI steps
      validInput,   // false → send-invalid fires
    },
  };
}

// ---------------------------------------------------------------------------
// resolveRouting — called by handler AFTER runFlow()
// ---------------------------------------------------------------------------

const INTENT_TO_FLOW: Record<string, NonNullable<RoutingDecision>['nextFlow']> = {
  assign: 'task-assign',
  status: 'task-status',
  done:   'task-complete',
  cancel: 'task-cancel',
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

  if (!intentLabel || !INTENT_TO_FLOW[intentLabel]) return null;

  if (intentLabel === 'assign') {
    const extractOut = ctx.outputs?.['extract-fields'] as
      | { fields?: Record<string, string | null> }
      | undefined;
    const parsed = normalizeAIAssign(extractOut?.fields ?? {});
    if (!parsed) return null;
    return { nextFlow: 'task-assign', parsed };
  }

  // status / done / cancel — no fields needed from AI for these
  const event      = ctx.event as RouterEvent;
  const intentText = event?.message?.trim() ?? '';
  const fallback   = parseIntent(intentText);
  if (fallback) {
    const nextFlow = INTENT_TO_FLOW[fallback.intent];
    if (!nextFlow) return null;
    return { nextFlow, parsed: fallback };
  }

  return null;
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
        provider: (ctx.state?.['config'] as PlannerConfig).aiProvider,
        task: 'classification',
        input: { text: (ctx.event as RouterEvent).message ?? '' },
        options: { categories: ['assign', 'status', 'done', 'cancel', 'unknown'] },
      }),
    },

    // Step 2: AI extract fields — only when AI classified as 'assign'
    {
      id: 'extract-fields',
      type: 'intelligence',
      condition: (ctx: ExecutionContext) => {
        if (!ctx.state?.['needsAI']) return false;
        const c = ctx.outputs?.['classify-intent'] as { label?: string } | undefined;
        return c?.label?.toLowerCase() === 'assign';
      },
      input: (ctx: ExecutionContext) => ({
        provider: (ctx.state?.['config'] as PlannerConfig).aiProvider,
        task: 'extraction',
        input: { text: (ctx.event as RouterEvent).message ?? '' },
        options: { fields: ['vendor_phone', 'task', 'deadline', 'category'] },
      }),
    },

    // Step 3: Send help message — only when nothing matched
    {
      id: 'send-invalid',
      type: 'communication',
      condition: (ctx: ExecutionContext) => !ctx.state?.['validInput'],
      input: (ctx: ExecutionContext) => ({
        to:      (ctx.event as RouterEvent).user,
        message: [
          'Commands:',
          '  assign +<phone> <task> by YYYY-MM-DD',
          '  assign +<phone> <task>',
          '  status',
          '  status +<phone>',
          '  done EVT-xxxxx',
          '  cancel EVT-xxxxx',
        ].join('\n'),
        provider: 'meta',
      }),
    },

  ],
};
