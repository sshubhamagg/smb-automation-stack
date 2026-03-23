import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';

export type LedgerDeleteEvent = {
  phone_number: string;
  config: {
    sheetId: string;
    ownerPhone: string;
  };
};

export function buildInitialContext(event: LedgerDeleteEvent): { ok: true; context: ExecutionContext } {
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

// Returns the 0-based index of the last row belonging to `user` in the rows array.
// Returns -1 if no such row exists.
function findLastUserRowIndex(rows: Record<string, string>[], user: string): number {
  let lastIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]['User'] === user) lastIndex = i;
  }
  return lastIndex;
}

export const ledgerDeleteFlow: Flow = {
  id: 'ledger-delete',
  steps: [
    // Step 1: Read all rows
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

    // Step 2: Overwrite last user row with blank data (soft delete)
    // rowIndex is 1-based excluding header: index in rows array + 1
    {
      id: 'overwrite-last-row',
      type: 'storage',
      condition: (ctx: ExecutionContext) => {
        const output = ctx.outputs?.['read-sheet'] as { rows?: Record<string, string>[] } | undefined;
        const rows = output?.rows ?? [];
        const user = ctx.state?.['user'] as string;
        return findLastUserRowIndex(rows, user) !== -1;
      },
      input: (ctx: ExecutionContext) => {
        const output = ctx.outputs?.['read-sheet'] as { rows?: Record<string, string>[] } | undefined;
        const rows = output?.rows ?? [];
        const user = ctx.state?.['user'] as string;
        const lastIndex = findLastUserRowIndex(rows, user);
        return {
          provider: 'sheets',
          operation: 'update',
          resource: ctx.state?.['config']?.sheetId,
          data: ['', '', '', '', '', ''],
          options: { range: 'Ledger', rowIndex: lastIndex + 1 },
        };
      },
    },

    // Step 3: Confirm deletion — runs only when overwrite-last-row ran (output is defined)
    {
      id: 'send-confirmation',
      type: 'communication',
      condition: (ctx: ExecutionContext) =>
        ctx.outputs?.['overwrite-last-row'] !== undefined,
      input: (ctx: ExecutionContext) => {
        const output = ctx.outputs?.['read-sheet'] as { rows?: Record<string, string>[] } | undefined;
        const rows = output?.rows ?? [];
        const user = ctx.state?.['user'] as string;
        const lastIndex = findLastUserRowIndex(rows, user);
        const row = rows[lastIndex];
        return {
          to: ctx.event?.phone_number,
          message: [
            'Last entry deleted.',
            `Type    : ${row['Type'] ?? ''}`,
            `Amount  : ${row['Amount'] ?? ''}`,
            `Party   : ${row['Party'] ?? ''}`,
            `Date    : ${row['Date'] ?? ''}`,
          ].join('\n'),
        };
      },
    },

    // Step 4: No entries found — runs only when overwrite-last-row was skipped
    {
      id: 'send-no-entries',
      type: 'communication',
      condition: (ctx: ExecutionContext) =>
        ctx.outputs?.['overwrite-last-row'] === undefined,
      input: (ctx: ExecutionContext) => ({
        to: ctx.event?.phone_number,
        message: 'No entries found to delete.',
      }),
    },
  ],
};
