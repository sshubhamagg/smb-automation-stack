// ============================================================
// Flow: query-fees
//
// Responsibilities:
//   - Read FEES sheet
//   - If studentPhone provided: show full fee history for that student (all months)
//   - Otherwise: show all students' fee status for current month
//   - Format summary and send to teacher
//
// buildInitialContext():
//   - Computes current month (YYYY-MM) for filtering
//
// Steps:
//   1. read-fees   — storage read (FEES)
//   2. send-fees   — communication (filtering + formatting in input())
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { TuitionConfig, ParsedIntent } from '../src/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueryFeesEvent = {
  phone_number: string;   // teacher's phone
};

export type QueryFeesState = {
  config: TuitionConfig;
  parsed: ParsedIntent;
  month: string;   // YYYY-MM — current month
};

type FeeRow = Record<string, string>;

// ---------------------------------------------------------------------------
// buildInitialContext
// ---------------------------------------------------------------------------

export function buildInitialContext(
  event: QueryFeesEvent,
  parsed: ParsedIntent,
  config: TuitionConfig,
): ExecutionContext {
  const now  = new Date();
  const year = now.getFullYear();
  const mon  = String(now.getMonth() + 1).padStart(2, '0');

  return {
    event,
    state: {
      config,
      parsed,
      month: `${year}-${mon}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers (pure, non-throwing)
// ---------------------------------------------------------------------------

function getState(ctx: ExecutionContext): QueryFeesState {
  return ctx.state as QueryFeesState;
}

function getFeeRows(ctx: ExecutionContext): FeeRow[] {
  const out = ctx.outputs?.['read-fees'] as { rows?: FeeRow[] } | undefined;
  return out?.rows ?? [];
}

function formatMonthLabel(month: string): string {
  const [year, mon] = month.split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const idx = parseInt(mon ?? '1') - 1;
  return `${names[idx] ?? mon} ${year}`;
}

function statusEmoji(status: string): string {
  if (status === 'PAID')    return '✅';
  if (status === 'PARTIAL') return '⚠️ ';
  if (status === 'UNPAID')  return '🔴';
  return '  ';
}

function formatFeesSummary(
  rows: FeeRow[],
  month: string,
  studentPhone?: string,
): string {
  if (studentPhone) {
    // Full history for one student (all months)
    const studentRows = rows.filter(
      r => (r['Student Phone'] ?? '').trim() === studentPhone.trim(),
    );
    if (studentRows.length === 0) {
      return `No fee records found for ${studentPhone}`;
    }
    const name  = studentRows[0]?.['Name'] ?? studentPhone;
    const lines = [`Fees — ${name} (${studentPhone})`];
    for (const r of studentRows) {
      const label    = formatMonthLabel(r['Month'] ?? '');
      const due      = r['Amount Due']  ?? '0';
      const paid     = r['Amount Paid'] ?? '0';
      const status   = r['Status']      ?? '';
      lines.push(`${label} : ₹${due} ${status}`);
      if (status === 'PARTIAL') {
        const balance = Math.max(0, parseFloat(due) - parseFloat(paid));
        lines[lines.length - 1] += ` (₹${balance} remaining)`;
      }
    }
    return lines.join('\n');
  }

  // All students for current month
  const monthRows = rows.filter(r => (r['Month'] ?? '').trim() === month);
  if (monthRows.length === 0) {
    return `No fee records found for ${formatMonthLabel(month)}`;
  }

  const lines = [`Fees — ${formatMonthLabel(month)}`];
  for (const r of monthRows) {
    const name   = (r['Name'] ?? r['Student Phone'] ?? '').padEnd(12);
    const due    = r['Amount Due']  ?? '0';
    const paid   = r['Amount Paid'] ?? '0';
    const status = r['Status']      ?? 'UNPAID';
    const emoji  = statusEmoji(status);
    let line = `${emoji} ${name}: ₹${due} ${status}`;
    if (status === 'PARTIAL') {
      const balance = Math.max(0, parseFloat(due) - parseFloat(paid));
      line += ` (₹${balance} remaining)`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const queryFeesFlow: Flow = {
  id: 'query-fees',
  steps: [

    // Step 1: Read full FEES sheet
    {
      id: 'read-fees',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider:  'sheets',
        operation: 'read',
        resource:  getState(ctx).config.feesSheetId,
        options:   { range: 'FEES' },
      }),
    },

    // Step 2: Filter, format, and send summary to teacher
    {
      id: 'send-fees',
      type: 'communication',
      input: (ctx: ExecutionContext) => {
        const s    = getState(ctx);
        const rows = getFeeRows(ctx);
        return {
          to:      s.config.teacherPhone,
          message: formatFeesSummary(rows, s.month, s.parsed.studentPhone),
          provider: 'meta',
        };
      },
    },

  ],
};
