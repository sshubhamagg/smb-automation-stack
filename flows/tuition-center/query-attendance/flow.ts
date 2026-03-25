// ============================================================
// Flow: query-attendance
//
// Responsibilities:
//   - Read ATTENDANCE sheet
//   - Filter to current month (optionally by student phone)
//   - Format summary and send to teacher
//
// buildInitialContext():
//   - Computes current month (YYYY-MM) for filtering
//
// Steps:
//   1. read-attendance  — storage read (ATTENDANCE)
//   2. send-attendance  — communication (filtering + formatting in input())
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { TuitionConfig, ParsedIntent } from '../src/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueryAttendanceEvent = {
  phone_number: string;   // teacher's phone
};

export type QueryAttendanceState = {
  config: TuitionConfig;
  parsed: ParsedIntent;
  month: string;   // YYYY-MM — for filtering
};

type AttendanceRow = Record<string, string>;

// ---------------------------------------------------------------------------
// buildInitialContext
// ---------------------------------------------------------------------------

export function buildInitialContext(
  event: QueryAttendanceEvent,
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

function getState(ctx: ExecutionContext): QueryAttendanceState {
  return ctx.state as QueryAttendanceState;
}

function getAttendanceRows(ctx: ExecutionContext): AttendanceRow[] {
  const out = ctx.outputs?.['read-attendance'] as { rows?: AttendanceRow[] } | undefined;
  return out?.rows ?? [];
}

function formatMonthLabel(month: string): string {
  const [year, mon] = month.split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const idx = parseInt(mon ?? '1') - 1;
  return `${names[idx] ?? mon} ${year}`;
}

function formatAttendanceSummary(
  rows: AttendanceRow[],
  month: string,
  studentPhone?: string,
): string {
  const monthRows = rows.filter(r => (r['Date'] ?? '').startsWith(month));

  if (studentPhone) {
    const studentRows = monthRows.filter(
      r => (r['Student Phone'] ?? '').trim() === studentPhone.trim(),
    );
    if (studentRows.length === 0) {
      return `No attendance records found for ${studentPhone} in ${formatMonthLabel(month)}`;
    }
    const name    = studentRows[0]?.['Name'] ?? studentPhone;
    const present = studentRows.filter(r => r['Status'] === 'PRESENT').length;
    const absent  = studentRows.filter(r => r['Status'] === 'ABSENT').length;
    return [
      `Attendance — ${name} (${formatMonthLabel(month)})`,
      `Present : ${present}`,
      `Absent  : ${absent}`,
      `Total   : ${present + absent} sessions`,
    ].join('\n');
  }

  // All students summary
  if (monthRows.length === 0) {
    return `No attendance records found for ${formatMonthLabel(month)}`;
  }

  // Group by student phone
  const byStudent: Record<string, { name: string; present: number; absent: number }> = {};
  for (const r of monthRows) {
    const phone = r['Student Phone'] ?? '';
    if (!phone) continue;
    if (!byStudent[phone]) {
      byStudent[phone] = { name: r['Name'] ?? phone, present: 0, absent: 0 };
    }
    if (r['Status'] === 'PRESENT') {
      byStudent[phone].present++;
    } else {
      byStudent[phone].absent++;
    }
  }

  const lines = [`Attendance Summary — ${formatMonthLabel(month)}`];
  for (const s of Object.values(byStudent)) {
    lines.push(`${s.name.padEnd(12)}: ${s.present}P / ${s.absent}A`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const queryAttendanceFlow: Flow = {
  id: 'query-attendance',
  steps: [

    // Step 1: Read full ATTENDANCE sheet
    {
      id: 'read-attendance',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider:  'sheets',
        operation: 'read',
        resource:  getState(ctx).config.attendanceSheetId,
        options:   { range: 'ATTENDANCE' },
      }),
    },

    // Step 2: Filter, format, and send summary to teacher
    {
      id: 'send-attendance',
      type: 'communication',
      input: (ctx: ExecutionContext) => {
        const s    = getState(ctx);
        const rows = getAttendanceRows(ctx);
        return {
          to:      s.config.teacherPhone,
          message: formatAttendanceSummary(rows, s.month, s.parsed.studentPhone),
          provider: 'meta',
        };
      },
    },

  ],
};
