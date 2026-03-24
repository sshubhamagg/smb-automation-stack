// ============================================================
// Flow: task-complete
//
// Triggered when a vendor replies: "done EVT-xxxxx"
//
// Responsibilities:
//   - Read all tasks to find the target task + its row index
//   - Update task status → DONE, set completedAt timestamp
//   - Confirm to vendor
//   - Notify planner
//   - Handle: task not found / already closed
//
// Key pattern (from ledger-delete):
//   rowIndex for storage update = data row index (0-based) + 1
//   (accounts for the header row in the sheet)
//
// Steps:
//   1. read-tasks          — storage read
//   2. update-task         — storage update   (condition: task found + PENDING)
//   3. confirm-vendor      — communication    (condition: update ran)
//   4. notify-planner-done — communication    (condition: update ran)
//   5. send-not-found      — communication    (condition: task not found)
//   6. send-already-closed — communication    (condition: task found but not PENDING)
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { PlannerConfig } from '../src/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompleteEvent = {
  phone_number: string;   // vendor's phone (sender)
};

export type CompleteState = {
  config: PlannerConfig;
  taskId: string;
  completedAt: string;
};

// ---------------------------------------------------------------------------
// buildInitialContext
// ---------------------------------------------------------------------------

export function buildInitialContext(
  event: CompleteEvent,
  taskId: string,
  config: PlannerConfig,
): ExecutionContext {
  return {
    event,
    state: {
      config,
      taskId,
      completedAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — scan rows for task (pure, non-throwing)
// ---------------------------------------------------------------------------

function getState(ctx: ExecutionContext): CompleteState {
  return ctx.state as CompleteState;
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

export const taskCompleteFlow: Flow = {
  id: 'task-complete',
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

    // Step 2: Update task → DONE (only if found + PENDING)
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
        // Build updated row preserving all columns; update Status + Completed At
        const updatedRow = [
          row['Task ID']      ?? '',
          row['Event']        ?? '',
          row['Vendor Phone'] ?? '',
          row['Description']  ?? '',
          row['Category']     ?? '',
          row['Deadline']     ?? '',
          'DONE',
          row['Assigned At']  ?? '',
          s.completedAt,
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

    // Step 3: Confirm to vendor (only if update ran)
    {
      id: 'confirm-vendor',
      type: 'communication',
      condition: (ctx: ExecutionContext) => ctx.outputs?.['update-task'] !== undefined,
      input: (ctx: ExecutionContext) => {
        const s    = getState(ctx);
        const rows = getRows(ctx);
        const idx  = findTaskIndex(rows, s.taskId);
        const row  = rows[idx]!;
        return {
          to:      (ctx.event as CompleteEvent).phone_number,
          message: [
            `✅ Task marked as done!`,
            `Task  : ${row['Description']}`,
            `Event : ${s.config.eventName}`,
          ].join('\n'),
          provider: 'meta',
        };
      },
    },

    // Step 4: Notify planner (only if update ran)
    {
      id: 'notify-planner-done',
      type: 'communication',
      condition: (ctx: ExecutionContext) => ctx.outputs?.['update-task'] !== undefined,
      input: (ctx: ExecutionContext) => {
        const s    = getState(ctx);
        const rows = getRows(ctx);
        const idx  = findTaskIndex(rows, s.taskId);
        const row  = rows[idx]!;
        return {
          to:      s.config.plannerPhone,
          message: [
            `Task completed ✅`,
            `ID       : ${s.taskId}`,
            `Vendor   : ${row['Vendor Phone'] ?? ''}`,
            `Task     : ${row['Description'] ?? ''}`,
            `Completed: ${s.completedAt.slice(0, 16).replace('T', ' ')}`,
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
        to:      (ctx.event as CompleteEvent).phone_number,
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
          to:      (ctx.event as CompleteEvent).phone_number,
          message: `Task ${getState(ctx).taskId} is already ${status}.`,
          provider: 'meta',
        };
      },
    },

  ],
};
