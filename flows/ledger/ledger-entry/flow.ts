import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';

export type LedgerEntryEvent = {
  phone_number: string;
  text_body?: string;
  config: {
    sheetId: string;
    ownerPhone: string;
  };
};

type ParsedEntry = {
  type: 'credit' | 'debit';
  amount: number;
  party: string;
  category?: string;
  date: string;
  user: string;
};

export type BuildContextResult =
  | { ok: true; context: ExecutionContext }
  | { ok: false; reason: 'invalid_format' };

function parseAddCommand(text: string, user: string): ParsedEntry | null {
  const parts = text.trim().split(/\s+/);
  // Expected: add <credit|debit> <amount> <party> [category]
  if (parts.length < 4) return null;
  if (parts[0].toLowerCase() !== 'add') return null;

  const type = parts[1].toLowerCase();
  if (type !== 'credit' && type !== 'debit') return null;

  const amount = parseFloat(parts[2]);
  if (isNaN(amount) || amount <= 0) return null;

  const party = parts[3];
  const category = parts[4];
  const date = new Date().toISOString().slice(0, 10);

  return { type: type as 'credit' | 'debit', amount, party, category, date, user };
}

export function buildInitialContext(event: LedgerEntryEvent): BuildContextResult {
  const parsed = event.text_body ? parseAddCommand(event.text_body, event.phone_number) : null;

  if (!parsed) {
    return { ok: false, reason: 'invalid_format' };
  }

  return {
    ok: true,
    context: {
      event,
      state: {
        config: event.config,
        parsed,
      },
    },
  };
}

export const ledgerEntryFlow: Flow = {
  id: 'ledger-entry',
  steps: [
    // Step 1: Check for duplicate (same type + amount + party + user on any date)
    {
      id: 'check-duplicate',
      type: 'storage',
      input: (ctx: ExecutionContext) => {
        const p = ctx.state?.['parsed'] as ParsedEntry;
        return {
          provider: 'sheets',
          operation: 'query',
          resource: ctx.state?.['config']?.sheetId,
          query: {
            Type: p.type,
            Amount: String(p.amount),
            Party: p.party,
            User: p.user,
          },
          options: { range: 'Ledger' },
        };
      },
    },

    // Step 2: Write row only if no duplicate found
    {
      id: 'write-to-sheet',
      type: 'storage',
      condition: (ctx: ExecutionContext) => {
        const result = ctx.outputs?.['check-duplicate'] as { rows?: Record<string, string>[] } | undefined;
        return (result?.rows?.length ?? 0) === 0;
      },
      input: (ctx: ExecutionContext) => {
        const p = ctx.state?.['parsed'] as ParsedEntry;
        return {
          provider: 'sheets',
          operation: 'write',
          resource: ctx.state?.['config']?.sheetId,
          data: [p.date, p.type, String(p.amount), p.party, p.category ?? '', p.user],
          options: { range: 'Ledger' },
        };
      },
    },

    // Step 3: Confirm success
    {
      id: 'send-success',
      type: 'communication',
      condition: (ctx: ExecutionContext) => {
        const result = ctx.outputs?.['check-duplicate'] as { rows?: Record<string, string>[] } | undefined;
        return (result?.rows?.length ?? 0) === 0;
      },
      input: (ctx: ExecutionContext) => {
        const p = ctx.state?.['parsed'] as ParsedEntry;
        const label = p.type === 'credit' ? 'Credit' : 'Debit';
        const detail = p.category ? `\nCategory: ${p.category}` : '';
        return {
          to: ctx.event?.phone_number,
          message: `Entry recorded.\n${label}: ${p.amount}\nParty: ${p.party}${detail}\nDate: ${p.date}`,
        };
      },
    },

    // Step 4: Warn if duplicate was detected
    {
      id: 'send-duplicate-warning',
      type: 'communication',
      condition: (ctx: ExecutionContext) => {
        const result = ctx.outputs?.['check-duplicate'] as { rows?: Record<string, string>[] } | undefined;
        return (result?.rows?.length ?? 0) > 0;
      },
      input: (ctx: ExecutionContext) => {
        const p = ctx.state?.['parsed'] as ParsedEntry;
        return {
          to: ctx.event?.phone_number,
          message: `Duplicate entry skipped.\nA ${p.type} of ${p.amount} for ${p.party} already exists.`,
        };
      },
    },
  ],
};
