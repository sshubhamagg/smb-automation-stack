// ============================================================
// Flow: reminder
//
// Triggered by daily cron (09:00) or POST /run/reminders
//
// Responsibilities:
//   - Read all tasks from TASKS sheet
//   - Filter to PENDING tasks only
//   - Classify each as: overdue | due-soon (≤48h) | upcoming
//   - Build a consolidated summary and send to planner
//   - Log each reminder sent to REMINDERS_LOG sheet
//
// Design decisions:
//   - Only overdue + due-soon tasks are surfaced in the summary
//   - One planner message covers all at-risk tasks (avoids per-vendor loop)
//   - Each reminder is logged as a separate write step — up to 3 rows max
//     (overdue summary, due-soon summary, upcoming count)
//   - Engine constraint: no dynamic step count → log at summary granularity
//
// Steps:
//   1. read-tasks          — storage read
//   2. send-reminder       — communication    (condition: any at-risk tasks)
//   3. log-overdue         — storage write    (condition: overdue tasks exist)
//   4. log-due-soon        — storage write    (condition: due-soon tasks exist)
//   5. send-all-clear      — communication    (condition: no at-risk tasks)
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { PlannerConfig } from '../src/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReminderEvent = {
  triggeredAt: string;   // ISO timestamp — from cron or manual trigger
};

export type ReminderState = {
  config: PlannerConfig;
  runDate: string;       // YYYY-MM-DD — used for deadline comparisons
};

type TaskRow = Record<string, string>;

// ---------------------------------------------------------------------------
// buildInitialContext
// ---------------------------------------------------------------------------

export function buildInitialContext(
  event: ReminderEvent,
  config: PlannerConfig,
): ExecutionContext {
  const runDate = (event.triggeredAt ?? new Date().toISOString()).slice(0, 10);
  return {
    event,
    state: { config, runDate },
  };
}

// ---------------------------------------------------------------------------
// Helpers (pure, non-throwing)
// ---------------------------------------------------------------------------

function getState(ctx: ExecutionContext): ReminderState {
  return ctx.state as ReminderState;
}

function getRows(ctx: ExecutionContext): TaskRow[] {
  const out = ctx.outputs?.['read-tasks'] as { rows?: TaskRow[] } | undefined;
  return out?.rows ?? [];
}

/** Hours until deadline from runDate. Negative = overdue. */
function hoursUntilDeadline(deadline: string, runDate: string): number {
  const deadlineMs = new Date(deadline).getTime();
  const runMs      = new Date(runDate).getTime();
  return (deadlineMs - runMs) / (1000 * 60 * 60);
}

function classifyTasks(
  rows: TaskRow[],
  runDate: string,
): { overdue: TaskRow[]; dueSoon: TaskRow[]; upcoming: TaskRow[] } {
  const overdue:  TaskRow[] = [];
  const dueSoon:  TaskRow[] = [];
  const upcoming: TaskRow[] = [];

  for (const row of rows) {
    if (row['Status'] !== 'PENDING') continue;
    const deadline = row['Deadline'] ?? '';
    if (!deadline) continue;

    const hours = hoursUntilDeadline(deadline, runDate);
    if (hours < 0) {
      overdue.push(row);
    } else if (hours <= 48) {
      dueSoon.push(row);
    } else {
      upcoming.push(row);
    }
  }

  return { overdue, dueSoon, upcoming };
}

function hasAtRisk(ctx: ExecutionContext): boolean {
  const { runDate } = getState(ctx);
  const { overdue, dueSoon } = classifyTasks(getRows(ctx), runDate);
  return overdue.length > 0 || dueSoon.length > 0;
}

function formatReminderMessage(
  overdue: TaskRow[],
  dueSoon: TaskRow[],
  upcoming: TaskRow[],
  eventName: string,
): string {
  const lines: string[] = [`📋 Daily Task Reminder — ${eventName}`];

  if (overdue.length > 0) {
    lines.push('', `🔴 OVERDUE (${overdue.length}):`);
    for (const r of overdue) {
      lines.push(`  • ${r['Task ID']} | ${r['Vendor Phone']} | ${r['Description']} | due: ${r['Deadline']}`);
    }
  }

  if (dueSoon.length > 0) {
    lines.push('', `🟡 DUE WITHIN 48H (${dueSoon.length}):`);
    for (const r of dueSoon) {
      lines.push(`  • ${r['Task ID']} | ${r['Vendor Phone']} | ${r['Description']} | due: ${r['Deadline']}`);
    }
  }

  if (upcoming.length > 0) {
    lines.push('', `✅ Upcoming (${upcoming.length} task${upcoming.length === 1 ? '' : 's'} on track)`);
  }

  return lines.join('\n');
}

function buildLogRow(
  type: 'overdue' | 'due-soon',
  tasks: TaskRow[],
  runDate: string,
): string[] {
  // REMINDERS_LOG columns: Date | Task ID | Vendor Phone | Message Sent | Reminder Type
  const taskIds     = tasks.map(r => r['Task ID'] ?? '').join(', ');
  const vendorPhones = tasks.map(r => r['Vendor Phone'] ?? '').join(', ');
  const label       = type === 'overdue' ? 'OVERDUE' : 'DUE_SOON';
  const message     = `${label}: ${tasks.length} task(s) flagged`;
  return [runDate, taskIds, vendorPhones, message, label];
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const reminderFlow: Flow = {
  id: 'reminder',
  steps: [

    // Step 1: Read full TASKS sheet
    {
      id: 'read-tasks',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider:  'sheets',
        operation: 'read',
        resource:  getState(ctx).config.sheetId,
        options:   { range: 'TASKS' },
      }),
    },

    // Step 2: Send consolidated reminder to planner (only if at-risk tasks exist)
    {
      id: 'send-reminder',
      type: 'communication',
      condition: hasAtRisk,
      input: (ctx: ExecutionContext) => {
        const s = getState(ctx);
        const { overdue, dueSoon, upcoming } = classifyTasks(getRows(ctx), s.runDate);
        return {
          to:      s.config.plannerPhone,
          message: formatReminderMessage(overdue, dueSoon, upcoming, s.config.eventName),
          provider: 'meta',
        };
      },
    },

    // Step 3: Log overdue tasks to REMINDERS_LOG (only if any overdue)
    {
      id: 'log-overdue',
      type: 'storage',
      condition: (ctx: ExecutionContext) => {
        const { overdue } = classifyTasks(getRows(ctx), getState(ctx).runDate);
        return overdue.length > 0;
      },
      input: (ctx: ExecutionContext) => {
        const s = getState(ctx);
        const { overdue } = classifyTasks(getRows(ctx), s.runDate);
        return {
          provider:  'sheets',
          operation: 'write',
          resource:  s.config.reminderSheetId,
          data:      buildLogRow('overdue', overdue, s.runDate),
          options:   { range: 'REMINDERS_LOG' },
        };
      },
    },

    // Step 4: Log due-soon tasks to REMINDERS_LOG (only if any due-soon)
    {
      id: 'log-due-soon',
      type: 'storage',
      condition: (ctx: ExecutionContext) => {
        const { dueSoon } = classifyTasks(getRows(ctx), getState(ctx).runDate);
        return dueSoon.length > 0;
      },
      input: (ctx: ExecutionContext) => {
        const s = getState(ctx);
        const { dueSoon } = classifyTasks(getRows(ctx), s.runDate);
        return {
          provider:  'sheets',
          operation: 'write',
          resource:  s.config.reminderSheetId,
          data:      buildLogRow('due-soon', dueSoon, s.runDate),
          options:   { range: 'REMINDERS_LOG' },
        };
      },
    },

    // Step 5: Send all-clear message (only when no at-risk tasks)
    {
      id: 'send-all-clear',
      type: 'communication',
      condition: (ctx: ExecutionContext) => !hasAtRisk(ctx),
      input: (ctx: ExecutionContext) => ({
        to:      getState(ctx).config.plannerPhone,
        message: `✅ All tasks on track for ${getState(ctx).config.eventName} — no overdue or due-soon items today.`,
        provider: 'meta',
      }),
    },

  ],
};
