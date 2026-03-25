// ============================================================
// Flow: init-fees
//
// Triggered by monthly cron (1st of month, 08:00) or POST /run/fee-init
//
// Responsibilities:
//   - Read all students from STUDENTS sheet
//   - Handler iterates post-flow: writes one UNPAID fee row per ACTIVE student
//
// Engine constraint: no loop primitive — fee row writes are handled by the
// handler after runFlow() completes (same pattern as event-planner reminders).
//
// Steps:
//   1. read-students  — storage read (STUDENTS)
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { TuitionConfig } from '../src/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InitFeesEvent = {
  triggeredAt: string;   // ISO timestamp
};

export type InitFeesState = {
  config: TuitionConfig;
  month: string;         // YYYY-MM — current month
  dueDate: string;       // YYYY-MM-07 — fee due date
  runDate: string;       // YYYY-MM-DD
};

// ---------------------------------------------------------------------------
// buildInitialContext
// ---------------------------------------------------------------------------

export function buildInitialContext(
  event: InitFeesEvent,
  config: TuitionConfig,
): ExecutionContext {
  const now     = new Date(event.triggeredAt ?? new Date().toISOString());
  const year    = now.getFullYear();
  const mon     = String(now.getMonth() + 1).padStart(2, '0');
  const month   = `${year}-${mon}`;
  const dueDate = `${month}-07`;
  const runDate = now.toISOString().slice(0, 10);

  return {
    event,
    state: { config, month, dueDate, runDate },
  };
}

// ---------------------------------------------------------------------------
// Helpers (pure, non-throwing)
// ---------------------------------------------------------------------------

function getState(ctx: ExecutionContext): InitFeesState {
  return ctx.state as InitFeesState;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const initFeesFlow: Flow = {
  id: 'init-fees',
  steps: [

    // Step 1: Read full STUDENTS sheet
    // Handler iterates the result and writes one fee row per ACTIVE student
    {
      id: 'read-students',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider:  'sheets',
        operation: 'read',
        resource:  getState(ctx).config.studentsSheetId,
        options:   { range: 'STUDENTS' },
      }),
    },

  ],
};
