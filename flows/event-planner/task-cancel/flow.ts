// ============================================================
// Flow: task-cancel
//
// Triggered when the planner sends: "cancel EVT-xxxxx"
//
// Responsibilities:
//   - Read all tasks to find the target task + its row index
//   - Update task status → CANCELLED
//   - Confirm to planner
//   - Notify vendor of cancellation
//   - Handle: task not found / already closed
//
// Key pattern (from ledger-delete):
//   rowIndex for storage update = data row index (0-based) + 1
//   (accounts for the header row in the sheet)
//
// Steps:
//   1. read-tasks          — storage read
//   2. update-task         — storage update   (condition: task found + PENDING)
//   3. confirm-planner     — communication    (condition: update ran)
//   4. notify-vendor-cancel — communication   (condition: update ran)
//   5. send-not-found      — communication    (condition: task not found)
//   6. send-already-closed — communication    (condition: task found but not PENDING)
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { PlannerConfig } from '../src/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CancelEvent = {
  phone_number: string;   // planner's phone (sender)
};

export type CancelState = {
  config: PlannerConfig;
  taskId: string;
  cancelledAt: string;
};

// ---------------------------------------------------------------------------
// buildInitialContext
// ---------------------------------------------------------------------------

export function buildInitialContext(
  event: CancelEvent,
  taskId: string,
  config: PlannerConfig,
): ExecutionContext {
  return {
    event,
    state: {
      config,
      taskId,
      cancelledAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — scan rows for task (pure, non-throwing)
// ---------------------------------------------------------------------------

function getState(ctx: ExecutionContext): CancelState {
  return ctx.state as CancelState;
}

function getRows(ctx: ExecutionContext): Record<string, string>[] {
  const out = ctx.outputs?.['read-tasks'] as { rows?: Record<string, string>[] } | undefined;
  return out?.rows ?? [];
}

function findTaskIndex(rows: Record<string, string>[], taskId: string): number {
  return rows.findIndex(r => r['Task ID'] === taskId);
}

function taskIsPending(rows: Record<string, string>[], idx: number): boolean {
  if (idx === -1) return false;
  return rows[idx]?.['Status'] === 'PENDING';
}

function taskIsFound(rows: Record<string, string>[], idx: number): boolean {
  return idx !== -1;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const taskCancelFlow: Flow = {
  id: 'task-cancel',
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

    // Step 2: Update task → CANCELLED (only if found + PENDING)
    {
      id: 'update-task',
      type: 'storage',
      condition: (ctx: ExecutionContext) => {
        const rows = getRows(ctx);
        const idx  = findTaskIndex(rows, getState(ctx).taskId);
        return taskIsPending(rows, idx);
      },
      input: (ctx: ExecutionContext) => {
        const s    = getState(ctx);
        const rows = getRows(ctx);
        const idx  = findTaskIndex(rows, s.taskId);
        const row  = rows[idx]!;
        // Build updated row preserving all columns; update Status only
        const updatedRow = [
          row['Task ID']      ?? '',
          row['Event']        ?? '',
          row['Vendor Phone'] ?? '',
          row['Description']  ?? '',
          row['Category']     ?? '',
          row['Deadline']     ?? '',
          'CANCELLED',
          row['Assigned At']  ?? '',
          row['Completed At'] ?? '',
        ];
        return {
          provider:  'sheets',
          operation: 'update',
          resource:  s.config.sheetId,
          data:      updatedRow,
          options:   { range: 'TASKS', rowIndex: idx + 1 },  // +1 for header row
        };
      },
    },

    // Step 3: Confirm to planner (only if update ran)
    {
      id: 'confirm-planner',
      type: 'communication',
      condition: (ctx: ExecutionContext) => ctx.outputs?.['update-task'] !== undefined,
      input: (ctx: ExecutionContext) => {
        const s    = getState(ctx);
        const rows = getRows(ctx);
        const idx  = findTaskIndex(rows, s.taskId);
        const row  = rows[idx]!;
        return {
          to:      (ctx.event as CancelEvent).phone_number,
          message: [
            `🚫 Task cancelled`,
            `ID     : ${s.taskId}`,
            `Vendor : ${row['Vendor Phone'] ?? ''}`,
            `Task   : ${row['Description'] ?? ''}`,
            `Event  : ${s.config.eventName}`,
          ].join('\n'),
          provider: 'meta',
        };
      },
    },

    // Step 4: Notify vendor of cancellation (only if update ran)
    {
      id: 'notify-vendor-cancel',
      type: 'communication',
      condition: (ctx: ExecutionContext) => ctx.outputs?.['update-task'] !== undefined,
      input: (ctx: ExecutionContext) => {
        const s    = getState(ctx);
        const rows = getRows(ctx);
        const idx  = findTaskIndex(rows, s.taskId);
        const row  = rows[idx]!;
        return {
          to:      row['Vendor Phone'] ?? '',
          message: [
            `Task cancelled 🚫`,
            `Task  : ${row['Description'] ?? ''}`,
            `Event : ${s.config.eventName}`,
            ``,
            `No action needed. This task has been cancelled by the planner.`,
          ].join('\n'),
          provider: 'meta',
        };
      },
    },

    // Step 5: Task not found
    {
      id: 'send-not-found',
      type: 'communication',
      condition: (ctx: ExecutionContext) => {
        const rows = getRows(ctx);
        const idx  = findTaskIndex(rows, getState(ctx).taskId);
        return !taskIsFound(rows, idx);
      },
      input: (ctx: ExecutionContext) => ({
        to:      (ctx.event as CancelEvent).phone_number,
        message: `Task ID not found: ${getState(ctx).taskId}`,
        provider: 'meta',
      }),
    },

    // Step 6: Task already closed (found but not PENDING)
    {
      id: 'send-already-closed',
      type: 'communication',
      condition: (ctx: ExecutionContext) => {
        const rows = getRows(ctx);
        const idx  = findTaskIndex(rows, getState(ctx).taskId);
        return taskIsFound(rows, idx) && !taskIsPending(rows, idx);
      },
      input: (ctx: ExecutionContext) => {
        const rows   = getRows(ctx);
        const idx    = findTaskIndex(rows, getState(ctx).taskId);
        const status = rows[idx]?.['Status'] ?? 'unknown';
        return {
          to:      (ctx.event as CancelEvent).phone_number,
          message: `Task ${getState(ctx).taskId} is already ${status}.`,
          provider: 'meta',
        };
      },
    },

  ],
};
