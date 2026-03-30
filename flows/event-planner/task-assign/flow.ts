// ============================================================
// Flow: task-assign
//
// Responsibilities:
//   - Write new task row to TASKS sheet
//   - Send assignment confirmation to planner
//   - Send task notification to vendor
//
// buildInitialContext():
//   - Generates unique task ID
//   - Resolves deadline (parsed deadline or eventDate fallback)
//   - Assembles the full task row array
//
// Steps:
//   1. write-task      — storage write  (always)
//   2. notify-planner  — communication  (condition: write succeeded)
//   3. notify-vendor   — communication  (condition: write succeeded)
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { PlannerConfig, ParsedIntent, TASK_COLS } from '../src/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssignEvent = {
  phone_number: string;  // planner's phone (sender)
};

export type AssignState = {
  config: PlannerConfig;
  parsed: Required<Pick<ParsedIntent, 'vendorPhone' | 'taskDescription'>> & {
    category: string;
    deadline: string;
  };
  taskId: string;
  taskRow: string[];
  assignedAt: string;
};

// ---------------------------------------------------------------------------
// buildInitialContext — generate taskId + assemble row (pure)
// ---------------------------------------------------------------------------

export function buildInitialContext(
  event: AssignEvent,
  parsed: ParsedIntent,
  config: PlannerConfig,
): ExecutionContext {
  const taskId     = `EVT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const assignedAt = new Date().toISOString();
  const deadline   = parsed.deadline ?? config.eventDate;
  const category   = parsed.category ?? 'General';

  // Row order must match TASKS sheet header:
  // Task ID | Event | Vendor Phone | Description | Category | Deadline | Status | Assigned At | Completed At
  const taskRow = [
    taskId,
    config.eventName,
    parsed.vendorPhone ?? '',
    parsed.taskDescription ?? '',
    category,
    deadline,
    'PENDING',
    assignedAt,
    '',
  ];

  return {
    event,
    state: {
      config,
      parsed: {
        vendorPhone:     parsed.vendorPhone ?? '',
        taskDescription: parsed.taskDescription ?? '',
        category,
        deadline,
      },
      taskId,
      taskRow,
      assignedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers (pure, non-throwing)
// ---------------------------------------------------------------------------

function getState(ctx: ExecutionContext): AssignState {
  return ctx.state as AssignState;
}

function writeSucceeded(ctx: ExecutionContext): boolean {
  return ctx.outputs?.['write-task'] !== undefined;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const taskAssignFlow: Flow = {
  id: 'task-assign',
  steps: [

    // Step 1: Write task row to TASKS sheet
    {
      id: 'write-task',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider:  'sheets',
        operation: 'write',
        resource:  getState(ctx).config.sheetId,
        data:      getState(ctx).taskRow,
        options:   { range: 'TASKS' },
      }),
    },

    // Step 2: Confirm to planner
    {
      id: 'notify-planner',
      type: 'communication',
      condition: writeSucceeded,
      input: (ctx: ExecutionContext) => {
        const s = getState(ctx);
        return {
          to:      s.config.plannerPhone,
          message: [
            '✅ Task assigned',
            `ID       : ${s.taskId}`,
            `Vendor   : ${s.parsed.vendorPhone}`,
            `Task     : ${s.parsed.taskDescription}`,
            `Category : ${s.parsed.category}`,
            `Deadline : ${s.parsed.deadline}`,
            `Event    : ${s.config.eventName}`,
          ].join('\n'),
          provider: 'meta',
        };
      },
    },

    // Step 3: Notify vendor of new task
    {
      id: 'notify-vendor',
      type: 'communication',
      condition: writeSucceeded,
      input: (ctx: ExecutionContext) => {
        const s = getState(ctx);
        return {
          to:      s.parsed.vendorPhone,
          message: [
            `Hi! You have a new task for ${s.config.eventName}:`,
            `Task     : ${s.parsed.taskDescription}`,
            `Category : ${s.parsed.category}`,
            `Deadline : ${s.parsed.deadline}`,
            ``,
            `Reply "done ${s.taskId}" when complete.`,
          ].join('\n'),
          provider: 'meta',
        };
      },
    },

  ],
};
