// ============================================================
// Flow: task-status
//
// Responsibilities:
//   - Read all tasks from TASKS sheet
//   - Filter by Status = PENDING (and optionally by vendor phone)
//   - Format and send status summary to planner
//
// Steps:
//   1. read-tasks   — storage read
//   2. send-status  — communication (filtering + formatting in input())
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type { PlannerConfig } from '../src/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StatusEvent = {
  phone_number: string;  // planner's phone
};

export type StatusState = {
  config: PlannerConfig;
  filter: {
    vendorPhone?: string;  // if set, show only this vendor's tasks
  };
};

// ---------------------------------------------------------------------------
// buildInitialContext
// ---------------------------------------------------------------------------

export function buildInitialContext(
  event: StatusEvent,
  config: PlannerConfig,
  vendorPhone?: string,
): ExecutionContext {
  return {
    event,
    state: {
      config,
      filter: { vendorPhone },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers (pure, non-throwing)
// ---------------------------------------------------------------------------

function getState(ctx: ExecutionContext): StatusState {
  return ctx.state as StatusState;
}

function formatStatusMessage(
  rows: Record<string, string>[],
  vendorFilter?: string,
): string {
  // Filter to PENDING only, then optionally by vendor
  const pending = rows.filter(r => {
    if (r['Status'] !== 'PENDING') return false;
    if (vendorFilter && r['Vendor Phone'] !== vendorFilter) return false;
    return true;
  });

  if (pending.length === 0) {
    return vendorFilter
      ? `No pending tasks for ${vendorFilter} 🎉`
      : 'No pending tasks 🎉';
  }

  // Sort by deadline ascending
  const sorted = [...pending].sort((a, b) => {
    const da = new Date(a['Deadline'] ?? '').getTime();
    const db = new Date(b['Deadline'] ?? '').getTime();
    return (isNaN(da) ? Infinity : da) - (isNaN(db) ? Infinity : db);
  });

  const header = vendorFilter
    ? `Pending tasks for ${vendorFilter} (${sorted.length}):`
    : `Pending tasks (${sorted.length}):`;

  const lines = sorted.map((r, i) =>
    `${i + 1}. ${r['Task ID']} | ${r['Vendor Phone']} | ${r['Description']} | due: ${r['Deadline']}`,
  );

  return [header, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const taskStatusFlow: Flow = {
  id: 'task-status',
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

    // Step 2: Format + send summary to planner
    {
      id: 'send-status',
      type: 'communication',
      input: (ctx: ExecutionContext) => {
        const s      = getState(ctx);
        const output = ctx.outputs?.['read-tasks'] as { rows?: Record<string, string>[] } | undefined;
        const rows   = output?.rows ?? [];
        const msg    = formatStatusMessage(rows, s.filter.vendorPhone);
        return {
          to:      s.config.plannerPhone,
          message: msg,
          provider: 'meta',
        };
      },
    },

  ],
};
