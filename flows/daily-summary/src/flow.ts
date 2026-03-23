import type { Flow, ExecutionContext } from 'engine-module';

// Each sheet row: [date, mine, labor, machineA, machineB, output_tons, material, reported_at, phone]
// Indices used:    [0]    [1]   [2]    [3]       [4]       [5]          [6]       [7]           [8]
//
// The sheets transformer treats the first sheet row as a header when all cells are non-empty.
// Since the daily-reporting flow writes no explicit header row, the first data row is consumed as
// the header and the transformer returns Record<string, string>[] keyed by those values — losing
// that row. normalizeRows() detects this case, reconstructs the first row from the object keys,
// and prepends it back so no data row is lost.

type Row = string[] | Record<string, string>;

function normalizeRows(rows: Row[]): string[][] {
  if (rows.length === 0) return [];

  // string[][] path — no transformation needed
  if (Array.isArray(rows[0])) return rows as string[][];

  // Record[] path — first data row was consumed as a header; its values are now the keys
  const reconstructedFirstRow = Object.keys(rows[0] as Record<string, string>);
  return [reconstructedFirstRow, ...(rows as Record<string, string>[]).map(r => Object.values(r))];
}

function buildSummaryMessage(rows: Row[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const normalized = normalizeRows(rows);

  const summary: Record<string, { labor: number; output: number }> = {};
  let hasData = false;

  for (const row of normalized) {
    if (row[0] !== today) continue;
    hasData = true;

    const mine = row[1];
    if (!mine) continue;

    const toNumber = (v: unknown) => Number(v) || 0;
    if (!summary[mine]) summary[mine] = { labor: 0, output: 0 };
    summary[mine].labor  += toNumber(row[2]);
    summary[mine].output += toNumber(row[5]);
  }

  if (!hasData) return 'No reports received today.';

  const lines: string[] = ['📊 Daily Summary'];
  let totalOutput = 0;

  for (const [mine, data] of Object.entries(summary)) {
    totalOutput += data.output;
    lines.push('');
    lines.push(`${mine}:`);
    lines.push(`Labor: ${data.labor}`);
    lines.push(`Output: ${data.output} tons`);
  }

  lines.push('');
  lines.push(`Total Output: ${totalOutput} tons`);

  return lines.join('\n');
}

export const dailySummaryFlow: Flow = {
  id: 'daily-summary',
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
      id: 'send-summary',
      type: 'communication',
      input: (ctx: ExecutionContext) => {
        if (!ctx.state?.config) throw new Error('Missing config in context');
        const config = ctx.state.config as { ownerPhone: string };
        const data = ctx.outputs?.['fetch-reports'] as { rows: Row[] } | undefined;
        const rows = data?.rows ?? [];
        const message = buildSummaryMessage(rows);
        return {
          to: config.ownerPhone,
          message,
        };
      },
    },
  ],
};
