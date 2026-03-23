import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';

export type LedgerSummaryEvent = {
  phone_number: string;
  config: {
    sheetId: string;
    ownerPhone: string;
  };
};

export function buildInitialContext(event: LedgerSummaryEvent): { ok: true; context: ExecutionContext } {
  const today = new Date().toISOString().slice(0, 10);
  return {
    ok: true,
    context: {
      event,
      state: {
        config: event.config,
        user: event.phone_number,
        today,
      },
    },
  };
}

export const ledgerSummaryFlow: Flow = {
  id: 'ledger-summary',
  steps: [
    {
      id: 'read-sheet',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider: 'sheets',
        operation: 'read',
        resource: ctx.state?.['config']?.sheetId,
        options: { range: 'Ledger' },
      }),
    },

    {
      id: 'send-summary',
      type: 'communication',
      input: (ctx: ExecutionContext) => {
        const output = ctx.outputs?.['read-sheet'] as { rows?: Record<string, string>[] } | undefined;
        const allRows = output?.rows ?? [];
        const today = ctx.state?.['today'] as string;

        const todayRows = allRows.filter(r => r['Date'] === today);

        if (todayRows.length === 0) {
          return {
            to: ctx.event?.phone_number,
            message: `No transactions found for today (${today}).`,
          };
        }

        let credits = 0;
        let debits = 0;
        const lines: string[] = [];

        for (const row of todayRows) {
          const amount = parseFloat(row['Amount'] ?? '0');
          if (isNaN(amount)) continue;

          const party = row['Party'] ?? '?';
          const category = row['Category'] ? ` (${row['Category']})` : '';

          if (row['Type'] === 'credit') {
            credits += amount;
            lines.push(`+ ${amount.toFixed(2)}  ${party}${category}`);
          } else if (row['Type'] === 'debit') {
            debits += amount;
            lines.push(`- ${amount.toFixed(2)}  ${party}${category}`);
          }
        }

        const net = credits - debits;
        const sign = net >= 0 ? '+' : '';

        return {
          to: ctx.event?.phone_number,
          message: [
            `Summary: ${today}`,
            '',
            ...lines,
            '',
            `Credits : ${credits.toFixed(2)}`,
            `Debits  : ${debits.toFixed(2)}`,
            `Net     : ${sign}${net.toFixed(2)}`,
          ].join('\n'),
        };
      },
    },
  ],
};
