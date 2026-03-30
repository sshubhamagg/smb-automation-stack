import { execute as storageExecute } from 'storage-module';
import * as communication from 'communication-module';
import { run as intelligenceRun } from 'intelligence-module';
import { runFlow } from 'engine-module';
import type { Modules } from 'engine-module';

import {
  buildInitialContext as buildRouterCtx,
  intentRouterFlow,
  resolveRouting,
} from '../../../flows/event-planner/intent-router/flow';
import {
  buildInitialContext as buildAssignCtx,
  taskAssignFlow,
} from '../../../flows/event-planner/task-assign/flow';
import {
  buildInitialContext as buildStatusCtx,
  taskStatusFlow,
} from '../../../flows/event-planner/task-status/flow';
import {
  buildInitialContext as buildCompleteCtx,
  taskCompleteFlow,
} from '../../../flows/event-planner/task-complete/flow';
import {
  buildInitialContext as buildCancelCtx,
  taskCancelFlow,
} from '../../../flows/event-planner/task-cancel/flow';
import {
  buildInitialContext as buildReminderCtx,
  reminderFlow,
} from '../../../flows/event-planner/reminder/flow';

import type { PlannerConfig, IncomingMessage } from '../../../flows/event-planner/src/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig(): PlannerConfig {
  const sheetId         = process.env['PLANNER_SHEET_ID'];
  const reminderSheetId = process.env['PLANNER_REMINDER_SHEET_ID'];
  const plannerPhone    = process.env['PLANNER_PHONE'];
  const eventName       = process.env['PLANNER_EVENT_NAME'];
  const eventDate       = process.env['PLANNER_EVENT_DATE'];

  if (!sheetId || !reminderSheetId || !plannerPhone || !eventName || !eventDate) {
    throw new Error(
      'Missing required env vars: PLANNER_SHEET_ID, PLANNER_REMINDER_SHEET_ID, ' +
      'PLANNER_PHONE, PLANNER_EVENT_NAME, PLANNER_EVENT_DATE',
    );
  }

  return {
    sheetId,
    reminderSheetId,
    plannerPhone,
    eventName,
    eventDate,
    mode:       (process.env['PLANNER_MODE']        ?? 'structured') as 'structured' | 'ai',
    aiProvider: (process.env['PLANNER_AI_PROVIDER'] ?? 'anthropic')  as 'openai' | 'anthropic' | 'local' | 'nvidia',
  };
}

// ---------------------------------------------------------------------------
// Modules wiring
// ---------------------------------------------------------------------------

const modules: Modules = {
  storage:       (input: unknown) => storageExecute(input as Parameters<typeof storageExecute>[0]),
  communication: (input: unknown) => communication.execute(input as { to: string; message: string }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intelligence:  (input: unknown) => intelligenceRun(input as any),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function send(to: string, message: string): Promise<void> {
  await communication.execute({ to, message }).catch((err: unknown) => {
    console.error('[event-planner] send failed:', err instanceof Error ? err.message : err);
  });
}

// ---------------------------------------------------------------------------
// handlePlannerMessage — inbound WhatsApp dispatch
// ---------------------------------------------------------------------------

export async function handlePlannerMessage(msg: IncomingMessage): Promise<void> {
  const phone = msg.phone_number;
  const text  = msg.text_body?.trim() ?? '';

  let config: PlannerConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('[event-planner] Config error:', err instanceof Error ? err.message : err);
    await send(phone, 'Service misconfigured. Please contact support.');
    return;
  }

  // ── Step 1: Intent router ────────────────────────────────────────────────
  const routerCtx    = buildRouterCtx({ message: text, user: phone }, config);
  const routerResult = await runFlow(intentRouterFlow, routerCtx, modules);

  if (!routerResult.ok) {
    console.error('[event-planner] router failed:', routerResult.error);
    await send(phone, 'Could not process your request. Please try again.');
    return;
  }

  // ── Step 2: Resolve routing ──────────────────────────────────────────────
  const routing = resolveRouting(routerResult.context);

  if (!routing) {
    // send-invalid already fired for unrecognised structured commands.
    // AI mode: extraction failed — nudge the user.
    if (config.mode === 'ai') {
      await send(phone, 'Could not extract intent. Try: assign +1234567890 arrange flowers by 2026-05-01');
    }
    return;
  }

  const { nextFlow, parsed } = routing;
  console.log(`[event-planner] → ${nextFlow} (${phone})`);

  // ── Step 3: Dispatch to sub-flow ─────────────────────────────────────────

  if (nextFlow === 'task-assign') {
    const ctx    = buildAssignCtx({ phone_number: phone }, parsed, config);
    const result = await runFlow(taskAssignFlow, ctx, modules);
    if (!result.ok) {
      console.error('[task-assign] failed:', result.error);
      await send(phone, 'Failed to assign task. Please try again.');
    }
    return;
  }

  if (nextFlow === 'task-status') {
    const ctx    = buildStatusCtx({ phone_number: phone }, config, parsed.vendorPhone);
    const result = await runFlow(taskStatusFlow, ctx, modules);
    if (!result.ok) console.error('[task-status] failed:', result.error);
    return;
  }

  if (nextFlow === 'task-complete') {
    const taskId = parsed.taskId ?? '';
    if (!taskId) { await send(phone, 'Task ID missing. Use: done EVT-xxxxx'); return; }
    const ctx    = buildCompleteCtx({ phone_number: phone }, taskId, config);
    const result = await runFlow(taskCompleteFlow, ctx, modules);
    if (!result.ok) console.error('[task-complete] failed:', result.error);
    return;
  }

  if (nextFlow === 'task-cancel') {
    const taskId = parsed.taskId ?? '';
    if (!taskId) { await send(phone, 'Task ID missing. Use: cancel EVT-xxxxx'); return; }
    const ctx    = buildCancelCtx({ phone_number: phone }, taskId, config);
    const result = await runFlow(taskCancelFlow, ctx, modules);
    if (!result.ok) console.error('[task-cancel] failed:', result.error);
    return;
  }

  console.error('[event-planner] Unhandled nextFlow:', nextFlow);
}

// ---------------------------------------------------------------------------
// handleReminders — triggered by cron or POST /run/reminders
// ---------------------------------------------------------------------------

export async function handleReminders(): Promise<void> {
  let config: PlannerConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('[event-planner] Reminders config error:', err instanceof Error ? err.message : err);
    return;
  }

  const triggeredAt = new Date().toISOString();
  const ctx         = buildReminderCtx({ triggeredAt }, config);
  const result      = await runFlow(reminderFlow, ctx, modules);

  if (!result.ok) {
    console.error('[event-planner] Reminders flow failed:', result.error);
  } else {
    console.log('[event-planner] Reminders dispatched at', triggeredAt);
  }
}
