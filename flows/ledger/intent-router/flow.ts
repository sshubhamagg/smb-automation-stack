import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';

// ---------------------------------------------------------------------------
// Config / Event / Payload types
// ---------------------------------------------------------------------------

export type RouterConfig = {
  mode: 'structured' | 'ai';
  aiProvider: 'openai' | 'anthropic' | 'local' | 'nvidia';
  ownerPhone: string;
};

export type RouterPayload = {
  command: 'add' | 'balance' | 'summary' | 'ledger' | 'delete';
  type?: 'credit' | 'debit';
  amount?: number;
  party?: string;
  category?: string;
  user: string;
  date: string;
};

export type RouterEvent = {
  message: string;
  user: string;
};

export type RoutingDecision = {
  nextFlow: string;
  payload: RouterPayload;
} | null;

// ---------------------------------------------------------------------------
// Internal helpers — all pure, no I/O
// ---------------------------------------------------------------------------

const FLOW_MAP: Record<string, string> = {
  add:     'ledger-entry',
  balance: 'ledger-balance',
  summary: 'ledger-summary',
  ledger:  'ledger-party',
  delete:  'ledger-delete',
};

const VALID_COMMANDS = new Set(['add', 'balance', 'summary', 'ledger', 'delete']);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseAmount(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (s.endsWith('k')) {
    const n = parseFloat(s.slice(0, -1));
    return isNaN(n) || n <= 0 ? null : n * 1000;
  }
  const n = parseFloat(s);
  return isNaN(n) || n <= 0 ? null : n;
}

function normalizeType(raw: string): 'credit' | 'debit' | null {
  const t = raw.trim().toLowerCase();
  if (t === 'credit' || t === 'received' || t === 'got') return 'credit';
  if (t === 'debit'  || t === 'paid'     || t === 'gave') return 'debit';
  return null;
}

// Deterministic structured parser — returns null if message doesn't match any command.
function detectStructured(text: string, user: string): RouterPayload | null {
  const lower = text.toLowerCase().trim();
  const date  = today();

  if (lower === 'balance') {
    return { command: 'balance', user, date };
  }

  if (lower.startsWith('summary')) {
    return { command: 'summary', user, date };
  }

  if (lower === 'delete last') {
    return { command: 'delete', user, date };
  }

  if (lower.startsWith('ledger ')) {
    const party = text.slice('ledger '.length).trim();
    if (!party) return null;
    return { command: 'ledger', party, user, date };
  }

  if (lower.startsWith('add ')) {
    // Expected: add <credit|debit> <amount> <party> [category]
    const parts = text.trim().split(/\s+/);
    if (parts.length < 4) return null;
    const type = normalizeType(parts[1]);
    if (!type) return null;
    const amount = parseAmount(parts[2]);
    if (!amount) return null;
    const party    = parts[3];
    const category = parts[4] ?? (type === 'debit' ? 'expense' : 'income');
    return { command: 'add', type, amount, party, category, user, date };
  }

  return null;
}

// Normalize AI extraction output into a RouterPayload for 'add' commands.
function normalizeAIAddPayload(
  fields: Record<string, string | null>,
  user: string,
): RouterPayload | null {
  const type = normalizeType(fields['type'] ?? '');
  if (!type) return null;

  const amount = parseAmount(fields['amount'] ?? '');
  if (!amount) return null;

  const party = (fields['party'] ?? '').trim();
  if (!party) return null;

  const raw      = (fields['category'] ?? '').trim();
  const category = raw || (type === 'debit' ? 'expense' : 'income');

  return { command: 'add', type, amount, party, category, user, date: today() };
}

// ---------------------------------------------------------------------------
// buildInitialContext — all synchronous, no I/O
// ---------------------------------------------------------------------------

export function buildInitialContext(event: RouterEvent, config: RouterConfig): ExecutionContext {
  const text       = event.message?.trim() ?? '';
  const structured = detectStructured(text, event.user);

  // Always try structured first. If it matches, bypass AI regardless of mode.
  const needsAI  = !structured && config.mode === 'ai';
  const validInput = !!structured || needsAI;

  return {
    event,
    state: {
      config,
      structured,   // RouterPayload | null
      needsAI,      // true → run AI classify + extract steps
      validInput,   // false → send-invalid step fires
    },
  };
}

// ---------------------------------------------------------------------------
// resolveRouting — called by handler AFTER runFlow completes
// Reads ctx.outputs (AI path) or ctx.state.structured (structured path).
// ---------------------------------------------------------------------------

export function resolveRouting(ctx: ExecutionContext): RoutingDecision {
  // Structured path (or structured message detected even in ai mode)
  const structured = ctx.state?.['structured'] as RouterPayload | null;
  if (structured) {
    const nextFlow = FLOW_MAP[structured.command];
    if (!nextFlow) return null;
    return { nextFlow, payload: structured };
  }

  // AI path
  const classifyOut = ctx.outputs?.['classify-intent'] as { label?: string } | undefined;
  const command     = (classifyOut?.label ?? '').toLowerCase();
  if (!command || !VALID_COMMANDS.has(command)) return null;

  const user = (ctx.event?.['user'] as string | undefined) ?? '';
  const date = today();

  if (command === 'add') {
    const extractOut = ctx.outputs?.['extract-transaction'] as
      | { fields?: Record<string, string | null> }
      | undefined;
    const payload = normalizeAIAddPayload(extractOut?.fields ?? {}, user);
    if (!payload) return null;
    return { nextFlow: 'ledger-entry', payload };
  }

  if (command === 'ledger') {
    // Best-effort: extract party from original message
    const text  = (ctx.event?.['message'] as string | undefined) ?? '';
    const lower = text.toLowerCase();
    const party = lower.startsWith('ledger ') ? text.slice('ledger '.length).trim() : '';
    if (!party) return null;
    return { nextFlow: 'ledger-party', payload: { command: 'ledger', party, user, date } };
  }

  return {
    nextFlow: FLOW_MAP[command],
    payload:  { command: command as RouterPayload['command'], user, date },
  };
}

// ---------------------------------------------------------------------------
// intentRouterFlow
// Only does AI I/O — no storage writes, no success messages.
// ---------------------------------------------------------------------------

export const intentRouterFlow: Flow = {
  id: 'intent-router',
  steps: [

    // Step 1: AI classification — only if mode=ai and message didn't match structured commands
    {
      id: 'classify-intent',
      type: 'intelligence',
      condition: (ctx: ExecutionContext) => !!ctx.state?.['needsAI'],
      input: (ctx: ExecutionContext) => ({
        provider: ctx.state?.['config']?.aiProvider ?? 'anthropic',
        task: 'classification',
        input: { text: ctx.event?.['message'] ?? '' },
        options: { categories: ['add', 'balance', 'summary', 'ledger', 'delete'] },
      }),
    },

    // Step 2: AI extraction — only if AI mode AND classify returned 'add'
    {
      id: 'extract-transaction',
      type: 'intelligence',
      condition: (ctx: ExecutionContext) => {
        if (!ctx.state?.['needsAI']) return false;
        const classify = ctx.outputs?.['classify-intent'] as { label?: string } | undefined;
        return classify?.label?.toLowerCase() === 'add';
      },
      input: (ctx: ExecutionContext) => ({
        provider: ctx.state?.['config']?.aiProvider ?? 'anthropic',
        task: 'extraction',
        input: { text: ctx.event?.['message'] ?? '' },
        options: { fields: ['type', 'amount', 'party', 'category'] },
      }),
    },

    // Step 3: Send help — only if structured mode and message didn't match any command
    {
      id: 'send-invalid',
      type: 'communication',
      condition: (ctx: ExecutionContext) => !ctx.state?.['validInput'],
      input: (ctx: ExecutionContext) => ({
        to: ctx.event?.['user'] ?? '',
        message: [
          'Invalid input. Try:',
          '  add credit 5000 rahul',
          '  add debit 1200 groceries',
          '  balance',
          '  summary today',
          '  ledger rahul',
          '  delete last',
        ].join('\n'),
      }),
    },

  ],
};
