import type { Flow, ExecutionContext } from 'engine-module';

// Each sheet row: [date, mine, labor, machineA, machineB, output_tons, material, reported_at, phone]
// Indices used:    [0]    [1]
//
// Same transformer caveat as daily-summary: the sheets module treats the first sheet row as a header
// when all cells are non-empty, consuming it. normalizeRows() reconstructs it from object keys.

type Row = string[] | Record<string, string>;

function normalizeRows(rows: Row[]): string[][] {
  if (rows.length === 0) return [];
  if (Array.isArray(rows[0])) return rows as string[][];
  const reconstructedFirstRow = Object.keys(rows[0] as Record<string, string>);
  return [reconstructedFirstRow, ...(rows as Record<string, string>[]).map(r => Object.values(r))];
}

function getMissingMines(ctx: ExecutionContext): string[] {
  if (!ctx.state?.config) throw new Error('Missing config in context');
  const managers = (ctx.state.config as { managers: Record<string, string[]> }).managers;
  const allMines = new Set(Object.values(managers).flat());

  const data = ctx.outputs?.['fetch-reports'] as { rows: Row[] } | undefined;
  const normalized = normalizeRows(data?.rows ?? []);
  const today = new Date().toISOString().slice(0, 10);

  const submittedMines = new Set<string>();
  for (const row of normalized) {
    if (row[0] === today && row[1]) {
      submittedMines.add(row[1]);
    }
  }

  return [...allMines].filter(mine => !submittedMines.has(mine));
}

export const missedReportsFlow: Flow = {
  id: 'missed-reports',
  steps: [
    {
      id: 'fetch-reports',
      type: 'storage',
      input: (ctx: ExecutionContext) => {
        if (!ctx.state?.config) throw new Error('Missing config in context');
        const config = ctx.state.config as { sheetId: string };
        return {
          provider: 'sheets',
          operation: 'read',
          resource: config.sheetId,
          options: { range: 'Sheet1' },
        };
      },
    },
    {
      id: 'send-missing-report',
      type: 'communication',
      condition: (ctx: ExecutionContext) => getMissingMines(ctx).length > 0,
      input: (ctx: ExecutionContext) => {
        const missing = getMissingMines(ctx);
        const message = `⚠️ Missing Reports\n\n${missing.join('\n')}`;
        if (!ctx.state?.config) throw new Error('Missing config in context');
        const config = ctx.state.config as { ownerPhone: string };
        return {
          to: config.ownerPhone,
          message,
        };
      },
    },
  ],
};
