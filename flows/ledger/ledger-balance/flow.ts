import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';

export type LedgerBalanceEvent = {
  phone_number: string;
  config: {
    sheetId: string;
    ownerPhone: string;
  };
};

export function buildInitialContext(event: LedgerBalanceEvent): { ok: true; context: ExecutionContext } {
  return {
    ok: true,
    context: {
      event,
      state: {
        config: event.config,
        user: event.phone_number,
      },
    },
  };
}

export const ledgerBalanceFlow: Flow = {
  id: 'ledger-balance',
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
      id: 'send-balance',
      type: 'communication',
      input: (ctx: ExecutionContext) => {
        const output = ctx.outputs?.['read-sheet'] as { rows?: Record<string, string>[] } | undefined;
        const rows = output?.rows ?? [];

        let credits = 0;
        let debits = 0;

        for (const row of rows) {
          const amount = parseFloat(row['Amount'] ?? '0');
          if (!isNaN(amount)) {
            if (row['Type'] === 'credit') credits += amount;
            else if (row['Type'] === 'debit') debits += amount;
          }
        }

        const balance = credits - debits;
        const sign = balance >= 0 ? '+' : '';

        return {
          to: ctx.event?.phone_number,
          message: [
            'Balance Summary',
            '',
            `Credits : ${credits.toFixed(2)}`,
            `Debits  : ${debits.toFixed(2)}`,
            `Balance : ${sign}${balance.toFixed(2)}`,
          ].join('\n'),
        };
      },
    },
  ],
};
