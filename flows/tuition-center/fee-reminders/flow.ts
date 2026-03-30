// ============================================================
// Flow: fee-reminders
//
// Triggered by daily cron (09:00) or POST /run/reminders
//
// Responsibilities:
//   - Read FEES sheet for current month
//   - Classify fees as overdue (past due date) or due-soon (2 days before)
//   - Log summary of overdue and due-soon records to REMINDERS_LOG
//   - Send all-clear to teacher when no issues
//
// Engine constraint: no loop primitive — per-student WhatsApp messages are
// sent by the handler AFTER runFlow() completes (same pattern as init-fees).
//
// Steps:
//   1. read-fees           — storage read (FEES)
//   2. log-overdue         — storage write (REMINDERS_LOG), condition: overdue fees exist
//   3. log-due-soon        — storage write (REMINDERS_LOG), condition: due-soon fees exist
//   4. send-all-clear      — communication to teacher, condition: no overdue or due-soon
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { TuitionConfig } from '../src/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeeRemindersEvent = {
  triggeredAt: string;   // ISO timestamp
};

export type FeeRemindersState = {
  config: TuitionConfig;
  runDate: string;   // YYYY-MM-DD
  month: string;     // YYYY-MM
};

export type FeeRow = Record<string, string>;

// ---------------------------------------------------------------------------
// buildInitialContext
// ---------------------------------------------------------------------------

export function buildInitialContext(
  event: FeeRemindersEvent,
  config: TuitionConfig,
): ExecutionContext {
  const now     = new Date(event.triggeredAt ?? new Date().toISOString());
  const runDate = now.toISOString().slice(0, 10);
  const year    = now.getFullYear();
  const mon     = String(now.getMonth() + 1).padStart(2, '0');
  const month   = `${year}-${mon}`;

  return {
    event,
    state: { config, runDate, month },
  };
}

// ---------------------------------------------------------------------------
// Helpers (pure, non-throwing)
// ---------------------------------------------------------------------------

function getState(ctx: ExecutionContext): FeeRemindersState {
  return ctx.state as FeeRemindersState;
}

function getFeeRows(ctx: ExecutionContext): FeeRow[] {
  const out = ctx.outputs?.['read-fees'] as { rows?: FeeRow[] } | undefined;
  return out?.rows ?? [];
}

export function classifyFees(
  rows: FeeRow[],
  runDate: string,
  month: string,
): { overdue: FeeRow[]; dueSoon: FeeRow[] } {
  const overdue: FeeRow[] = [];
  const dueSoon: FeeRow[] = [];
  const todayMs = new Date(runDate).getTime();

  for (const row of rows) {
    if ((row['Month'] ?? '').trim() !== month) continue;

    const status = row['Status'] ?? '';
    if (status === 'PAID' || status === 'WAIVED') continue;
    if (status !== 'UNPAID' && status !== 'PARTIAL') continue;

    const dueDate = row['Due Date'] ?? '';
    if (!dueDate) continue;

    const dueDateMs = new Date(dueDate).getTime();
    if (isNaN(dueDateMs)) continue;

    const diffDays = (dueDateMs - todayMs) / (1000 * 60 * 60 * 24);

    if (todayMs > dueDateMs) {
      overdue.push(row);
    } else if (diffDays <= 2) {
      dueSoon.push(row);
    }
  }

  return { overdue, dueSoon };
}

function hasOverdue(ctx: ExecutionContext): boolean {
  const s = getState(ctx);
  return classifyFees(getFeeRows(ctx), s.runDate, s.month).overdue.length > 0;
}

function hasDueSoon(ctx: ExecutionContext): boolean {
  const s = getState(ctx);
  return classifyFees(getFeeRows(ctx), s.runDate, s.month).dueSoon.length > 0;
}

function hasNoIssues(ctx: ExecutionContext): boolean {
  return !hasOverdue(ctx) && !hasDueSoon(ctx);
}

function formatMonthLabel(month: string): string {
  const [year, mon] = month.split('-');
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const idx = parseInt(mon ?? '1') - 1;
  return `${names[idx] ?? mon} ${year}`;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const feeRemindersFlow: Flow = {
  id: 'fee-reminders',
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

    // Step 2: Log overdue summary to REMINDERS_LOG
    {
      id: 'log-overdue',
      type: 'storage',
      condition: hasOverdue,
      input: (ctx: ExecutionContext) => {
        const s        = getState(ctx);
        const { overdue } = classifyFees(getFeeRows(ctx), s.runDate, s.month);
        const phones   = overdue.map(r => r['Student Phone'] ?? '').join(', ');
        const message  = `OVERDUE: ${overdue.length} student(s) flagged`;
        return {
          provider:  'sheets',
          operation: 'write',
          resource:  s.config.remindersSheetId,
          data:      [s.runDate, phones, message, 'OVERDUE'],
          options:   { range: 'REMINDERS_LOG' },
        };
      },
    },

    // Step 3: Log due-soon summary to REMINDERS_LOG
    {
      id: 'log-due-soon',
      type: 'storage',
      condition: hasDueSoon,
      input: (ctx: ExecutionContext) => {
        const s         = getState(ctx);
        const { dueSoon } = classifyFees(getFeeRows(ctx), s.runDate, s.month);
        const phones    = dueSoon.map(r => r['Student Phone'] ?? '').join(', ');
        const message   = `DUE_SOON: ${dueSoon.length} student(s) flagged`;
        return {
          provider:  'sheets',
          operation: 'write',
          resource:  s.config.remindersSheetId,
          data:      [s.runDate, phones, message, 'DUE_SOON'],
          options:   { range: 'REMINDERS_LOG' },
        };
      },
    },

    // Step 4: Send all-clear to teacher when no issues
    {
      id: 'send-all-clear',
      type: 'communication',
      condition: hasNoIssues,
      input: (ctx: ExecutionContext) => {
        const s = getState(ctx);
        return {
          to:      s.config.teacherPhone,
          message: `✅ All fees on track for ${formatMonthLabel(s.month)} — no overdue or due-soon payments today.`,
          provider: 'meta',
        };
      },
    },

  ],
};
