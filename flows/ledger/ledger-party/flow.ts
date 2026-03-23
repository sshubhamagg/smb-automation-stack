import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';

export type LedgerPartyEvent = {
  phone_number: string;
  party: string;
  config: {
    sheetId: string;
    ownerPhone: string;
  };
};

export function buildInitialContext(event: LedgerPartyEvent): { ok: true; context: ExecutionContext } {
  return {
    ok: true,
    context: {
      event,
      state: {
        config: event.config,
        party: event.party,
      },
    },
  };
}

export const ledgerPartyFlow: Flow = {
  id: 'ledger-party',
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
      id: 'send-party-ledger',
      type: 'communication',
      input: (ctx: ExecutionContext) => {
        const output = ctx.outputs?.['read-sheet'] as { rows?: Record<string, string>[] } | undefined;
        const allRows = output?.rows ?? [];
        const party = ctx.state?.['party'] as string ?? '';
        const partyLower = party.toLowerCase();

        const rows = allRows.filter(r =>
          (r['Party'] ?? '').toLowerCase() === partyLower &&
          (r['Type'] === 'credit' || r['Type'] === 'debit'),
        );

        if (rows.length === 0) {
          return {
            to: ctx.event?.phone_number,
            message: `No transactions found for: ${party}`,
          };
        }

        let credits = 0;
        let debits = 0;
        const lines: string[] = [];

        for (const row of rows) {
          const amount = parseFloat(row['Amount'] ?? '0');
          if (isNaN(amount)) continue;

          if (row['Type'] === 'credit') {
            credits += amount;
            lines.push(`+ ${amount.toFixed(2)}  ${row['Date'] ?? ''}`);
          } else {
            debits += amount;
            lines.push(`- ${amount.toFixed(2)}  ${row['Date'] ?? ''}`);
          }
        }

        const net = credits - debits;
        const sign = net >= 0 ? '+' : '';

        return {
          to: ctx.event?.phone_number,
          message: [
            `Ledger: ${party}`,
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
