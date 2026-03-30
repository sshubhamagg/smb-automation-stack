import { execute as storageExecute } from 'storage-module';
import * as communication from 'communication-module';
import { runFlow } from 'engine-module';
import type { Modules } from 'engine-module';

import { buildInitialContext, miningReportFlow } from './flow';
import type { MiningReportEvent } from './flow';

// ---------------------------------------------------------------------------
// TASK 2: Exhaustive map from structured reason → user-facing message
// Adding a new reason here causes a TypeScript error until the message is defined.
// ---------------------------------------------------------------------------

const FAILURE_MESSAGES: Record<'manager_not_found' | 'invalid_format' | 'unauthorized_mine', string> = {
  manager_not_found: '❌ You are not authorized to submit reports.',
  invalid_format:    '❌ Invalid report format. Please follow the template.',
  unauthorized_mine: '❌ Mine name does not match your assigned mines.',
};

// Modules wired at handler level — engine has no knowledge of concrete module implementations
const modules: Modules = {
  storage: (input) => storageExecute(input as Parameters<typeof storageExecute>[0]),
  communication: (input) => communication.execute(input as { to: string; message: string }),
};

// ---------------------------------------------------------------------------
// handleMiningReport
//
// Single entry point for an incoming mining report event.
//
// Guarantees (TASK 5):
//   - Every failure path sends a WhatsApp response before returning
//   - No early return without a response to the manager
//
// TASK 3 — defensive communication:
//   The engine's stepExecutor already wraps every communication call in
//   try/catch and uses `res ?? null` for undefined returns. No changes to
//   the engine are needed. The sendMessage() calls in this file are also
//   individually guarded with .catch() so a delivery failure cannot crash
//   the handler.
// ---------------------------------------------------------------------------

export async function handleMiningReport(event: MiningReportEvent): Promise<void> {
  // --- Pre-flow validation (buildInitialContext = steps 1-3) ---------------

  const ctxResult = buildInitialContext(event);

  if (!ctxResult.ok) {
    // TASK 1: Always respond on validation failure
    const msg = FAILURE_MESSAGES[ctxResult.reason];
    await communication.execute({ to: event.userId, message: msg }).catch((err: unknown) => {
      console.error('Failed to send error response:', err instanceof Error ? err.message : err);
    });
    return;
  }

  // --- Execute I/O flow (steps 4-5: store + reply-manager) ------------------

  const result = await runFlow(miningReportFlow, ctxResult.context, modules);

  // TASK 4: Debug logging
  console.log('FLOW RESULT:', JSON.stringify(result, null, 2));

  // TASK 5: Flow-level failure — still send a response so no silent failures
  if (!result.ok) {
    await communication.execute({
      to: event.userId,
      message: '❌ Failed to process your report. Please try again.',
    }).catch((err: unknown) => {
      console.error('Failed to send flow-error response:', err instanceof Error ? err.message : err);
    });
    return;
  }

  // --- Notify owner after 30-second delay (step 6) --------------------------

  const parsed = ctxResult.context.state?.['parsed'];
  const config = ctxResult.context.state?.['config'];

  setTimeout(() => {
    communication.execute({
      to: config?.ownerPhone,
      message:
        `📊 Report from ${parsed?.mine}\n` +
        `Labor: ${parsed?.labor}\n` +
        `Machine A: ${parsed?.machineA}h | ` +
        `Machine B: ${parsed?.machineB}h\n` +
        `Output: ${parsed?.output} tons\n` +
        `Material: ${parsed?.material}`,
    }).catch((err: unknown) => {
      console.error('Failed to send owner notification:', err instanceof Error ? err.message : err);
    });
  }, 30_000);
}
